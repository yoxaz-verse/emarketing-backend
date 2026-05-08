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
const DNS_TIMEOUT_MS = Math.max(1_000, Number(process.env.EMAIL_VALIDATION_DNS_TIMEOUT_MS ?? 5_000));

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
  const cacheGetStartedAt = Date.now();
  const cached = await cacheGet<MxLookupResult>(cacheKey);
  logger.info('validation_stage_timing', {
    stage: 'cache_get',
    target: 'mx',
    domain,
    hit: Boolean(cached),
    durationMs: Date.now() - cacheGetStartedAt,
  });
  if (cached) return cached;

  try {
    const mxLookupStartedAt = Date.now();
    const mx = await Promise.race([
      dns.resolveMx(domain),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          const timeoutError = new Error(`dns_lookup_timeout_${DNS_TIMEOUT_MS}ms`);
          (timeoutError as Error & { code?: string }).code = 'ETIMEOUT';
          reject(timeoutError);
        }, DNS_TIMEOUT_MS);
      }),
    ]);
    logger.info('validation_stage_timing', {
      stage: 'mx_lookup',
      domain,
      timedOut: false,
      durationMs: Date.now() - mxLookupStartedAt,
    });
    const result: MxLookupResult = {
      records: mx.map((r) => r.exchange.toLowerCase()).sort(),
      timeout: false,
    };
    const cacheSetStartedAt = Date.now();
    await cacheSet(cacheKey, result);
    logger.info('validation_stage_timing', {
      stage: 'cache_set',
      target: 'mx',
      domain,
      durationMs: Date.now() - cacheSetStartedAt,
    });
    return result;
  } catch (error: any) {
    const code = error?.code as string | undefined;
    const message = String(error?.message ?? '');
    const isTimeout = code === 'ETIMEOUT' || code === 'EAI_AGAIN' || message.startsWith('dns_lookup_timeout_');

    logger.warn('mx_lookup_failed', {
      domain,
      code: code ?? 'unknown',
      timeout: isTimeout,
      timeoutMs: DNS_TIMEOUT_MS,
      error: message,
    });

    if (isTimeout) {
      return { records: [], timeout: true };
    }

    return { records: [], timeout: false };
  }
}

async function isDisposableDomain(domain: string): Promise<boolean> {
  const cacheKey = `email:disposable:${domain}`;
  const cacheGetStartedAt = Date.now();
  const cached = await cacheGet<boolean>(cacheKey);
  logger.info('validation_stage_timing', {
    stage: 'cache_get',
    target: 'disposable',
    domain,
    hit: typeof cached === 'boolean',
    durationMs: Date.now() - cacheGetStartedAt,
  });
  if (typeof cached === 'boolean') return cached;

  const result = disposableDomains.has(domain);
  const cacheSetStartedAt = Date.now();
  await cacheSet(cacheKey, result);
  logger.info('validation_stage_timing', {
    stage: 'cache_set',
    target: 'disposable',
    domain,
    durationMs: Date.now() - cacheSetStartedAt,
  });
  return result;
}

async function detectProviderCached(mxHosts: string[]): Promise<string | null> {
  const key = `email:provider:${mxHosts.join(',')}`;
  const cacheGetStartedAt = Date.now();
  const cached = await cacheGet<string | null>(key);
  logger.info('validation_stage_timing', {
    stage: 'cache_get',
    target: 'provider',
    hit: cached !== null,
    durationMs: Date.now() - cacheGetStartedAt,
  });
  if (cached !== null) return cached;

  const provider = detectProvider(mxHosts);
  const cacheSetStartedAt = Date.now();
  await cacheSet(key, provider);
  logger.info('validation_stage_timing', {
    stage: 'cache_set',
    target: 'provider',
    durationMs: Date.now() - cacheSetStartedAt,
  });
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
