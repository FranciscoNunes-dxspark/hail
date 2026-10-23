// The shortcuts taken for speed give what the long way gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrap } from '../src/text.js';
import { wrapIndented } from '../src/ui/response.js';

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
