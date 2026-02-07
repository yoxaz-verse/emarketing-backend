import { supabase } from "../../supabase";
import { supabaseAdmin } from "../../utils/supabaseAdmin";
import { hashPassword, verifyPassword } from "../../utils/password";
import { decryptSecret } from "../../utils/sendEncryption";
import nodemailer from 'nodemailer';

/**
 * Generate a 6-digit numeric OTP
 */
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * 1. Request Password Reset
 * - Validates user exists
 * - Generates 6-digit OTP
 * - Hashes OTP and sets expiry (10 min)
 * - Sends email to user
 */
export async function requestPasswordReset(email: string) {
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
    const { error } = await supabase.from('password_reset_tokens').insert({
        email,
        otp_hash: otpHash,
        expires_at: expiresAt.toISOString()
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
        const transporter = nodemailer.createTransport({
            host: smtp.host,
            port: smtp.port,
            secure: smtp.port === 465,
            auth: {
                user: smtp.username,
                pass: decryptSecret(smtp.password),
            },
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
    const { data: tokens, error } = await supabase
        .from('password_reset_tokens')
        .select('*')
        .eq('email', email)
        .eq('verified', false)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });

    if (error || !tokens || tokens.length === 0) {
        throw new Error('Invalid or expired verification code');
    }

    // Verify hashed OTP
    let matchedToken = null;
    for (const token of tokens) {
        const isMatch = await verifyPassword(otp, token.otp_hash);
        if (isMatch) {
            matchedToken = token;
            break;
        }
    }

    if (!matchedToken) {
        throw new Error('Invalid verification code');
    }

    // Mark as verified
    await supabase
        .from('password_reset_tokens')
        .update({ verified: true })
        .eq('id', matchedToken.id);

    return { success: true };
}

/**
 * 3. Reset Password
 * - Validates a verified token exists for email
 * - Updates Supabase Auth + local DB password hash
 * - Cleans up tokens
 */
export async function resetPassword(email: string, newPassword: string) {
    // 1. Verify verified token exists
    const { data: token, error } = await supabase
        .from('password_reset_tokens')
        .select('*')
        .eq('email', email)
        .eq('verified', true)
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

    // 3. Update Supabase Auth password
    const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(user.auth_user_id, {
        password: newPassword
    });

    if (authError) throw authError;

    // 4. Update local password hash for sync
    const password_hash = await hashPassword(newPassword);
    await supabase
        .from('users')
        .update({ password_hash })
        .eq('id', user.id);

    // 5. Cleanup tokens
    await supabase
        .from('password_reset_tokens')
        .delete()
        .eq('email', email);

    return { success: true };
}
