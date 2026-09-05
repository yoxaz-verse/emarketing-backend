import { hashPassword, verifyPassword } from "../../utils/password";
import { createSmtpTransport, getSniCandidates } from "../email/smtpTransport";
import crypto from "crypto";

const GENERIC_RESET_MESSAGE = 'Verification code sent if account exists.';

export class PasswordResetEmailServiceError extends Error {
    constructor(message = 'Reset email service unavailable') {
        super(message);
        this.name = 'PasswordResetEmailServiceError';
    }
}

type PasswordResetSmtpConfig = {
    provider?: string | null;
    host: string;
    port: number;
    username: string;
    password: string;
    encryption?: string | null;
    fromName: string;
    fromEmail: string;
};

type PasswordResetDeps = {
    db: any;
    env?: NodeJS.ProcessEnv;
    hashPasswordFn?: typeof hashPassword;
    generateOtpFn?: () => string;
    createTransportFn?: typeof createSmtpTransport;
    logger?: Pick<typeof console, 'error' | 'warn' | 'info'>;
};

/**
 * Generate a 6-digit numeric OTP
 */
function generateOTP() {
    return crypto.randomInt(100000, 1000000).toString();
}

function normalizeEmail(email: string) {
    return String(email ?? '').trim().toLowerCase();
}

function hashResetGrant(value: string) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

async function getSupabaseClient() {
    const mod = await import("../../supabase.js");
    return mod.supabase;
}

async function getSupabaseAdminClient() {
    const mod = await import("../../utils/supabaseAdmin.js");
    return mod.supabaseAdmin;
}

function requireEnvValue(env: NodeJS.ProcessEnv, name: string): string {
    const value = String(env[name] ?? '').trim();
    if (!value) throw new PasswordResetEmailServiceError(`Missing ${name}`);
    return value;
}

function getPasswordResetSmtpConfig(env: NodeJS.ProcessEnv = process.env): PasswordResetSmtpConfig {
    const host = requireEnvValue(env, 'PASSWORD_RESET_SMTP_HOST');
    const portRaw = requireEnvValue(env, 'PASSWORD_RESET_SMTP_PORT');
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new PasswordResetEmailServiceError('Invalid PASSWORD_RESET_SMTP_PORT');
    }

    const username = requireEnvValue(env, 'PASSWORD_RESET_SMTP_USERNAME');
    const password = requireEnvValue(env, 'PASSWORD_RESET_SMTP_PASSWORD');
    const encryption = requireEnvValue(env, 'PASSWORD_RESET_SMTP_ENCRYPTION').toLowerCase();
    if (encryption !== 'ssl' && encryption !== 'tls') {
        throw new PasswordResetEmailServiceError('Invalid PASSWORD_RESET_SMTP_ENCRYPTION');
    }

    return {
        provider: String(env.PASSWORD_RESET_SMTP_PROVIDER ?? '').trim() || null,
        host,
        port,
        username,
        password,
        encryption,
        fromName: String(env.PASSWORD_RESET_FROM_NAME ?? '').trim() || 'OBAOL Security',
        fromEmail: String(env.PASSWORD_RESET_FROM_EMAIL ?? '').trim() || username,
    };
}

function isTlsHostnameMismatch(error: any): boolean {
    const message = String(error?.message ?? '').toLowerCase();
    const code = String(error?.code ?? '').toUpperCase();
    return (
        code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
        message.includes("does not match certificate's altnames") ||
        message.includes('hostname/ip does not match certificate') ||
        message.includes('altname')
    );
}

async function sendPasswordResetEmail(input: {
    email: string;
    otp: string;
    smtp: PasswordResetSmtpConfig;
    createTransportFn: typeof createSmtpTransport;
    logger: Pick<typeof console, 'warn'>;
}) {
    const candidates = getSniCandidates(input.smtp);
    const errors: any[] = [];
    const mail = {
        from: `"${input.smtp.fromName}" <${input.smtp.fromEmail}>`,
        to: input.email,
        subject: 'Your Password Reset Verification Code',
        html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 12px; border: 1px solid #e5e7eb;">
                    <h2 style="color: #111827; font-size: 24px; font-weight: 600;">Reset Your Password</h2>
                    <p style="color: #4b5563; line-height: 1.5;">You requested to reset your password for your OBAOL account. Use the code below to proceed:</p>
                    <div style="background: #f9fafb; padding: 24px; text-align: center; font-size: 32px; font-weight: 800; letter-spacing: 0.2em; color: #111827; border-radius: 8px; margin: 24px 0; border: 1px solid #f3f4f6;">
                        ${input.otp}
                    </div>
                    <p style="color: #6b7280; font-size: 14px;">This code expires in 10 minutes. If you did not request a password reset, you can safely ignore this email.</p>
                    <hr style="border: none; border-top: 1px solid #f3f4f6; margin: 24px 0;" />
                    <p style="color: #9ca3af; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} OBAOL · OUTBOUND INFRASTRUCTURE</p>
                </div>
            `,
    };

    for (let index = 0; index < candidates.length; index += 1) {
        const servername = candidates[index];
        try {
            const transporter = input.createTransportFn(input.smtp, servername);
            await transporter.sendMail(mail);
            if (index > 0) {
                input.logger.warn('[PASSWORD_RESET_SMTP_SNI_FALLBACK_USED]', {
                    host: input.smtp.host,
                    provider: input.smtp.provider,
                    servername,
                });
            }
            return;
        } catch (err: any) {
            errors.push(err);
            const shouldTryFallback =
                index === 0 &&
                String(input.smtp.provider ?? '').trim().toLowerCase() === 'mxroute' &&
                isTlsHostnameMismatch(err);
            if (!shouldTryFallback) break;
        }
    }

    throw new PasswordResetEmailServiceError(errors[0]?.message ?? 'Reset email delivery failed');
}

/**
 * 1. Request Password Reset
 * - Validates user exists
 * - Generates 6-digit OTP
 * - Hashes OTP and sets expiry (10 min)
 * - Sends email to user
 */
export async function requestPasswordResetWithDeps(email: string, deps: PasswordResetDeps) {
    email = normalizeEmail(email);
    const db = deps.db;
    const logger = deps.logger ?? console;
    const hashPasswordFn = deps.hashPasswordFn ?? hashPassword;
    const createTransportFn = deps.createTransportFn ?? createSmtpTransport;

    // 1. Check if user exists
    const { data: user } = await db
        .from('users')
        .select('id')
        .eq('email', email)
        .single();

    if (!user) {
        // Return generic success to prevent email enumeration
        return { success: true, message: GENERIC_RESET_MESSAGE };
    }

    const smtpConfig = getPasswordResetSmtpConfig(deps.env ?? process.env);

    // 2. Generate OTP
    const otpValue = deps.generateOtpFn ? deps.generateOtpFn() : generateOTP();
    const otpHash = await hashPasswordFn(otpValue);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // 3. Send email before storing the OTP so users never receive a success state for an unusable code.
    await sendPasswordResetEmail({
        email,
        otp: otpValue,
        smtp: smtpConfig,
        createTransportFn,
        logger,
    });

    // 4. Store in DB
    await db.from('password_reset_tokens').delete().eq('email', email);
    const { error } = await db.from('password_reset_tokens').insert({
        email,
        otp_hash: otpHash,
        expires_at: expiresAt.toISOString(),
        verified: false,
        attempt_count: 0,
        reset_token_hash: null,
        consumed_at: null,
    });

    if (error) throw error;

    return { success: true, message: GENERIC_RESET_MESSAGE };
}

export async function requestPasswordReset(email: string) {
    return requestPasswordResetWithDeps(email, { db: await getSupabaseClient() });
}

/**
 * 2. Verify OTP
 * - Checks for valid, unverified OTP for email
 * - Validates OTP hash
 * - Marks token as verified if match
 */
export async function verifyResetOTP(email: string, otp: string) {
    email = normalizeEmail(email);
    if (!/^\d{6}$/.test(String(otp ?? ''))) throw new Error('Invalid verification code');
    const db = await getSupabaseClient();
    const { data: tokens, error } = await db
        .from('password_reset_tokens')
        .select('id,email,otp_hash,expires_at,verified,attempt_count')
        .eq('email', email)
        .eq('verified', false)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });

    if (error || !tokens || tokens.length === 0) {
        throw new Error('Invalid or expired verification code');
    }

    const candidate = tokens[0];
    const attempts = Number(candidate.attempt_count ?? 0);
    if (attempts >= 5) throw new Error('Too many attempts. Request a new verification code.');
    const isMatch = await verifyPassword(otp, candidate.otp_hash);

    if (!isMatch) {
        await db.from('password_reset_tokens').update({ attempt_count: attempts + 1 }).eq('id', candidate.id);
        throw new Error('Invalid verification code');
    }

    const resetToken = crypto.randomBytes(32).toString('base64url');
    await db
        .from('password_reset_tokens')
        .update({ verified: true, reset_token_hash: hashResetGrant(resetToken), verified_at: new Date().toISOString() })
        .eq('id', candidate.id);

    return { success: true, reset_token: resetToken };
}

/**
 * 3. Reset Password
 * - Validates a verified token exists for email
 * - Updates Supabase Auth + local DB password hash
 * - Cleans up tokens
 */
export async function resetPassword(email: string, newPassword: string, resetToken: string) {
    email = normalizeEmail(email);
    if (newPassword.length < 12) throw new Error('Password must be at least 12 characters');
    if (!resetToken) throw new Error('Reset authorization is required');
    const db = await getSupabaseClient();
    const admin = await getSupabaseAdminClient();
    // 1. Verify verified token exists
    const { data: token, error } = await db
        .from('password_reset_tokens')
        .select('id,email,expires_at,reset_token_hash,consumed_at')
        .eq('email', email)
        .eq('verified', true)
        .eq('reset_token_hash', hashResetGrant(resetToken))
        .is('consumed_at', null)
        .gt('expires_at', new Date().toISOString())
        .single();

    if (error || !token) {
        throw new Error('Verification required or session expired');
    }

    // 2. Resolve User
    const { data: user } = await db
        .from('users')
        .select('id, auth_user_id')
        .eq('email', email)
        .single();

    if (!user || !user.auth_user_id) {
        throw new Error('User not found');
    }

    // 3. Consume the grant before changing credentials so concurrent replays lose.
    const { data: consumed, error: consumeError } = await db
        .from('password_reset_tokens')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', token.id)
        .is('consumed_at', null)
        .select('id')
        .maybeSingle();
    if (consumeError || !consumed) throw new Error('Reset authorization has already been used');

    // 4. Update Supabase Auth password
    const { error: authError } = await admin.auth.admin.updateUserById(user.auth_user_id, {
        password: newPassword
    });

    if (authError) throw authError;

    // 5. Update local password hash for sync
    const password_hash = await hashPassword(newPassword);
    await db
        .from('users')
        .update({ password_hash })
        .eq('id', user.id);

    await db.from('password_reset_tokens').delete().eq('email', email).neq('id', token.id);

    return { success: true };
}
