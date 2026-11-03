// Unit test della selezione delle offerte da notificare (richiede `npm run build`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { promosFrom, selectOffers, pushText } = require('../services/notification/dist/offers.js');

const stores = [
  { id: 'A', chainId: 'cA', name: 'Negozio A', distanceKm: 1 },
  { id: 'B', chainId: 'cB', name: 'Negozio B', distanceKm: 4 },
];
const frequent = [
  { productId: 'latte', productName: 'Latte' },
  { productId: 'caffe', productName: 'Caffè' },
];

test('promosFrom: solo promo vere con almeno il 10% di sconto', () => {
  const promos = promosFrom([
    { storeId: 'A', productId: 'latte', price: 1.0, promoPrice: 0.8 },
    { storeId: 'A', productId: 'pane', price: 1.0, promoPrice: 0.95 },  // -5%: scartata
    { storeId: 'A', productId: 'uova', price: 2.0, promoPrice: null },
    { storeId: 'A', productId: 'riso', price: 2.0, promoPrice: 2.5 },   // non è uno sconto
  ]);
  assert.deepEqual(promos.map((p) => p.productId), ['latte']);
});

test('selectOffers: migliore offerta per prodotto, solo negozi ammessi e prodotti frequenti', () => {
  const promos = promosFrom([
    { storeId: 'A', productId: 'latte', price: 1.0, promoPrice: 0.8 },
    { storeId: 'B', productId: 'latte', price: 1.0, promoPrice: 0.7 },
    { storeId: 'C', productId: 'caffe', price: 4.0, promoPrice: 2.0 },  // negozio escluso o fuori raggio
    { storeId: 'A', productId: 'birra', price: 1.0, promoPrice: 0.5 },  // non frequente
  ]);
  const offers = selectOffers(promos, frequent, stores, new Set());
  assert.equal(offers.length, 1);
  assert.equal(offers[0].storeName, 'Negozio B');
  assert.equal(offers[0].discountPct, 30);
});

test('selectOffers: promo riservata ai titolari solo con la carta dell\'insegna', () => {
  const promos = promosFrom([{ storeId: 'B', productId: 'caffe', price: 4.0, promoPrice: 3.0, loyaltyOnly: true }]);
  assert.equal(selectOffers(promos, frequent, stores, new Set()).length, 0);
  assert.equal(selectOffers(promos, frequent, stores, new Set(['cB'])).length, 1);
});

test('pushText: un messaggio con l\'offerta migliore e il conteggio delle altre', () => {
  const offers = selectOffers(
    promosFrom([
      { storeId: 'A', productId: 'latte', price: 1.0, promoPrice: 0.8 },
      { storeId: 'A', productId: 'caffe', price: 4.0, promoPrice: 2.0 },
    ]),
    frequent, stores, new Set(),
  );
  const text = pushText(offers);
  assert.equal(text.title, 'Offerte sui prodotti che compri spesso');
  assert.equal(text.body, 'Caffè a 2,00 € (-50%) da Negozio A e un\'altra offerta');
  assert.equal(pushText(offers.slice(1)).title, 'Latte in offerta');
});
