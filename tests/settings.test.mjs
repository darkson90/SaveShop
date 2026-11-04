// Unit test dei parametri modificabili dal pannello (richiede `npm run build`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SETTINGS, SETTINGS_BY_KEY, SETTING_GROUPS, validateSetting, envValue, settings, radiusKm } = require('../packages/common/dist/index.js');

const def = (key) => SETTINGS_BY_KEY.get(key);

test('ogni parametro ha un gruppo esistente, chiave unica e un predefinito valido', () => {
  const groups = new Set(SETTING_GROUPS.map((g) => g.id));
  assert.equal(SETTINGS_BY_KEY.size, SETTINGS.length);
  for (const s of SETTINGS) {
    assert.ok(groups.has(s.group), `${s.key}: gruppo ${s.group}`);
    assert.ok(s.label && s.description, `${s.key}: etichetta e descrizione`);
    assert.deepEqual(validateSetting(s, s.default), s.default, `${s.key}: predefinito fuori dai limiti`);
  }
});

test('numeri: tipo e limiti', () => {
  assert.equal(validateSetting(def('lists.maxMembers'), 8), 8);
  assert.throws(() => validateSetting(def('lists.maxMembers'), 2.5), /intero/);
  assert.throws(() => validateSetting(def('lists.maxMembers'), '5'), /intero/);
  assert.throws(() => validateSetting(def('geo.maxRadiusKm'), 1000), /al massimo/);
  assert.throws(() => validateSetting(def('catalog.minSearchScore'), 0.1), /almeno/);
  assert.equal(validateSetting(def('catalog.minSearchScore'), 0.450000001), 0.45);
});

test('testo, versione, scelte ed elenchi', () => {
  assert.equal(validateSetting(def('app.maintenanceMessage'), '  Manutenzione stasera  '), 'Manutenzione stasera');
  assert.throws(() => validateSetting(def('app.maintenanceMessage'), 'x'.repeat(301)), /300/);
  assert.equal(validateSetting(def('app.minSupportedVersion'), '1.2.3'), '1.2.3');
  assert.throws(() => validateSetting(def('app.minSupportedVersion'), '1.2'), /1\.2\.3/);
  assert.deepEqual(validateSetting(def('ingestion.sources'), ['demo', 'demo', 'feeds']), ['demo', 'feeds']);
  assert.throws(() => validateSetting(def('ingestion.sources'), ['ftp']), /non ammesso/);
  assert.deepEqual(validateSetting(def('ingestion.feeds'), [' https://a.example/x.csv ', '']), ['https://a.example/x.csv']);
  assert.throws(() => validateSetting(def('ingestion.feeds'), ['http://a.example/x.csv']), /https/);
  assert.throws(() => validateSetting(def('offers.enabled'), 'true'), /vero o falso/);
});

test('precedenza: pannello, poi variabile d\'ambiente, poi predefinito', () => {
  const d = def('pricing.priceMaxAgeDays');
  assert.equal(envValue(d, { PRICE_MAX_AGE_DAYS: '30' }), 30);
  assert.equal(envValue(d, { PRICE_MAX_AGE_DAYS: 'abc' }), undefined);
  assert.equal(envValue(d, {}), undefined);

  const before = process.env.PRICE_MAX_AGE_DAYS;
  process.env.PRICE_MAX_AGE_DAYS = '30';
  try {
    settings.apply({});
    assert.equal(settings.num('pricing.priceMaxAgeDays'), 30);
    settings.apply({ 'pricing.priceMaxAgeDays': 90 });
    assert.equal(settings.num('pricing.priceMaxAgeDays'), 90);
    // Un valore non più valido (es. limiti cambiati) si ignora.
    settings.apply({ 'pricing.priceMaxAgeDays': -1, 'parametro.inesistente': 1 });
    assert.equal(settings.num('pricing.priceMaxAgeDays'), 30);
  } finally {
    if (before === undefined) delete process.env.PRICE_MAX_AGE_DAYS; else process.env.PRICE_MAX_AGE_DAYS = before;
    settings.apply({});
  }
});

test('raggio: predefinito, massimo e valori non validi', () => {
  settings.apply({ 'geo.defaultRadiusKm': 8, 'geo.maxRadiusKm': 20 });
  try {
    assert.equal(radiusKm(undefined), 8);
    assert.equal(radiusKm('12'), 12);
    assert.equal(radiusKm(50), 20); // oltre il massimo: ridotto, non errore
    assert.throws(() => radiusKm(0), /raggio/);
    assert.throws(() => radiusKm('abc'), /raggio/);
    settings.apply({ 'geo.defaultRadiusKm': 30, 'geo.maxRadiusKm': 15 });
    assert.equal(radiusKm(undefined), 15);
  } finally {
    settings.apply({});
  }
});
