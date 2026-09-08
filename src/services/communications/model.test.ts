import test from 'node:test';
import assert from 'node:assert/strict';
import { messageId, replySubject, sendFailureStatus, scopeForEvent } from './model';
test('thread IDs preserve case and reject injected headers',()=>{
  assert.equal(messageId('<Reply-ABC@example.com>'),'Reply-ABC@example.com');
  assert.equal(messageId('id\r\nBcc: victim@example.com'),null);
  assert.equal(messageId(''),null);
});
test('reply subjects prevent header injection and preserve Re',()=>{
  assert.equal(replySubject('Re: Question'),'Re: Question');
  assert.equal(replySubject('Question\r\nBcc: x'),'Re: Question  Bcc: x');
});
test('ambiguous SMTP outcomes are never classified safe to retry',()=>{
  assert.equal(sendFailureStatus({code:'ETIMEDOUT'}),'uncertain');
  assert.equal(sendFailureStatus({code:'ESOCKET'}),'uncertain');
  assert.equal(sendFailureStatus({responseCode:550}),'failed');
  assert.equal(sendFailureStatus({code:'EAUTH'}),'failed');
});
test('events with unresolved ownership are admin only',()=>{
  assert.equal(scopeForEvent({entity:'unknown',entity_id:'other-operator'}).module,'admin');
  const c=scopeForEvent({entity:'campaign',entity_id:'campaign-1'});
  assert.equal(c.scope_table,'campaigns');assert.equal(c.scope_id,'campaign-1');
  assert.equal(scopeForEvent({entity:'agent_tasks',entity_id:'a'}).module,'openflow_ai');
});
