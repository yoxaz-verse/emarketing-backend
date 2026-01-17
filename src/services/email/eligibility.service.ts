// src/services/email/eligibility.service.ts

import dns from 'dns/promises';
import validator from 'validator';

export type EligibilityResult = {
  status: 'eligible' | 'risky' | 'blocked';
  reason: string;
};

const FREE_PROVIDERS = [
  'gmail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com'
];

import rawDisposableDomains from './disposableDomains.json';

const disposableDomains = rawDisposableDomains as string[];

export async function checkEmailEligibility(
  email: string
): Promise<EligibilityResult> {
  /**
   * 1️⃣ Syntax validation
   */
  if (!validator.isEmail(email)) {
    return {
      status: 'blocked',
      reason: 'invalid_syntax'
    };
  }

  const domain = email.split('@')[1].toLowerCase();

  /**
   * 2️⃣ Disposable domain check
   */
  if (disposableDomains.includes(domain)) {
    return {
      status: 'blocked',
      reason: 'disposable_domain'
    };
  }

  /**
   * 3️⃣ MX record check
   * DNS failures are treated as blocked
   * (retry handled at worker level)
   */
  try {
    const mx = await dns.resolveMx(domain);
    if (!mx || mx.length === 0) {
      return {
        status: 'blocked',
        reason: 'no_mx'
      };
    }
  } catch {
    return {
      status: 'blocked',
      reason: 'no_mx'
    };
  }

  /**
   * 4️⃣ Free providers → risky
   */
  if (FREE_PROVIDERS.includes(domain)) {
    return {
      status: 'risky',
      reason: 'free_provider'
    };
  }

  /**
   * 5️⃣ Passed all checks
   */
  return {
    status: 'eligible',
    reason: 'passed_basic_checks'
  };
}
