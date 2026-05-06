import { validateEmailAddress } from './emailValidation.pipeline';

export type EligibilityResult = {
  status: 'eligible' | 'risky' | 'blocked';
  reason: string;
};

export async function checkEmailEligibility(email: string): Promise<EligibilityResult> {
  const result = await validateEmailAddress(email);
  return {
    status: result.legacyStatus,
    reason: result.reason,
  };
}
