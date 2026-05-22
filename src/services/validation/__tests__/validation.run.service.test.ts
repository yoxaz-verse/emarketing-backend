import assert from 'node:assert/strict';
import test from 'node:test';

import {
  shouldAutoCompleteValidationRun,
  toValidationRunStatusPayload,
  type ValidationRunRow,
} from '../validation.run.service';

function makeRun(overrides: Partial<ValidationRunRow> = {}): ValidationRunRow {
  return {
    id: 'run_1',
    type: 'pending',
    status: 'running',
    started_at: '2026-05-22T07:00:00.000Z',
    finished_at: null,
    triggered_by: null,
    scope: { scopeType: 'operator', operatorId: 'op_1' },
    total_targeted: 10,
    processed_count: 6,
    success_count: 3,
    risky_count: 2,
    invalid_count: 1,
    failed_count: 0,
    last_error: null,
    created_at: '2026-05-22T07:00:00.000Z',
    updated_at: '2026-05-22T07:01:00.000Z',
    ...overrides,
  };
}

test('auto-completes stale active run when no pending work and no processing rows remain', () => {
  const run = makeRun({ status: 'running', total_targeted: 2, processed_count: 1 });
  assert.equal(
    shouldAutoCompleteValidationRun(run, { pendingAvailable: 0, processingNow: 0 }),
    true
  );
});

test('does not auto-complete when rows are still processing', () => {
  const run = makeRun({ status: 'running' });
  assert.equal(
    shouldAutoCompleteValidationRun(run, { pendingAvailable: 0, processingNow: 1 }),
    false
  );
});

test('does not auto-complete when pending work still exists', () => {
  const run = makeRun({ status: 'running' });
  assert.equal(
    shouldAutoCompleteValidationRun(run, { pendingAvailable: 4, processingNow: 0 }),
    false
  );
});

test('completed payload remains terminal even with risky-heavy outcomes', () => {
  const run = makeRun({
    status: 'completed',
    total_targeted: 2,
    processed_count: 2,
    success_count: 0,
    risky_count: 2,
    invalid_count: 0,
    failed_count: 0,
    finished_at: '2026-05-22T07:03:00.000Z',
  });
  const payload = toValidationRunStatusPayload(run);

  assert.equal(payload.status, 'completed');
  assert.equal(payload.metrics.remaining, 0);
  assert.equal(payload.metrics.inProgress, 0);
  assert.equal(payload.metrics.completionPercent, 100);
});

