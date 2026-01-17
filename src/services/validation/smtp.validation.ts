// services/smtpValidation.ts

import nodemailer from 'nodemailer';
import { supabase } from '../../supabase';
import { decryptSecret } from '../../utils/sendEncryption';

export async function validateSmtpAccount(smtpAccountId: string) {
  /**
   * 1. Fetch SMTP account
   */
  const { data: smtp, error } = await supabase
    .from('smtp_accounts')
    .select(`
      id,
      host,
      port,
      username,
      password,
      encryption
    `)
    .eq('id', smtpAccountId)
    .single();

  if (error || !smtp) {
    throw new Error('SMTP account not found');
  }

  /**
   * 2. Decrypt password
   */
  const password = decryptSecret(smtp.password);

  /**
   * 3. Verify SMTP connection
   */
  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.encryption === 'ssl',
      auth: {
        user: smtp.username,
        pass: password,
      },
    });

    await transporter.verify();

    /**
     * 4. Mark as valid
     */
    await supabase
      .from('smtp_accounts')
      .update({
        is_valid: true,
        error_message: null,
        last_checked_at: new Date().toISOString(),
      })
      .eq('id', smtpAccountId);

  } catch (err: any) {
    /**
     * 5. Mark as invalid
     */
    await supabase
      .from('smtp_accounts')
      .update({
        is_valid: false,
        error_message: err.message || 'SMTP verification failed',
        last_checked_at: new Date().toISOString(),
      })
      .eq('id', smtpAccountId);

    throw new Error(`SMTP validation failed: ${err.message}`);
  }
}
