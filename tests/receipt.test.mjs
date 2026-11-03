// Unit test della lettura scontrini e dei prezzi pagati (richiede `npm run build`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseReceipt, matchLines, similarity } = require('../services/list/dist/receipt.js');
const { buildMatrix, purchaseQuote } = require('../services/pricing/dist/engine.js');

const RECEIPT = `
SUPERRISPARMIO PIEVE
Via Roma 12 - P.IVA 01234567890
DOCUMENTO COMMERCIALE
di vendita o prestazione
DESCRIZIONE              IVA   PREZZO(€)
LATTE PS 1L              4%       2,58
  2 x 1,29
MOZZ. 125G               4%       0,99
SCONTO PROMO                     -0,20
BANANE                   4%       1,01
  0,534 kg x 1,89 €/kg
SPAGHETTI 500G           4%       0,99
CANDELINE                22%      1,50
SUBTOTALE                         7,07
TOTALE COMPLESSIVO                6,87
PAGAMENTO ELETTRONICO             6,87
IMPORTO PAGATO                    6,87
`;

test('parseReceipt: righe prodotto, quantità, peso, sconti e totale', () => {
  const r = parseReceipt(RECEIPT);
  assert.deepEqual(r.lines.map((l) => [l.text.split(' ')[0], l.amount, l.quantity, l.unitPrice, l.unit]), [
    ['LATTE', 2.58, 2, 1.29, 'pz'],
    ['MOZZ.', 0.79, 1, 0.79, 'pz'],      // sconto applicato alla riga precedente
    ['BANANE', 1.01, 0.534, 1.89, 'kg'],
    ['SPAGHETTI', 0.99, 1, 0.99, 'pz'],
    ['CANDELINE', 1.5, 1, 1.5, 'pz'],
  ]);
  assert.equal(r.total, 6.87);
  assert.equal(r.linesTotal, 6.87);
});

test('parseReceipt: quantità stampata prima del prodotto', () => {
  const r = parseReceipt('3 X 0,50\nYOGURT BIANCO   1,50\nTOTALE   1,50');
  assert.deepEqual([r.lines[0].quantity, r.lines[0].unitPrice], [3, 0.5]);
});

test('parseReceipt: ignora intestazione, IVA e pagamento', () => {
  const r = parseReceipt('IVA 4%   0,26\nCONTANTE   10,00\nRESTO   3,13\nTOTALE EURO 6,87');
  assert.equal(r.lines.length, 0);
  assert.equal(r.total, 6.87);
});

test('similarity: abbreviazioni da scontrino', () => {
  assert.ok(similarity('LATTE PS 1L', 'Latte parz. scremato 1 l') > 0.6);
  assert.ok(similarity('MOZZ. 125G', 'Mozzarella 125 g') > 0.8);
  assert.ok(similarity('CANDELINE', 'Latte parz. scremato 1 l') < 0.2);
});

test('matchLines: un articolo per riga, prima le coppie più sicure', () => {
  const { lines } = parseReceipt(RECEIPT);
  const candidates = [
    { itemId: 'i-latte', label: 'Latte parz. scremato 1 l', productId: 'p-latte' },
    { itemId: 'i-mozz', label: 'Mozzarella 125 g', productId: 'p-mozz' },
    { itemId: 'i-spag', label: 'Spaghetti 500 g', productId: 'p-spag' },
    { itemId: 'i-pane', label: 'Pane in cassetta 400 g', productId: 'p-pane' },
  ];
  const catalog = [{ productId: 'p-latte', confidence: 0.95 }, {}, { productId: 'p-banane', confidence: 1 }, {}, {}];
  const m = matchLines(lines, candidates, catalog);
  assert.deepEqual(m.map((x) => x?.itemId ?? null), ['i-latte', 'i-mozz', null, 'i-spag', null]);
});

test('purchaseQuote: i prezzi dello scontrino prevalgono sul listino', () => {
  const stores = [
    { id: 'A', chainId: 'cA', name: 'A', distanceKm: 1 },
    { id: 'B', chainId: 'cB', name: 'B', distanceKm: 2 },
  ];
  const p = (storeId, productId, price) => ({ storeId, productId, price, promoPrice: null, loyaltyOnly: false });
  const matrix = buildMatrix(stores, [p('A', 'latte', 1.29), p('B', 'latte', 1.49), p('B', 'pane', 2.0)], new Set());
  const items = [{ itemId: '0', productId: 'latte', quantity: 2 }, { itemId: '1', productId: 'pane', quantity: 1 }];
  const q = purchaseQuote(items, stores, matrix, 'A', { latte: 1.19, pane: 1.8 });
  assert.equal(q.totalPaid, 4.18);                 // 2 × 1,19 + 1,80: anche il pane, assente dal listino di A
  assert.equal(q.totalReference, 4.98);            // 2 × 1,49 + 2,00 nel negozio B
  assert.equal(q.savedEur, 0.8);
  assert.ok(q.lines.every((l) => l.fromReceipt));
});
