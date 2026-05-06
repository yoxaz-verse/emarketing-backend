// services/smtpValidation.ts

import { supabase } from '../../supabase';
import { decryptSecret } from '../../utils/sendEncryption';
import { createSmtpTransport, formatSmtpValidationError, getSniCandidates } from '../email/smtpTransport';

type SmtpFailureKind = 'auth' | 'connection' | 'tls' | 'generic';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'SMTP verification failed');
}

function classifySmtpError(error: any): SmtpFailureKind {
  const message = getErrorMessage(error).toLowerCase();
  const code = String(error?.code ?? '').toUpperCase();
  const responseCode = String(error?.responseCode ?? '');

  if (
    code === 'EAUTH' ||
    responseCode === '535' ||
    message.includes('invalid login') ||
    message.includes('auth')
  ) {
    return 'auth';
  }

  if (
    code === 'ECONNECTION' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'EDNS' ||
    code === 'ESOCKET' ||
    message.includes('timed out') ||
    message.includes('timeout') ||
    message.includes('getaddrinfo') ||
    message.includes('name or service not known') ||
    message.includes('connection refused')
  ) {
    return 'connection';
  }

  if (
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    message.includes("does not match certificate's altnames") ||
    message.includes('hostname/ip does not match certificate') ||
    message.includes('altname')
  ) {
    return 'tls';
  }

  return 'generic';
}

function pickRootCauseError(errors: any[]): any {
  if (!errors.length) return new Error('SMTP verification failed');

  const priority: SmtpFailureKind[] = ['auth', 'connection', 'tls', 'generic'];

  for (const kind of priority) {
    const found = errors.find((entry) => classifySmtpError(entry?.error) === kind);
    if (found?.error) return found.error;
  }

  return errors[errors.length - 1]?.error ?? new Error('SMTP verification failed');
}

export async function validateSmtpAccount(smtpAccountId: string) {
  /**
   * 1. Fetch SMTP account
   */
  const { data: smtp, error } = await supabase
    .from('smtp_accounts')
    .select(`
      id,
      provider,
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
  const allSniCandidates = getSniCandidates({
    provider: smtp.provider,
    host: smtp.host,
    port: smtp.port,
    username: smtp.username,
    password,
    encryption: smtp.encryption,
  });
  const primarySni = allSniCandidates[0];
  const fallbackSniCandidates = allSniCandidates.slice(1);
  const attemptResults: Array<{ servername: string; success: boolean; error?: string; code?: string; kind?: SmtpFailureKind }> = [];

  /**
   * 3. Verify SMTP connection
   */
  try {
    let verified = false;
    const failedAttempts: Array<{ servername: string; error: any }> = [];

    const attemptVerify = async (servername: string) => {
      try {
        const transporter = createSmtpTransport(
          {
            provider: smtp.provider,
            host: smtp.host,
            port: smtp.port,
            username: smtp.username,
            password,
            encryption: smtp.encryption,
          },
          servername
        );
        await transporter.verify();
        attemptResults.push({ servername, success: true });
        verified = true;
        return true;
      } catch (err: any) {
        const kind = classifySmtpError(err);
        attemptResults.push({
          servername,
          success: false,
          error: err?.message ?? String(err),
          code: String(err?.code ?? err?.responseCode ?? ''),
          kind,
        });
        failedAttempts.push({ servername, error: err });
        return false;
      }
    };

    const baseSuccess = await attemptVerify(primarySni);

    if (!baseSuccess) {
      const baseError = failedAttempts[0]?.error;
      const baseKind = classifySmtpError(baseError);
      const isMxroute = String(smtp.provider ?? '').trim().toLowerCase() === 'mxroute';

      // Only try alternate SNI candidates when the first failure is a TLS host mismatch.
      if (isMxroute && baseKind === 'tls') {
        for (const servername of fallbackSniCandidates) {
          const ok = await attemptVerify(servername);
          if (ok) break;
        }
      }
    }

    const hasFailure = attemptResults.some((a) => !a.success);
    if (hasFailure) {
      console.warn('[SMTP_VALIDATION_ATTEMPTS]', {
        smtpAccountId,
        provider: smtp.provider,
        host: smtp.host,
        port: smtp.port,
        encryption: smtp.encryption,
        attempts: attemptResults,
      });
    }

    if (!verified) {
      throw pickRootCauseError(failedAttempts);
    }

    console.info('[SMTP_VALIDATION_SUCCESS]', {
      smtpAccountId,
      provider: smtp.provider,
      host: smtp.host,
      port: smtp.port,
      encryption: smtp.encryption,
      attempts: attemptResults,
    });

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
    const message = formatSmtpValidationError(err, smtp.provider, {
      host: smtp.host,
      port: smtp.port,
      encryption: smtp.encryption,
      attemptedSni: allSniCandidates,
    });
    const contextualMessage = `${message} (provider=${String(smtp.provider ?? 'unknown')}, host=${smtp.host}:${smtp.port})`;
    /**
     * 5. Mark as invalid
     */
    await supabase
      .from('smtp_accounts')
      .update({
        is_valid: false,
        error_message: contextualMessage || 'SMTP verification failed',
        last_checked_at: new Date().toISOString(),
      })
      .eq('id', smtpAccountId);

    throw new Error(`SMTP validation failed: ${contextualMessage}`);
  }
}
