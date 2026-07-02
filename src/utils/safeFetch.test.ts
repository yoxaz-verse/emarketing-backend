import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeOutboundUrl } from './safeFetch';

test('rejects localhost and loopback outbound targets', async () => {
  await assert.rejects(() => assertSafeOutboundUrl('http://localhost:3000/private'));
  await assert.rejects(() => assertSafeOutboundUrl('http://127.0.0.1/private'));
  await assert.rejects(() => assertSafeOutboundUrl('http://[::1]/private'));
});

test('rejects private and metadata network targets', async () => {
  await assert.rejects(() => assertSafeOutboundUrl('http://10.0.0.1/'));
  await assert.rejects(() => assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data'));
  await assert.rejects(() => assertSafeOutboundUrl('file:///etc/passwd'));
});

test('accepts a syntactically valid public IP target', async () => {
  const url = await assertSafeOutboundUrl('https://1.1.1.1/path');
  assert.equal(url.protocol, 'https:');
});
