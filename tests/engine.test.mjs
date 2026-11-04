// Unit test del motore di confronto prezzi (richiede `npm run build`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMatrix, singleStore, twoStores, perItem, purchaseQuote, effectivePrice, round2 } = require('../services/pricing/dist/engine.js');

const stores = [
  { id: 'A', chainId: 'cA', name: 'Negozio A', distanceKm: 1 },
  { id: 'B', chainId: 'cB', name: 'Negozio B', distanceKm: 2 },
  { id: 'C', chainId: 'cC', name: 'Negozio C', distanceKm: 3 },
];
const items = [
  { itemId: 'i1', productId: 'latte', quantity: 2 },
  { itemId: 'i2', productId: 'pane', quantity: 1 },
  { itemId: 'i3', productId: 'caffe', quantity: 1 },
];
const p = (storeId, productId, price, promoPrice = null, loyaltyOnly = false) => ({ storeId, productId, price, promoPrice, loyaltyOnly });
const prices = [
  p('A', 'latte', 1.0), p('A', 'pane', 2.0), p('A', 'caffe', 4.0),
  p('B', 'latte', 1.2), p('B', 'pane', 1.5), p('B', 'caffe', 3.0, 2.0, true),
  p('C', 'latte', 0.9), p('C', 'pane', 1.8),
];

test('promo riservata ai titolari di carta', () => {
  assert.equal(effectivePrice(p('B', 'x', 3, 2, true), false).unitPrice, 3);
  assert.equal(effectivePrice(p('B', 'x', 3, 2, true), true).unitPrice, 2);
  assert.equal(effectivePrice(p('B', 'x', 3, 2, false), false).unitPrice, 2);
});

test('negozio unico: prima la copertura, poi il totale', () => {
  const res = singleStore(items, stores, buildMatrix(stores, prices, new Set()));
  assert.deepEqual(res.map((r) => [r.storeId, r.total, r.missingItems]), [['B', 6.9, 0], ['A', 8, 0], ['C', 3.6, 1]]);
  assert.equal(res[0].savingVsMax, 1.1);
});

test('la carta fedeltà cambia il risultato', () => {
  const res = singleStore(items, stores, buildMatrix(stores, prices, new Set(['cB'])));
  assert.equal(res[0].storeId, 'B');
  assert.equal(res[0].total, 5.9);
});

test('due negozi: ogni articolo nel più economico della coppia', () => {
  const [bestPair] = twoStores(items, stores, buildMatrix(stores, prices, new Set()));
  assert.deepEqual(bestPair.stores.map((s) => s.storeId).sort(), ['B', 'C']);
  assert.equal(bestPair.total, 6.3); // latte C 1.8 + pane B 1.5 + caffè B 3.0
  assert.equal(bestPair.savingVsBestSingle, 0.6);
});

test('miglior prezzo per articolo', () => {
  const res = perItem(items, stores, buildMatrix(stores, prices, new Set()));
  assert.equal(res.total, 6.3);
  assert.equal(res.missingItems, 0);
  assert.equal(res.storesUsed, 2);
});

test('chiusura spesa: riferimento = negozio più caro con la stessa copertura', () => {
  const q = purchaseQuote(items, stores, buildMatrix(stores, prices, new Set()), 'B');
  assert.equal(q.referenceStoreId, 'A');
  assert.equal(q.totalPaid, 6.9);
  assert.equal(q.totalReference, 8);
  assert.equal(q.savedEur, 1.1);
  assert.equal(q.savedPct, 13.8);
});

test('chiusura spesa: articoli assenti nel riferimento esclusi dal risparmio', () => {
  const onlyC = [stores[1], stores[2]];
  const q = purchaseQuote(items, onlyC, buildMatrix(onlyC, prices, new Set()), 'B');
  assert.equal(q.referenceStoreId, 'C');
  assert.equal(q.totalPaid, 6.9);
  assert.equal(q.comparablePaid, 3.9); // latte + pane
  assert.equal(q.totalReference, 3.6);
  assert.equal(q.lines.find((l) => l.productId === 'caffe').unitReference, null);
});

test('arrotondamento ai centesimi come il database (metà lontano da zero)', () => {
  assert.equal(round2(22.535), 22.54);
  assert.equal(round2(1.005), 1.01);
  assert.equal(round2(-1.005), -1.01);
  assert.equal(round2(2.344), 2.34);
  assert.equal(round2(0.1 + 0.2), 0.3);
});
