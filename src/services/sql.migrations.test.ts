import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('current production SQL runbook lists the executable migration order', () => {
  const readme = readFileSync('sql/README.md', 'utf8');
  const expected = [
    'current/20260906_unified_communications.sql',
    'current/20260915_atomic_campaign_delete.sql',
    'current/20260917_verify_and_repair_production_schema.sql',
    'current/20261008_campaign_dynamic_fields.sql',
    'current/20261009_reply_capture_rebuild.sql',
    'current/20261009_cleanup_sequence_delay_notifications.sql',
  ];
  let previous = -1;
  for (const path of expected) {
    const position = readme.indexOf(path);
    assert.ok(position > previous, `${path} must appear in execution order`);
    previous = position;
    assert.doesNotThrow(() => readFileSync(`sql/${path}`, 'utf8'));
  }
});

test('sequence delay notification cleanup is narrow and preserves audit events', () => {
  const sql = readFileSync('sql/current/20261009_cleanup_sequence_delay_notifications.sql', 'utf8');
  assert.match(sql, /delete from public\.communication_queue/i);
  assert.match(sql, /delete from public\.communication_items/i);
  assert.match(sql, /CAMPAIGN_SEQUENCE_DELAY_BLOCKED/i);
  assert.doesNotMatch(sql, /delete from public\.system_events/i);
});

test('reply capture rebuild is guarded and preserves old campaigns from resending', () => {
  const sql = readFileSync('sql/current/20261009_reply_capture_rebuild.sql', 'utf8');
  assert.match(sql, /create table if not exists public\.reply_capture_cursors/i);
  assert.match(sql, /on conflict do nothing/i);
  assert.match(sql, /if not found then/i);
  assert.match(sql, /set status = 'completed', status_reason = 'reply_history_reset'/i);
  assert.match(sql, /delete from public\.email_tracking_events where event_type = 'reply'/i);
  assert.match(sql, /delete from public\.reply_ingest_events/i);
});

test('schema cleanup audit is read-only and current excludes confirmed-applied repairs', () => {
  const readme = readFileSync('sql/README.md', 'utf8');
  const audit = readFileSync('sql/review/20261008_schema_cleanup_audit.sql', 'utf8');
  assert.doesNotMatch(audit, /^\s*(drop|alter|update|delete|truncate|insert)\b/im);
  assert.doesNotMatch(readme, /current\/20260915_repair_social_publish_job_outcomes\.sql/);
  assert.doesNotMatch(readme, /current\/20260916_align_social_connector_schema\.sql/);
  assert.match(readme, /review\/20261008_schema_cleanup_audit\.sql/);
});

test('production schema repair is idempotent and audits every runtime dependency', () => {
  const sql = readFileSync('sql/current/20260917_verify_and_repair_production_schema.sql', 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS updated_at timestamptz not null default now\(\)/i);
  assert.match(sql, /communication_messages_user_id_idempotency_key_uidx/i);
  assert.match(sql, /api_idempotency_api_key_request_key_uidx/i);
  assert.match(sql, /communication_lease\(text,boolean\)/i);
  assert.match(sql, /communication_append\(jsonb,jsonb,jsonb,boolean\)/i);
  assert.match(sql, /campaign_delete_preview\(text,text\)/i);
  assert.match(sql, /delete_campaigns_with_data\(text\[\],text\)/i);
  assert.match(sql, /where not present/i);
  assert.match(sql, /NOTIFY pgrst,\s*'reload schema'/i);
});

test('campaign delete migration preserves its original append function on rerun', () => {
  const sql = readFileSync('sql/current/20260915_atomic_campaign_delete.sql', 'utf8');
  assert.match(sql, /to_regprocedure\('public\.communication_append_unchecked\(jsonb,jsonb,jsonb,boolean\)'\) is null/i);
  assert.match(sql, /rename to communication_append_unchecked/i);
  assert.match(sql, /create or replace function communication_append\(p_item jsonb,p_conversation jsonb,p_message jsonb,p_historical boolean\)/i);
  assert.match(sql, /to_regclass\('public\.' \|\| t\) is null/i);
  assert.match(sql, /to_regclass\('public\.campaign_voice_agents'\) is not null/i);
});
