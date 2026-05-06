import dns from 'dns/promises';
import validator from 'validator';
import { cacheGet, cacheSet } from '../cache/redisCache';
import { logger } from '../logging/logger';
import rawDisposableDomains from './disposableDomains.json';

const disposableDomains = new Set((rawDisposableDomains as string[]).map((d) => d.toLowerCase()));

const FREE_PROVIDERS = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com']);

const ROLE_PREFIXES = new Set([
  'admin',
  'support',
  'help',
  'sales',
  'contact',
  'hello',
  'team',
  'billing',
  'noreply',
  'no-reply',
  'info',
]);

export function isRoleBasedLocalPart(localPart: string): boolean {
  return ROLE_PREFIXES.has(localPart.toLowerCase());
}

const COMMON_PROVIDER_TYPOS: Record<string, string> = {
  'gamil.com': 'gmail.com',
  'gmial.com': 'gmail.com',
  'gnail.com': 'gmail.com',
  'hotnail.com': 'hotmail.com',
  'outlok.com': 'outlook.com',
  'yaho.com': 'yahoo.com',
};

export type ValidationStatus = 'valid' | 'risky' | 'invalid';
export type LegacyEligibilityStatus = 'eligible' | 'risky' | 'blocked';

export type EmailValidationResult = {
  validationStatus: ValidationStatus;
  legacyStatus: LegacyEligibilityStatus;
  reason: string;
  riskScore: number;
  disposable: boolean;
  roleBased: boolean;
  freeProvider: boolean;
  suggestion: string | null;
  mxRecords: string[];
  provider: string | null;
  retryable: boolean;
};

type MxLookupResult = {
  records: string[];
  timeout: boolean;
};

export function toLegacyStatus(status: ValidationStatus): LegacyEligibilityStatus {
  if (status === 'valid') return 'eligible';
  if (status === 'invalid') return 'blocked';
  return 'risky';
}

export function detectProvider(mxHosts: string[]): string | null {
  const joined = mxHosts.join(' ').toLowerCase();
  if (joined.includes('google.com')) return 'google';
  if (joined.includes('outlook.com') || joined.includes('protection.outlook.com')) return 'microsoft';
  if (joined.includes('mxroute')) return 'mxroute';
  return null;
}

export function getSuggestion(domain: string): string | null {
  return COMMON_PROVIDER_TYPOS[domain] ?? null;
}

async function lookupMx(domain: string): Promise<MxLookupResult> {
  const cacheKey = `email:mx:${domain}`;
  const cached = await cacheGet<MxLookupResult>(cacheKey);
  if (cached) return cached;

  try {
    const mx = await dns.resolveMx(domain);
    const result: MxLookupResult = {
      records: mx.map((r) => r.exchange.toLowerCase()).sort(),
      timeout: false,
    };
    await cacheSet(cacheKey, result);
    return result;
  } catch (error: any) {
    const code = error?.code as string | undefined;
    const isTimeout = code === 'ETIMEOUT' || code === 'EAI_AGAIN';

    logger.warn('mx_lookup_failed', {
      domain,
      code: code ?? 'unknown',
      timeout: isTimeout,
    });

    if (isTimeout) {
      return { records: [], timeout: true };
    }

    return { records: [], timeout: false };
  }
}

async function isDisposableDomain(domain: string): Promise<boolean> {
  const cacheKey = `email:disposable:${domain}`;
  const cached = await cacheGet<boolean>(cacheKey);
  if (typeof cached === 'boolean') return cached;

  const result = disposableDomains.has(domain);
  await cacheSet(cacheKey, result);
  return result;
}

async function detectProviderCached(mxHosts: string[]): Promise<string | null> {
  const key = `email:provider:${mxHosts.join(',')}`;
  const cached = await cacheGet<string | null>(key);
  if (cached !== null) return cached;

  const provider = detectProvider(mxHosts);
  await cacheSet(key, provider);
  return provider;
}

export async function validateEmailAddress(email: string): Promise<EmailValidationResult> {
  if (!validator.isEmail(email)) {
    logger.warn('invalid_email_syntax', { email });
    return {
      validationStatus: 'invalid',
      legacyStatus: 'blocked',
      reason: 'invalid_syntax',
      riskScore: 0,
      disposable: false,
      roleBased: false,
      freeProvider: false,
      suggestion: null,
      mxRecords: [],
      provider: null,
      retryable: false,
    };
  }

  const [localPart, rawDomain] = email.split('@');
  const domain = rawDomain.toLowerCase();

  let riskScore = 30;
  const disposable = await isDisposableDomain(domain);
  const roleBased = isRoleBasedLocalPart(localPart);
  const freeProvider = FREE_PROVIDERS.has(domain);
  const suggestion = getSuggestion(domain);

  const mxResult = await lookupMx(domain);
  const mxRecords = mxResult.records;

  if (mxResult.timeout) {
    return {
      validationStatus: 'risky',
      legacyStatus: 'risky',
      reason: 'dns_timeout_retryable',
      riskScore,
      disposable,
      roleBased,
      freeProvider,
      suggestion,
      mxRecords,
      provider: null,
      retryable: true,
    };
  }

  if (mxRecords.length === 0) {
    logger.warn('invalid_email_domain_no_mx', { domain });
    return {
      validationStatus: 'invalid',
      legacyStatus: 'blocked',
      reason: 'no_mx',
      riskScore,
      disposable,
      roleBased,
      freeProvider,
      suggestion,
      mxRecords,
      provider: null,
      retryable: false,
    };
  }

  riskScore += 40;
  if (!disposable) riskScore += 10;
  if (!roleBased) riskScore += 10;
  if (!freeProvider) riskScore += 10;

  const provider = await detectProviderCached(mxRecords);

  let validationStatus: ValidationStatus = 'valid';
  let reason = 'passed_basic_checks';

  if (disposable) {
    validationStatus = 'invalid';
    reason = 'disposable_domain';
  } else if (roleBased || freeProvider || suggestion) {
    validationStatus = 'risky';
    reason = roleBased ? 'role_based' : freeProvider ? 'free_provider' : 'domain_typo_suspected';
  }

  return {
    validationStatus,
    legacyStatus: toLegacyStatus(validationStatus),
    reason,
    riskScore,
    disposable,
    roleBased,
    freeProvider,
    suggestion,
    mxRecords,
    provider,
    retryable: false,
  };
}
