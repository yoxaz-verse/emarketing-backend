import dns from 'dns/promises';

export type DomainValidationState =
  | 'unverified'
  | 'google_only'
  | 'partial_mxroute'
  | 'verified';

export type DomainValidationResult = {
  domain: string;
  state: DomainValidationState;
  hasSpf: boolean;
  hasDkim: boolean;
  hasDmarc: boolean;
};

async function resolveTxtSafe(name: string): Promise<string> {
  try {
    const records = await dns.resolveTxt(name);
    return records.flat().join(' ');
  } catch {
    return '';
  }
}

export async function inspectSendingDomain(
  domain: string
): Promise<DomainValidationResult> {
  // SPF
  const spfTxt = await resolveTxtSafe(domain);

  // DKIM (check BOTH Google and MXRoute)
  const googleDkim = await resolveTxtSafe(`google._domainkey.${domain}`);
  const mxrouteDkim = await resolveTxtSafe(`default._domainkey.${domain}`);

  // DMARC (with inheritance)
  let dmarcTxt = await resolveTxtSafe(`_dmarc.${domain}`);

  if (!dmarcTxt && domain.split('.').length > 2) {
    const root = domain.split('.').slice(-2).join('.');
    dmarcTxt = await resolveTxtSafe(`_dmarc.${root}`);
  }

  const hasSpf = spfTxt.includes('v=spf1');
  const hasGoogle = spfTxt.includes('_spf.google.com');
  const hasMxroute = spfTxt.includes('mxroute.com');

  const hasDkim =
    googleDkim.includes('v=DKIM1') ||
    mxrouteDkim.includes('v=DKIM1');

  const hasDmarc = dmarcTxt.includes('v=DMARC1');

  let state: DomainValidationState = 'unverified';

  if (hasGoogle && !hasMxroute) {
    state = 'google_only';
  } else if (hasMxroute && (!hasDkim || !hasDmarc)) {
    state = 'partial_mxroute';
  } else if (hasMxroute && hasDkim && hasDmarc) {
    state = 'verified';
  }

  return {
    domain,
    state,
    hasSpf,
    hasDkim,
    hasDmarc,
  };
}
