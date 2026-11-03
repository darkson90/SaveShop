// Test end-to-end del percorso principale: registrazione → lista → confronto → spesa → metriche.
// Con Docker: GATEWAY_URL=http://localhost:8080 npm run e2e
// In locale (scripts/dev-local.sh): npm run e2e
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const GATEWAY = process.env.GATEWAY_URL;
const PORTS = { auth: 3001, user: 3002, store: 3003, catalog: 3004, list: 3005, pricing: 3006, analytics: 3007, notification: 3008 };
const base = (svc) => GATEWAY ?? `http://localhost:${PORTS[svc]}`;
const HOME = { lat: 46.419, lng: 12.245 }; // Vodo di Cadore, coerente con i dati seed

let token;
async function api(svc, path, { method = 'GET', body, headers = {}, expect = [200, 201, 204] } = {}) {
  const res = await fetch(`${base(svc)}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!expect.includes(res.status)) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return data;
}
const eventually = async (fn, tries = 40) => {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) { if (i >= tries) throw err; await new Promise((r) => setTimeout(r, 250)); }
  }
};
const step = (msg) => console.log(`✓ ${msg}`);

// 1. Registrazione e profilo (creato in modo asincrono dall'evento UserRegistered)
const email = `test+${Date.now()}@example.com`;
const reg = await api('auth', '/auth/register', { method: 'POST', body: { email, password: 'password-sicura', displayName: 'Stefano' } });
token = reg.accessToken;
const me = await eventually(() => api('user', '/users/me'));
assert.equal(me.email, email);
step('registrazione e profilo');

const refreshed = await api('auth', '/auth/refresh', { method: 'POST', body: { refreshToken: reg.refreshToken } });
assert.ok(refreshed.accessToken);
await api('auth', '/auth/refresh', { method: 'POST', body: { refreshToken: reg.refreshToken }, expect: [401] });
step('rotazione refresh token');

// 2. Autocompletamento
const sug = await api('catalog', '/products/suggest?q=mozz');
assert.equal(sug.items[0].name, 'Mozzarella 125 g');
step(`autocompletamento: "mozz" → ${sug.items[0].name}`);

// 3. Lista con inserimento rapido
const list = await api('list', '/lists', { method: 'POST', body: { name: 'Spesa settimanale' } });
const add = (raw, key) => api('list', `/lists/${list.id}/items`, { method: 'POST', body: { raw }, headers: key ? { 'idempotency-key': key } : {} });
const latte = await add('2 latte', 'k-latte');
assert.equal(latte.quantity, 2);
assert.equal(latte.product.name, 'Latte parz. scremato 1 l');
const again = await add('2 latte', 'k-latte');
assert.equal(again.id, latte.id, 'idempotenza');
const spaghetti = await add('spaghetti 500 g');
assert.equal(spaghetti.quantity, 1);
const banane = await add('banane 1,5 kg');
assert.equal(banane.quantity, 1.5);
const typo = await add('mozarela x3');
assert.equal(typo.product?.name, 'Mozzarella 125 g');
assert.equal(typo.quantity, 3);
const libero = await add('candeline compleanno');
assert.equal(libero.product, null);
for (const raw of ['passata', 'tonno', 'caffè', 'uova', 'pane']) await add(raw);
step('inserimento rapido, parser quantità, idempotenza, voce libera');

const freq = await api('list', '/lists/frequent-products');
assert.ok(freq.items.length >= 5);
step('chip "Compri spesso"');

// 4. Negozi e blacklist
const stores = await api('store', `/stores?lat=${HOME.lat}&lng=${HOME.lng}&radius_km=25`);
assert.ok(stores.items.length >= 5);
const cortina = stores.items.find((s) => s.name.includes('Cortina'));
const excl = await api('store', '/users/me/excluded-stores', { method: 'POST', body: { storeId: cortina.id } });
const after = await api('store', `/stores?lat=${HOME.lat}&lng=${HOME.lng}&radius_km=25`);
assert.equal(after.items.length, stores.items.length - 1);
assert.ok(!after.items.some((s) => s.id === cortina.id));
step(`blacklist: escluso "${cortina.name}"`);

// 5. Confronto prezzi nelle tre modalità
const geo = { lat: HOME.lat, lng: HOME.lng, radiusKm: 25 };
const single = await api('pricing', '/comparisons', { method: 'POST', body: { listId: list.id, mode: 'single_store', ...geo } });
assert.ok(single.results.length >= 1);
assert.ok(!single.results.some((r) => r.storeId === cortina.id), 'il negozio escluso non compare');
assert.equal(single.unmatchedItems, 1);
const best = single.results[0];
const two = await api('pricing', '/comparisons', { method: 'POST', body: { listId: list.id, mode: 'two_stores', ...geo } });
const per = await api('pricing', '/comparisons', { method: 'POST', body: { listId: list.id, mode: 'per_item', ...geo } });
assert.ok(per.result.total <= best.total + 0.001 || per.result.missingItems < best.missingItems);
const cachedAgain = await api('pricing', '/comparisons', { method: 'POST', body: { listId: list.id, mode: 'single_store', ...geo } });
assert.equal(cachedAgain.cached, true);
step(`confronto: migliore "${best.name}" ${best.total} € (mancanti ${best.missingItems}), 2 negozi ${two.results[0]?.total ?? '-'} €, per articolo ${per.result.total} €`);

const prices = await api('pricing', `/products/${latte.product.id}/prices?lat=${HOME.lat}&lng=${HOME.lng}&radius_km=25`);
assert.ok(prices.items.length >= 1);
step('prezzi di un prodotto nei negozi vicini');

// 6. Chiusura spesa e metriche del profilo
const purchase = await api('list', `/lists/${list.id}/purchase`, { method: 'POST', body: { storeId: best.storeId, ...geo } });
assert.equal(purchase.totalPaid, best.total, 'si paga il totale mostrato nel confronto');
assert.ok(Number.isFinite(purchase.savedEur) && Number.isFinite(purchase.savedPct));
step(`spesa chiusa: pagati ${purchase.totalPaid} €, risparmio ${purchase.savedEur} € (${purchase.savedPct}%)`);

const stats = await eventually(async () => {
  const s = await api('analytics', '/users/me/stats?period=all');
  assert.equal(s.purchases, 1);
  return s;
});
assert.equal(stats.totalSavedEur, purchase.savedEur);
assert.equal(stats.topProducts.length, 3);
assert.ok(stats.categories.length >= 3);
const shares = stats.categories.reduce((s, c) => s + c.sharePct, 0);
assert.ok(Math.abs(shares - 100) < 0.5);
step(`metriche: risparmio ${stats.totalSavedEur} €, medio ${stats.avgSavingPct}%, top 3 ${stats.topProducts.map((p) => p.name).join(', ')}`);

// 7. Notifiche offerte (v1.1): consenso, posizione di casa, prodotto frequente in promo
await api('user', '/users/me', { method: 'PATCH', body: { home: HOME, defaultRadiusKm: 25 } });
assert.equal((await api('notification', '/notifications/preferences')).offersEnabled, false, 'consenso esplicito, spento di default');
await api('notification', '/notifications/preferences', { method: 'PATCH', body: { offersEnabled: true } });
await api('notification', '/notifications/devices', { method: 'PUT', body: { token: `e2e-${Date.now()}`, platform: 'android' } });
await api('store', '/users/me/excluded-stores', { method: 'POST', body: { storeId: cortina.id }, expect: [409] }); // già escluso
const ids = Array.from({ length: 32 }, (_, i) => `0190b000-0000-7000-8000-000000000${101 + i}`);
let promoProduct;
for (const id of ids) {
  const res = await api('pricing', `/products/${id}/prices?lat=${HOME.lat}&lng=${HOME.lng}&radius_km=25`);
  if (res.items.some((p) => p.promo && !p.loyaltyOnly)) { promoProduct = id; break; }
}
assert.ok(promoProduct, 'i listini dimostrativi contengono almeno una promo');
const list2 = await api('list', '/lists', { method: 'POST', body: { name: 'Seconda spesa' } });
for (let i = 0; i < 2; i++) await api('list', `/lists/${list2.id}/items`, { method: 'POST', body: { productId: promoProduct } });
step('consenso alle offerte, dispositivo registrato, prodotto in promo aggiunto 2 volte');

if (process.env.INGESTION_CMD) {
  await new Promise((r) => setTimeout(r, 1500)); // il relay dell'outbox inoltra ItemAdded
  execSync(process.env.INGESTION_CMD, { stdio: 'inherit' });
  const inbox = await eventually(async () => {
    const res = await api('notification', '/notifications');
    assert.ok(res.items.some((n) => n.productId === promoProduct), 'offerta segnalata');
    return res;
  });
  assert.ok(!inbox.items.some((n) => n.storeId === cortina.id), 'nessuna offerta dal negozio escluso');
  execSync(process.env.INGESTION_CMD, { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1500));
  const again = await api('notification', '/notifications');
  assert.equal(again.items.length, inbox.items.length, 'nessun doppione alla seconda esecuzione');
  await api('notification', '/notifications/read', { method: 'POST' });
  assert.equal((await api('notification', '/notifications')).unread, 0);
  step(`offerte per te: ${inbox.items.length} (es. ${inbox.items[0].productName} a ${inbox.items[0].promoPrice} € da ${inbox.items[0].storeName}), nessun doppione`);
} else {
  console.log('… notifiche: imposta INGESTION_CMD per verificare la segnalazione delle offerte');
}

// Gli endpoint interni non accettano chiamate senza token di servizio
const internal = await fetch(`${base('catalog')}/api/v1/internal/products/eans`);
assert.ok([401, 404].includes(internal.status));
step('endpoint interni protetti');

// 8. Ripristino negozio e cancellazione account
await api('store', `/users/me/excluded-stores/${excl.id}`, { method: 'DELETE' });
await api('user', '/users/me', { method: 'DELETE' });
await eventually(() => api('auth', '/auth/login', { method: 'POST', body: { email, password: 'password-sicura' }, expect: [401] }));
step('cancellazione account propagata (GDPR)');

console.log('\nTutti i controlli end-to-end sono passati.');
