import { supabase } from "../../supabase";
import { supabaseAdmin } from "../../utils/supabaseAdmin";
import { hashPassword, verifyPassword } from "../../utils/password";
import { decryptSecret } from "../../utils/sendEncryption";
import { createSmtpTransport } from "../email/smtpTransport";
import crypto from "crypto";

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

/**
 * 1. Request Password Reset
 * - Validates user exists
 * - Generates 6-digit OTP
 * - Hashes OTP and sets expiry (10 min)
 * - Sends email to user
 */
export async function requestPasswordReset(email: string) {
    email = normalizeEmail(email);
    // 1. Check if user exists
    const { data: user } = await supabase
        .from('users')
        .select('id')
        .eq('email', email)
        .single();

    if (!user) {
        // Return generic success to prevent email enumeration
        return { success: true, message: 'Verification code sent if account exists.' };
    }

    // 2. Generate OTP
    const otp = generateOTP();
    const otpHash = await hashPassword(otp);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // 3. Store in DB
    await supabase.from('password_reset_tokens').delete().eq('email', email);
    const { error } = await supabase.from('password_reset_tokens').insert({
        email,
        otp_hash: otpHash,
        expires_at: expiresAt.toISOString(),
        verified: false,
        attempt_count: 0,
        reset_token_hash: null,
        consumed_at: null,
    });

    if (error) throw error;

    // 4. Send Email via existing SMTP infrastructure
    const { data: smtp } = await supabase
        .from('smtp_accounts')
        .select('*')
        .eq('is_valid', true)
        .limit(1)
        .single();

    if (!smtp) {
        console.error('[AUTH ERROR] No valid SMTP account found for password reset emails');
        return { success: true, message: 'Verification code sent if account exists.' };
    }

    try {
        const transporter = createSmtpTransport({
            provider: smtp.provider,
            host: smtp.host,
            port: smtp.port,
            username: smtp.username,
            password: decryptSecret(smtp.password),
            encryption: smtp.encryption,
        });

        await transporter.sendMail({
            from: `"OBAOL Security" <${smtp.username}>`,
            to: email,
            subject: 'Your Password Reset Verification Code',
            html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 12px; border: 1px solid #e5e7eb;">
                    <h2 style="color: #111827; font-size: 24px; font-weight: 600;">Reset Your Password</h2>
                    <p style="color: #4b5563; line-height: 1.5;">You requested to reset your password for your OBAOL account. Use the code below to proceed:</p>
                    <div style="background: #f9fafb; padding: 24px; text-align: center; font-size: 32px; font-weight: 800; letter-spacing: 0.2em; color: #111827; border-radius: 8px; margin: 24px 0; border: 1px solid #f3f4f6;">
                        ${otp}
                    </div>
                    <p style="color: #6b7280; font-size: 14px;">This code expires in 10 minutes. If you did not request a password reset, you can safely ignore this email.</p>
                    <hr style="border: none; border-top: 1px solid #f3f4f6; margin: 24px 0;" />
                    <p style="color: #9ca3af; font-size: 12px; text-align: center;">© ${new Date().getFullYear()} OBAOL · OUTBOUND INFRASTRUCTURE</p>
                </div>
            `
        });
    } catch (mailError) {
        console.error('[AUTH ERROR] Failed to send password reset email:', mailError);
    }

    return { success: true, message: 'Verification code sent if account exists.' };
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
    const { data: tokens, error } = await supabase
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
        await supabase.from('password_reset_tokens').update({ attempt_count: attempts + 1 }).eq('id', candidate.id);
        throw new Error('Invalid verification code');
    }

    const resetToken = crypto.randomBytes(32).toString('base64url');
    await supabase
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
    // 1. Verify verified token exists
    const { data: token, error } = await supabase
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
    const { data: user } = await supabase
        .from('users')
        .select('id, auth_user_id')
        .eq('email', email)
        .single();

    if (!user || !user.auth_user_id) {
        throw new Error('User not found');
    }

    // 3. Consume the grant before changing credentials so concurrent replays lose.
    const { data: consumed, error: consumeError } = await supabase
        .from('password_reset_tokens')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', token.id)
        .is('consumed_at', null)
        .select('id')
        .maybeSingle();
    if (consumeError || !consumed) throw new Error('Reset authorization has already been used');

    // 4. Update Supabase Auth password
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(user.auth_user_id, {
        password: newPassword
    });

    if (authError) throw authError;

    // 5. Update local password hash for sync
    const password_hash = await hashPassword(newPassword);
    await supabase
        .from('users')
        .update({ password_hash })
        .eq('id', user.id);

    await supabase.from('password_reset_tokens').delete().eq('email', email).neq('id', token.id);

    return { success: true };
}
