// The shortcuts taken for speed give what the long way gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrap } from '../src/text.js';
import { bodyLines, responseLines, wrapIndented } from '../src/ui/response.js';

// wrapIndented as it was, through wrap for every line.
const slowWrap = (line, width) => {
  if (!line) return [''];
  const indent = /^\s*/.exec(line)[0];
  return wrap(line.slice(indent.length), Math.max(10, width - indent.length)).map((part) => indent + part);
};

test('a line that fits skips wrap and comes back as wrap would give it', () => {
  const lines = ['', 'short', '    "id": 1,', '  a  b   c ', ' '.repeat(12), 'x'.repeat(40), '  tab\there', 'wide 漢字 text', 'émigré', `  ${'word '.repeat(30)}`, '    "k": "a long value that goes on past the width of the pane"'];
  for (const width of [5, 10, 20, 40, 80]) for (const l of lines) assert.deepEqual(wrapIndented(l, width), slowWrap(l, width), `${JSON.stringify(l)} at ${width}`);
});

test("a response's body lines are worked out once per width, and responseLines ends with them", () => {
  const response = { status: 200, statusText: 'OK', headers: [['Content-Type', 'application/json']], body: JSON.stringify({ items: [1, 2], text: 'word '.repeat(40) }), ms: 5, size: 10, url: 'http://x/' };
  const sent = { request: { method: 'GET', url: 'http://x/' }, response, at: Date.now() };
  const a = bodyLines(response, 40);
  assert.equal(bodyLines(response, 40), a, 'the same array the second time');
  assert.notEqual(bodyLines(response, 60), a, 'another width, other lines');
  assert.equal(bodyLines(response, 40), a, 'and the first width is still kept');
  const lines = responseLines(sent, 40);
  assert.deepEqual(lines.slice(-a.length), a);
  assert.deepEqual(a.map((l) => l[0].text), JSON.stringify(JSON.parse(response.body), null, 2).split('\n').flatMap((l) => slowWrap(l, 40)));
  // Another response with the same body is its own.
  assert.notEqual(bodyLines({ ...response }, 40), a);
});
