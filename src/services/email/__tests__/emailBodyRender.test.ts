import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPlainTextAsHtml } from '../emailBodyRender';

test('renders paragraphs, preserves line breaks, and escapes HTML', () => {
  const input = [
    'Hi <Team> & Partners,',
    'This is line "one".',
    '',
    'Regards,',
    "Jacob's Desk",
  ].join('\n');

  const output = renderPlainTextAsHtml(input);

  assert.equal(
    output,
    '<p>Hi &lt;Team&gt; &amp; Partners,<br>This is line &quot;one&quot;.</p>\n<p>Regards,<br>Jacob&#39;s Desk</p>'
  );
});

test('returns empty html for blank input', () => {
  assert.equal(renderPlainTextAsHtml('   \n\n  '), '');
});
