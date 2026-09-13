import crypto from 'crypto';

export function generateKeyMaterial() {
  const token = `obaol_live_${crypto.randomBytes(32).toString('hex')}`;
  return {
    token,
    keyHash: crypto.createHash('sha256').update(token).digest('hex'),
    keyPrefix: token.slice(0, 23),
  };
}
