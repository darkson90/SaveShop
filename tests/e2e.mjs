// Test end-to-end del percorso principale: registrazione → lista → confronto → spesa → metriche.
// Con Docker: GATEWAY_URL=http://localhost:8080 npm run e2e
// In locale (scripts/dev-local.sh): npm run e2e
import assert from 'node:assert/strict';
import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import WebSocket from 'ws';

const GATEWAY = process.env.GATEWAY_URL;
const PORTS = { auth: 3001, user: 3002, store: 3003, catalog: 3004, list: 3005, pricing: 3006, analytics: 3007, notification: 3008, config: 3009 };
const base = (svc) => GATEWAY ?? `http://localhost:${PORTS[svc]}`;
const HOME = { lat: 46.419, lng: 12.245 }; // Vodo di Cadore, coerente con i dati seed

let token;
async function api(svc, path, { method = 'GET', body, headers = {}, expect = [200, 201, 204], as } = {}) {
  const bearer = as ?? token;
  const res = await fetch(`${base(svc)}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
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
// Regressioni: un token malformato era un errore 500; il logout con il solo id chiudeva la sessione.
await api('auth', '/auth/refresh', { method: 'POST', body: { refreshToken: 'non-un-token' }, expect: [401] });
await api('auth', '/auth/logout', { method: 'POST', body: { refreshToken: `${refreshed.refreshToken.split('.')[0]}.segreto-sbagliato` } });
const stillValid = await api('auth', '/auth/refresh', { method: 'POST', body: { refreshToken: refreshed.refreshToken } });
assert.ok(stillValid.accessToken, 'il logout con un segreto sbagliato non revoca la sessione');
await api('list', '/lists/non-un-uuid', { expect: [400] });
step('rotazione refresh token, token malformati e logout sicuro');

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
// Regressione: due invii simultanei con la stessa chiave davano un errore 500 e due tentativi.
const [c1, c2] = await Promise.all([add('3 tonno', 'k-concorrente'), add('3 tonno', 'k-concorrente')]);
assert.equal(c1.id, c2.id, 'invii simultanei: un solo articolo');
await api('list', `/lists/${list.id}/items/${c1.id}`, { method: 'DELETE' });
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
// Regressione cache: confronto, poi esclusione di un negozio, poi stesso confronto. Prima tornava
// per 15 minuti il risultato in cache con il negozio appena escluso.
const before = await api('pricing', '/comparisons', { method: 'POST', body: { listId: list.id, mode: 'single_store', ...geo } });
const victim = before.results.at(-1);
const tmpExcl = await api('store', '/users/me/excluded-stores', { method: 'POST', body: { storeId: victim.storeId } });
const afterExcl = await api('pricing', '/comparisons', { method: 'POST', body: { listId: list.id, mode: 'single_store', ...geo } });
assert.ok(!afterExcl.results.some((r) => r.storeId === victim.storeId), 'il negozio appena escluso sparisce subito');
await api('store', `/users/me/excluded-stores/${tmpExcl.id}`, { method: 'DELETE' });
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
  // Solo promo dei listini dimostrativi: sono quelli che l'ingestion rilancia qui sotto.
  const demoStore = /^(SuperRisparmio|MercatoPiù|Discount Alpino|Bottega Fresca)/;
  if (res.items.some((p) => p.promo && !p.loyaltyOnly && demoStore.test(p.name))) { promoProduct = id; break; }
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

// 8. Lista condivisa (v1.2): invito, ingresso di un secondo utente, aggiornamenti in tempo reale
const shared = await api('list', '/lists', { method: 'POST', body: { name: 'Spesa di casa' } });
for (const raw of ['2 latte', 'mozzarella', 'spaghetti']) {
  await api('list', `/lists/${shared.id}/items`, { method: 'POST', body: { raw } });
}
const invite = await api('list', `/lists/${shared.id}/invites`, { method: 'POST' });
assert.match(invite.code, /^[A-Z2-9]{6}$/);
assert.ok(invite.url.endsWith(`/i/${invite.code}`), 'link d\'invito');
const landing = await fetch(`${base('list')}/i/${invite.code}`);
assert.equal(landing.status, 200);
assert.ok((await landing.text()).includes(invite.code));
assert.equal((await fetch(`${base('list')}/i/XXXXXX0`)).status, 404);
const assetLinks = await (await fetch(`${base('list')}/.well-known/assetlinks.json`)).json();
assert.equal(assetLinks[0].target.namespace, 'android_app');
const emailB = `test-b+${Date.now()}@example.com`;
const tokenB = (await api('auth', '/auth/register', { method: 'POST', body: { email: emailB, password: 'password-sicura' } })).accessToken;
await api('list', `/lists/${shared.id}`, { as: tokenB, expect: [404] }); // non ancora membro
const joined = await api('list', '/lists/join', { method: 'POST', body: { code: invite.code.toLowerCase() }, as: tokenB });
assert.equal(joined.listId, shared.id);
const listsB = await api('list', '/lists', { as: tokenB });
assert.equal(listsB.items.find((l) => l.id === shared.id)?.role, 'editor');
await api('list', `/lists/${shared.id}`, { method: 'DELETE', as: tokenB, expect: [403] });
await api('list', `/lists/${shared.id}/invites`, { method: 'POST', as: tokenB, expect: [403] });
step(`lista condivisa: codice ${invite.code}, secondo utente entrato come editor, permessi del proprietario rispettati`);

const liveUrl = `${base('list').replace(/^http/, 'ws')}/api/v1/lists/${shared.id}/live`;
const unauthorized = await new Promise((resolve) => {
  const ws = new WebSocket(liveUrl);
  ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
  ws.on('error', () => resolve('error'));
});
assert.equal(unauthorized, 401);
const ws = new WebSocket(liveUrl, { headers: { authorization: `Bearer ${token}` } });
const received = [];
ws.on('message', (m) => received.push(JSON.parse(m.toString())));
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
await eventually(() => assert.ok(received.some((m) => m.op === 'hello')));
const pane = await api('list', `/lists/${shared.id}/items`, { method: 'POST', body: { raw: 'pane' }, as: tokenB });
const signal = await eventually(() => {
  const m = received.find((x) => x.op === 'item.added' && x.itemId === pane.id);
  assert.ok(m, 'segnale item.added ricevuto');
  return m;
});
const detail = await api('list', `/lists/${shared.id}`);
assert.equal(detail.members.length, 2);
assert.equal(detail.items.find((i) => i.id === pane.id).addedBy, signal.by);
step('aggiornamento in tempo reale via WebSocket: il proprietario vede subito l\'articolo aggiunto dall\'altro membro');

// 9. Chiusura spesa con lo scontrino (v1.2): righe lette, abbinate e prezzi pagati effettivi
const receiptText = [
  'SUPERRISPARMIO PIEVE', 'DOCUMENTO COMMERCIALE',
  'LATTE PS 1L          2,38', '  2 x 1,19',
  'MOZZARELLA 125G      0,89',
  'SPAGHETTI 500G       0,95',
  'PANE CASSETTA        1,59',
  'TOTALE COMPLESSIVO   5,81', 'PAGAMENTO ELETTRONICO 5,81',
].join('\n');
const read = await api('list', `/lists/${shared.id}/receipt`, { method: 'POST', body: { text: receiptText } });
assert.equal(read.lines.length, 4);
assert.equal(read.totalMismatch, 0);
assert.ok(read.lines.every((l) => l.match), 'tutte le righe abbinate');
assert.equal(read.unmatchedItems.length, 0);
const target = (await api('pricing', '/comparisons', { method: 'POST', body: { listId: shared.id, mode: 'single_store', ...geo } })).results[0];
const paidPrices = read.lines.map((l) => ({ itemId: l.match.itemId, unitPaid: l.unitPrice }));
// Due membri chiudono la spesa nello stesso momento: deve essere registrata una volta sola.
const closeBody = { method: 'POST', body: { storeId: target.storeId, ...geo, paidPrices }, expect: [200, 201, 409] };
const [r1, r2] = await Promise.all([
  api('list', `/lists/${shared.id}/purchase`, { ...closeBody, as: tokenB }),
  api('list', `/lists/${shared.id}/purchase`, closeBody),
]);
const closed = r1?.purchaseId ? r1 : r2;
assert.ok(!(r1?.purchaseId && r2?.purchaseId), 'una sola chiusura riesce');
assert.equal(closed.pricesFromReceipt, 4);
assert.equal(closed.totalPaid, 5.81);
await eventually(() => assert.ok(received.some((m) => m.op === 'list.purchased')));
ws.close();
step(`scontrino: 4 righe abbinate, pagati ${closed.totalPaid} € (prezzi reali), risparmio ${closed.savedEur} €`);

await api('list', `/lists/${shared.id}/members/${detail.members.find((m) => m.role === 'editor').userId}`, { method: 'DELETE', as: tokenB });
await api('list', `/lists/${shared.id}`, { as: tokenB, expect: [404] });
await api('user', '/users/me', { method: 'DELETE', as: tokenB });
step('il secondo membro esce dalla lista');

// 10. Fonte reale Open Prices, con un server locale che risponde come l'API pubblica
if (process.env.INGESTION_CMD) {
  const fixture = {
    page: 1, pages: 1, size: 100, total: 2,
    items: [
      { product_code: '8000000000101', price: 0.89, price_is_discounted: true, price_without_discount: 1.29, discount_type: 'SALE',
        type: 'PRODUCT', currency: 'EUR', date: new Date().toISOString().slice(0, 10), duplicate_of: null,
        location: { type: 'OSM', osm_id: 999000111, osm_type: 'NODE', osm_name: 'Market Test Vodo', osm_brand: 'Kanguro',
          osm_address_city: 'Vodo di Cadore', osm_lat: 46.4195, osm_lon: 12.2465 },
        product: { product_name: 'Latte parzialmente scremato', categories_tags: ['en:dairies', 'en:milks'], source: 'off' } },
      { product_code: '8099999000017', price: 1.79, price_is_discounted: false, type: 'PRODUCT', currency: 'EUR',
        date: new Date().toISOString().slice(0, 10), duplicate_of: null,
        location: { type: 'OSM', osm_id: 999000111, osm_type: 'NODE', osm_name: 'Market Test Vodo', osm_brand: 'Kanguro',
          osm_address_city: 'Vodo di Cadore', osm_lat: 46.4195, osm_lon: 12.2465 },
        product: { product_name: 'Gnocchi di patate 500 g', brands: 'Esempio', categories_tags: ['en:cereals-and-potatoes', 'en:pastas'],
          product_quantity: 500, product_quantity_unit: 'g', source: 'off' } },
    ],
  };
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(fixture));
  });
  await new Promise((r) => server.listen(3999, r));
  // Esecuzione asincrona: il server locale qui sopra deve poter rispondere mentre l'ingestion gira.
  const run = await promisify(exec)(process.env.INGESTION_CMD, {
    env: { ...process.env, INGESTION_SOURCES: 'open_prices', OPEN_PRICES_URL: 'http://localhost:3999/prices', OPEN_PRICES_LAT: '46.42', OPEN_PRICES_LON: '12.25' },
  });
  process.stdout.write(run.stdout);
  server.close();
  const near = await api('store', `/stores?lat=${HOME.lat}&lng=${HOME.lng}&radius_km=5`);
  const market = near.items.find((s) => s.name === 'Market Test Vodo');
  assert.ok(market, 'negozio OpenStreetMap creato');
  assert.equal(market.chainName, 'Kanguro');
  const gnocchi = await eventually(async () => {
    const r = await api('catalog', '/products/suggest?q=gnocchi');
    assert.ok(r.items[0]?.name.startsWith('Gnocchi'));
    return r.items[0];
  });
  assert.equal(gnocchi.category, 'Dispensa');
  const lattePrices = await eventually(async () => {
    const r = await api('pricing', `/products/0190b000-0000-7000-8000-000000000101/prices?lat=${HOME.lat}&lng=${HOME.lng}&radius_km=5`);
    const m = r.items.find((x) => x.storeId === market.id);
    assert.ok(m, 'prezzo Open Prices disponibile');
    return m;
  });
  assert.deepEqual([lattePrices.unitPrice, lattePrices.promo], [0.89, true]);
  step(`Open Prices: creati "${market.name}" e "${gnocchi.name}", latte in offerta a ${lattePrices.unitPrice} €`);

  // Feed di un negozio partner (docs/feed-format.md)
  const feedRun = await promisify(exec)(process.env.INGESTION_CMD, {
    env: { ...process.env, INGESTION_SOURCES: 'feeds', INGESTION_FEEDS: 'tests/fixtures/feed-esempio.json' },
  });
  process.stdout.write(feedRun.stdout);
  const partner = (await api('store', `/stores?lat=${HOME.lat}&lng=${HOME.lng}&radius_km=5`)).items.find((s) => s.name === 'Alimentari Rossi Vodo');
  assert.ok(partner, 'negozio del feed creato');
  const piave = await eventually(async () => {
    const r = await api('catalog', '/products/suggest?q=piave');
    assert.equal(r.items[0]?.category, 'Latticini');
    return r.items[0];
  });
  const piavePrices = await eventually(async () => {
    const r = await api('pricing', `/products/${piave.id}/prices?lat=${HOME.lat}&lng=${HOME.lng}&radius_km=5`);
    assert.ok(r.items.length);
    return r.items;
  });
  assert.equal(piavePrices[0].unitPrice, 4.2);
  step(`feed partner: "${partner.name}" con "${piave.name}" a ${piavePrices[0].unitPrice} €`);
}

// 10. Pannello parametri: riservato agli amministratori, modifiche applicate dai servizi senza riavvio
{
  const ADMIN = { email: process.env.ADMIN_EMAIL ?? 'admin@saveshop.test', password: process.env.ADMIN_PASSWORD ?? 'password-admin' };
  await api('config', '/admin/settings', { expect: [403] }); // utente normale
  await api('config', '/admin/login', { method: 'POST', body: { email, password: 'password-sicura' }, expect: [403] });
  await api('auth', '/auth/register', { method: 'POST', body: ADMIN, expect: [201, 409] });
  const admin = { as: (await api('config', '/admin/login', { method: 'POST', body: ADMIN })).accessToken };
  const all = await api('config', '/admin/settings', admin);
  assert.ok(all.groups.length >= 5 && all.settings.length >= 20);
  const leftovers = all.settings.filter((s) => s.modified).map((s) => s.key);
  if (leftovers.length) await api('config', '/admin/settings', { method: 'PATCH', body: { reset: leftovers }, ...admin });

  // Tutto o niente: un valore non valido blocca anche quelli validi.
  const bad = await fetch(`${base('config')}/api/v1/admin/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.as}` },
    body: JSON.stringify({ values: { 'lists.inviteTtlHours': 6, 'lists.maxMembers': 0 } }),
  });
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.match(badBody.detail ?? badBody.message ?? '', /membri/i);
  assert.equal((await api('config', '/admin/settings', admin)).settings.find((s) => s.key === 'lists.inviteTtlHours').modified, false);

  // Validità degli inviti: il List Service la applica appena riceve il segnale.
  await api('config', '/admin/settings', { method: 'PATCH', body: { values: { 'lists.inviteTtlHours': 6 } }, ...admin });
  const ttl = await eventually(async () => {
    const inv = await api('list', `/lists/${shared.id}/invites`, { method: 'POST' });
    const hours = (new Date(inv.expiresAt).getTime() - Date.now()) / 3.6e6;
    assert.ok(hours > 5.5 && hours < 6.5, `scadenza invito tra ${hours.toFixed(1)} h`);
    return hours;
  });

  // Registrazioni chiuse e avviso nell'app.
  await api('config', '/admin/settings', { method: 'PATCH', body: { values: { 'auth.registrationOpen': false, 'app.maintenanceMessage': 'Manutenzione stasera alle 22' } }, ...admin });
  await eventually(() => api('auth', '/auth/register', { method: 'POST', body: { email: `chiuso+${Date.now()}@example.com`, password: 'password-sicura' }, expect: [403] }));
  const pub = await api('config', '/config/public', { as: '' });
  assert.equal(pub.values['app.maintenanceMessage'], 'Manutenzione stasera alle 22');
  const audit = await api('config', '/admin/audit?limit=5', admin);
  assert.equal(audit.items[0].changedBy, ADMIN.email);
  assert.ok(audit.items.some((i) => i.key === 'lists.inviteTtlHours' && i.newValue === 6 && i.wasDefault));

  // Ripristino dei predefiniti.
  const restored = await api('config', '/admin/settings', { method: 'PATCH', body: { reset: ['lists.inviteTtlHours', 'auth.registrationOpen', 'app.maintenanceMessage'] }, ...admin });
  assert.ok(restored.settings.every((s) => !s.modified));
  await eventually(() => api('auth', '/auth/register', { method: 'POST', body: { email: `aperto+${Date.now()}@example.com`, password: 'password-sicura' }, expect: [201] }));

  const status = await api('config', '/admin/status', admin);
  assert.ok(status.services.every((s) => s.ok), `servizi non attivi: ${status.services.filter((s) => !s.ok).map((s) => s.name)}`);
  const page = await fetch(`${base('config')}/admin/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.ok((await page.text()).includes('app.js'));
  step(`pannello parametri: solo admin, inviti a ${Math.round(ttl)} h applicati subito, registrazioni chiuse e riaperte, ${status.services.length} servizi attivi`);
}

// 11. Ripristino negozio e cancellazione account
await api('store', `/users/me/excluded-stores/${excl.id}`, { method: 'DELETE' });
await api('user', '/users/me', { method: 'DELETE' });
await eventually(() => api('auth', '/auth/login', { method: 'POST', body: { email, password: 'password-sicura' }, expect: [401] }));
step('cancellazione account propagata (GDPR)');

console.log('\nTutti i controlli end-to-end sono passati.');
