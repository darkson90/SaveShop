// Unit test della mappatura categorie Open Food Facts -> catalogo (richiede `npm run build`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mapCategory, packageSize } = require('../services/catalog/dist/categories.js');

test('mapCategory: la regola più specifica vince', () => {
  assert.equal(mapCategory(['en:plant-based-foods', 'en:vegetables', 'en:frozen-foods']), 'Surgelati');
  assert.equal(mapCategory(['en:plant-based-foods', 'en:fresh-vegetables', 'en:lettuces']), 'Frutta e verdura');
  assert.equal(mapCategory(['en:dairies', 'en:cheeses', 'en:mozzarella']), 'Latticini');
  assert.equal(mapCategory(['en:beverages', 'en:plant-based-foods', 'en:fruit-juices', 'en:juices']), 'Bevande');
  assert.equal(mapCategory(['en:cereals-and-potatoes', 'en:pastas', 'en:spaghetti']), 'Dispensa');
});

test('mapCategory: non alimentari e sconosciuti', () => {
  assert.equal(mapCategory(['en:shampoos'], 'obf'), 'Casa e igiene');
  assert.equal(mapCategory([]), 'Dispensa');
  assert.equal(mapCategory(undefined), 'Dispensa');
});

test('packageSize: unità base del catalogo', () => {
  assert.equal(packageSize(160, 'g'), 0.16);
  assert.equal(packageSize(66, 'cl'), 0.66);
  assert.equal(packageSize(1, 'l'), 1);
  assert.equal(packageSize(6, 'pz'), null);
  assert.equal(packageSize(null, 'g'), null);
});

test('categoria indicata dalla fonte (siti dei supermercati)', () => {
  assert.equal(mapCategory(['saveshop:Latticini'], 'carrefour'), 'Latticini');
  assert.equal(mapCategory(['saveshop:Inventata', 'en:beverages'], 'carrefour'), 'Bevande');
});
