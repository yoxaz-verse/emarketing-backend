import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { requireServiceSecret, requireWebhookSignature, requireWriteRole } from './security';

function responseMock() {
  const state: { status: number; payload?: unknown; headers: Record<string, string> } = { status: 200, headers: {} };
  const response = {
    status(code: number) { state.status = code; return this; },
    json(payload: unknown) { state.payload = payload; return this; },
    setHeader(name: string, value: string) { state.headers[name] = value; },
  };
  return { state, response };
}

test('write-role guard allows reads and rejects viewer mutations', () => {
  let nextCalled = false;
  const read = responseMock();
  requireWriteRole({ method: 'GET', auth: { role: 'viewer' } } as never, read.response as never, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  const write = responseMock();
  requireWriteRole({ method: 'POST', auth: { role: 'viewer' } } as never, write.response as never, () => undefined);
  assert.equal(write.state.status, 403);
});

test('service guard fails closed and accepts the exact bearer secret', () => {
  const previous = process.env.INTERNAL_SERVICE_SECRET;
  process.env.INTERNAL_SERVICE_SECRET = 'internal-test-secret';
  const denied = responseMock();
  requireServiceSecret()({ headers: { authorization: 'Bearer wrong' } } as never, denied.response as never, () => undefined);
  assert.equal(denied.state.status, 401);
  let nextCalled = false;
  const accepted = responseMock();
  requireServiceSecret()({ headers: { authorization: 'Bearer internal-test-secret' } } as never, accepted.response as never, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  if (previous === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
  else process.env.INTERNAL_SERVICE_SECRET = previous;
});

test('webhook signatures are verified and cannot be replayed', async () => {
  const previous = process.env.OBAOL_WEBHOOK_SECRET;
  process.env.OBAOL_WEBHOOK_SECRET = 'webhook-test-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = Buffer.from(JSON.stringify({ event: 'delivered' }));
  const signature = crypto.createHmac('sha256', process.env.OBAOL_WEBHOOK_SECRET).update(timestamp).update('.').update(body).digest('hex');
  const request = { headers: { 'x-obaol-timestamp': timestamp, 'x-obaol-signature': signature }, rawBody: body, body: { event: 'delivered' } };
  let nextCalled = false;
  const accepted = responseMock();
  await requireWebhookSignature()(request as never, accepted.response as never, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  const replay = responseMock();
  await requireWebhookSignature()(request as never, replay.response as never, () => undefined);
  assert.equal(replay.state.status, 409);
  if (previous === undefined) delete process.env.OBAOL_WEBHOOK_SECRET;
  else process.env.OBAOL_WEBHOOK_SECRET = previous;
});
