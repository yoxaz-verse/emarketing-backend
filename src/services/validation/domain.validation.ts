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
  dkimSelectorUsed?: string;
  dkimLookupHost?: string;
  dkimFailureReason?: string;
  spfLookupHost?: string;
  dmarcLookupHost?: string;
  dkimLookupCnameTarget?: string;
  dkimErrorCode?: string;
  dkimAttempts?: Array<{
    selector: string;
    lookupHost: string;
    cnameTarget?: string;
    txtRecords: string;
    errorCode?: string;
  }>;
};

type DnsLookupResult = {
  sourceHost: string;
  cnameTarget?: string;
  records: string;
  rcode?: string;
};

async function resolveCnameSafe(name: string): Promise<string | null> {
  try {
    const cnameRecords = await dns.resolveCname(name);
    return cnameRecords[0] ?? null;
  } catch {
    return null;
  }
}

async function resolveTxtWithCnameFallback(name: string): Promise<DnsLookupResult> {
  try {
    const records = await dns.resolveTxt(name);
    const flatRecords = records.flat().join(' ');
    return {
      sourceHost: name,
      records: flatRecords,
    };
  } catch (error: any) {
    const rcode = error?.code as string | undefined;
    const cnameTarget = await resolveCnameSafe(name);

    if (cnameTarget) {
      try {
        const cnameTxtRecords = await dns.resolveTxt(cnameTarget);
        const flatRecords = cnameTxtRecords.flat().join(' ');
        return {
          sourceHost: name,
          cnameTarget,
          records: flatRecords,
        };
      } catch (cnameError: any) {
        return {
          sourceHost: name,
          cnameTarget,
          records: '',
          rcode: cnameError?.code ?? rcode ?? 'UNKNOWN',
        };
      }
    }

    return {
      sourceHost: name,
      records: '',
      rcode: rcode ?? 'UNKNOWN',
    };
  }
}

export async function inspectSendingDomain(
  domain: string,
  dkimSelector?: string | null
): Promise<DomainValidationResult> {
  // SPF
  const spfResult = await resolveTxtWithCnameFallback(domain);
  const spfTxt = spfResult.records.toLowerCase();

  // DKIM (provider-specific selector support + fallback auto-detection)
  const fallbackSelectors = ['x', 'default', 'mail', 'mx', 'selector1', 'google'];
  const normalizedManual = (dkimSelector ?? '').trim().toLowerCase();
  const selectorsToTry = [
    ...(normalizedManual ? [normalizedManual] : []),
    ...fallbackSelectors.filter((s) => s !== normalizedManual),
  ];

  let hasDkim = false;
  let dkimSelectorUsed: string | undefined;
  let dkimLookupHost: string | undefined;
  let dkimLookupCnameTarget: string | undefined;
  let dkimErrorCode: string | undefined;
  const dkimAttempts: DomainValidationResult['dkimAttempts'] = [];

  for (const selector of selectorsToTry) {
    const lookupHost = `${selector}._domainkey.${domain}`;
    const lookupResult = await resolveTxtWithCnameFallback(lookupHost);
    const txtRecords = lookupResult.records;
    const lowerTxt = txtRecords.toLowerCase();

    if (lookupResult.rcode) {
      console.warn('[DOMAIN VALIDATION][DKIM LOOKUP FAILED]', {
        domain,
        selector,
        lookupHost,
        cnameTarget: lookupResult.cnameTarget ?? null,
        rcode: lookupResult.rcode,
      });
    }

    dkimAttempts?.push({
      selector,
      lookupHost,
      cnameTarget: lookupResult.cnameTarget,
      txtRecords,
      errorCode: lookupResult.rcode,
    });

    dkimLookupHost = lookupHost;
    dkimLookupCnameTarget = lookupResult.cnameTarget;
    dkimErrorCode = lookupResult.rcode;

    if (lowerTxt.includes('v=dkim1')) {
      hasDkim = true;
      dkimSelectorUsed = selector;
      break;
    }
  }

  // DMARC (with inheritance)
  const dmarcLookupHost = `_dmarc.${domain}`;
  let dmarcResult = await resolveTxtWithCnameFallback(dmarcLookupHost);
  let dmarcTxt = dmarcResult.records.toLowerCase();

  if (!dmarcTxt && domain.split('.').length > 2) {
    const root = domain.split('.').slice(-2).join('.');
    dmarcResult = await resolveTxtWithCnameFallback(`_dmarc.${root}`);
    dmarcTxt = dmarcResult.records.toLowerCase();
  }

  const hasSpf = spfTxt.includes('v=spf1');
  const hasGoogle = spfTxt.includes('_spf.google.com');
  const hasMxroute = spfTxt.includes('mxroute.com');

  const hasDmarc = dmarcTxt.includes('v=dmarc1');

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
    dkimSelectorUsed,
    dkimLookupHost,
    spfLookupHost: spfResult.sourceHost,
    dmarcLookupHost: dmarcResult.sourceHost,
    dkimLookupCnameTarget,
    dkimErrorCode,
    dkimAttempts,
    dkimFailureReason: hasDkim
      ? undefined
      : dkimLookupHost
      ? `Checked ${dkimLookupHost}${dkimLookupCnameTarget ? ` (CNAME: ${dkimLookupCnameTarget})` : ''}; TXT/CNAME not found or not yet propagated.`
      : 'DKIM lookup failed',
  };
}
