// Unit test del parser di inserimento rapido (richiede `npm run build`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseInput } = require('../services/list/dist/parser.js');

const cases = [
  ['latte', { text: 'latte', quantity: 1 }],
  ['2 latte', { text: 'latte', quantity: 2 }],
  ['latte x2', { text: 'latte', quantity: 2 }],
  ['3x tonno', { text: 'tonno', quantity: 3 }],
  ['1,5 kg mele', { text: 'mele', quantity: 1.5, unit: 'kg' }],
  ['mele 1.5kg', { text: 'mele', quantity: 1.5, unit: 'kg' }],
  ['banane 1,5 kg', { text: 'banane', quantity: 1.5, unit: 'kg' }],
  ['500 g di macinato', { text: 'macinato', quantity: 0.5, unit: 'kg' }],
  ['spaghetti 500 g', { text: 'spaghetti', quantity: 0.5, unit: 'kg' }],
  ['  acqua   6 ', { text: 'acqua', quantity: 6 }],
  ['latte parzialmente scremato', { text: 'latte parzialmente scremato', quantity: 1 }],
];

for (const [input, expected] of cases) {
  test(`parseInput("${input}")`, () => assert.deepEqual(parseInput(input), expected));
}
