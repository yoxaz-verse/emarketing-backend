import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSequencePlaceholders,
  normalizePlaceholderKey,
  renderMergeTemplate,
  resolveMappingValues,
  sequencePlaceholderSignature,
  validateMappings,
} from '../campaignPersonalization.service.js';

const steps = [{
  step_number: 1,
  subject: 'A note for {{ First Name }} at {{Company Name}}',
  body: 'Hi {{first   name}},\n\nRegards,\n{{Sender Name}}',
}];

test('extracts friendly placeholders once and records every usage', () => {
  const placeholders = extractSequencePlaceholders(steps);
  assert.deepEqual(placeholders.map((item) => item.key), ['company name', 'first name', 'sender name']);
  assert.equal(placeholders.find((item) => item.key === 'first name')?.usages.length, 2);
  assert.equal(placeholders.find((item) => item.key === 'company name')?.suggested_lead_field, 'company');
});

test('normalizes case, spacing, underscores, and hyphens', () => {
  assert.equal(normalizePlaceholderKey(' First_Name '), 'first name');
  assert.equal(normalizePlaceholderKey('COMPANY---NAME'), 'company name');
});

test('rejects malformed templates', () => {
  assert.throws(() => extractSequencePlaceholders([{ body: 'Hi {{First Name}' }]), /Malformed dynamic field/);
  assert.throws(() => extractSequencePlaceholders([{ body: 'Hi {{}}' }]), /Malformed dynamic field|cannot be empty/);
});

test('validates mappings and resolves lead fields plus fixed text', () => {
  const placeholders = extractSequencePlaceholders(steps);
  const mappings: any[] = [
    { placeholder_key: 'first name', placeholder_label: 'First Name', source_type: 'lead_field', lead_field: 'first_name', required: true },
    { placeholder_key: 'company name', placeholder_label: 'Company Name', source_type: 'lead_field', lead_field: 'company', required: true },
    { placeholder_key: 'sender name', placeholder_label: 'Sender Name', source_type: 'fixed_text', fixed_value: 'OBAOL Team', required: true },
  ];
  assert.deepEqual(validateMappings(placeholders, mappings), []);
  const result = resolveMappingValues(mappings, { first_name: 'Asha', company: 'Spice & Co.' });
  assert.deepEqual(result.missing, []);
  assert.equal(renderMergeTemplate(steps[0].body, result.values), 'Hi Asha,\n\nRegards,\nOBAOL Team');
});

test('reports required values missing on an individual lead', () => {
  const result = resolveMappingValues([
    { placeholder_key: 'company name', placeholder_label: 'Company Name', source_type: 'lead_field', lead_field: 'company', fixed_value: null, required: true },
  ], { company: '  ' });
  assert.deepEqual(result.missing, ['Company Name']);
});

test('signature changes when placeholder usage changes', () => {
  const first = extractSequencePlaceholders(steps);
  const second = extractSequencePlaceholders([{ ...steps[0], subject: `${steps[0].subject} {{Country}}` }]);
  assert.notEqual(sequencePlaceholderSignature(first), sequencePlaceholderSignature(second));
});

test('render rejects unresolved values and preserves HTML-sensitive text for later escaping', () => {
  assert.throws(() => renderMergeTemplate('Hi {{First Name}}', {}), /Unresolved dynamic field/);
  assert.equal(renderMergeTemplate('{{Company Name}}', { 'company name': '<Spice & Co>' }), '<Spice & Co>');
});
