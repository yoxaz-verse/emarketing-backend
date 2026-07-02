import dns from 'dns/promises';
import net from 'net';

function isPrivateAddress(address: string) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127);
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc')
    || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('::ffff:127.');
}

export async function assertSafeOutboundUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Outbound URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS URLs are allowed');
  if (url.username || url.password) throw new Error('Credentials in outbound URLs are not allowed');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal') {
    throw new Error('Private network destinations are not allowed');
  }
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error('Private network destinations are not allowed');
  }
  return url;
}

export async function safeFetch(input: string, init: RequestInit = {}, options: { timeoutMs?: number; maxRedirects?: number } = {}) {
  const timeoutMs = Math.max(1000, Math.min(options.timeoutMs ?? 15000, 60000));
  const maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? 3, 5));
  let current = (await assertSafeOutboundUrl(input)).toString();
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(current, { ...init, redirect: 'manual', signal: controller.signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location || redirectCount === maxRedirects) throw new Error('Outbound redirect limit exceeded');
        current = (await assertSafeOutboundUrl(new URL(location, current).toString())).toString();
        continue;
      }
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > 2 * 1024 * 1024) throw new Error('Outbound response is too large');
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('Outbound request failed');
}
