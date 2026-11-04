// Test di latenza dei microservizi: misura p50/p95/p99 delle chiamate che l'app fa davvero,
// prima una alla volta (latenza pura) e poi con più utenti in parallelo (latenza sotto carico).
//
//   npm run latency                       servizi in locale (scripts/dev-local.sh)
//   GATEWAY_URL=http://localhost:8080 npm run latency   attraverso il gateway (Docker Compose; il limite
//                                         di 300 richieste/min per utente va alzato per la durata del test)
//   LATENCY_ROUNDS=300 LATENCY_CONCURRENCY=50 npm run latency
//
// Confronta i risultati con gli obiettivi delle specifiche e termina con codice 1 se uno non è rispettato.
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const GATEWAY = process.env.GATEWAY_URL;
const PORTS = { auth: 3001, user: 3002, store: 3003, catalog: 3004, list: 3005, pricing: 3006, analytics: 3007, notification: 3008 };
const base = (svc) => GATEWAY ?? `http://localhost:${PORTS[svc]}`;
const ROUNDS = Number(process.env.LATENCY_ROUNDS ?? 200);
const CONCURRENCY = Number(process.env.LATENCY_CONCURRENCY ?? 20);
const HOME = { lat: 46.419, lng: 12.245, radiusKm: 25 };

// Obiettivi dalle specifiche (sezione Requisiti non funzionali), in millisecondi al 95° percentile.
const TARGETS = {
  'catalog · autocompletamento': 80,
  'catalog · autocompletamento (senza cache)': 80,
  'pricing · confronto 50 articoli (senza cache)': 1000,
};

async function call(svc, path, { method = 'GET', body, token, expect = 200 } = {}) {
  const res = await fetch(`${base(svc)}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status !== expect && !(expect === 200 && res.status === 201)) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  return { n: s.length, p50: at(50), p95: at(95), p99: at(99), max: s.at(-1), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

/** Misura `fn` per `rounds` volte con `concurrency` richieste contemporanee; `before` non è cronometrato. */
async function measure(fn, { rounds = ROUNDS, concurrency = 1, before } = {}) {
  for (let i = 0; i < 5; i++) await fn(i); // riscaldamento: connessioni, piani delle query, JIT
  const samples = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < rounds) {
        const i = next++;
        if (before) await before(i);
        const t0 = performance.now();
        await fn(i);
        samples.push(performance.now() - t0);
      }
    }),
  );
  const elapsed = (performance.now() - started) / 1000;
  return { ...stats(samples), rps: rounds / elapsed };
}

const results = [];
async function scenario(name, fn, opts) {
  const r = await measure(fn, opts);
  results.push({ name, concurrency: opts?.concurrency ?? 1, ...r });
  process.stdout.write(`  ${name} (×${opts?.concurrency ?? 1}): p95 ${r.p95.toFixed(1)} ms\n`);
}

// ---------- Preparazione: due utenti, una lista di 50 articoli, una spesa registrata ----------
console.log(`Preparazione (${GATEWAY ? 'gateway ' + GATEWAY : 'servizi in locale'}, ${ROUNDS} richieste per scenario)…`);
const email = `latency+${Date.now()}@example.com`;
const reg = await call('auth', '/auth/register', { method: 'POST', body: { email, password: 'password-sicura' } });
const token = reg.accessToken;
for (let i = 0; i < 40; i++) {
  try {
    await call('user', '/users/me', { token });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}

const words = ['latte', 'pane', 'mozzarella', 'banane', 'spaghetti', 'penne', 'passata', 'tonno', 'caffè', 'uova', 'mele',
  'pomodori', 'insalata', 'patate', 'carote', 'pollo', 'riso', 'olio', 'acqua', 'birra', 'yogurt', 'burro', 'grissini',
  'fette biscottate', 'succo', 'piselli', 'pizza', 'carta igienica', 'detersivo piatti', 'parmigiano'];
const list = await call('list', '/lists', { method: 'POST', token, body: { name: 'Lista da 50 articoli' } });
for (let i = 0; i < 50; i++) {
  await call('list', `/lists/${list.id}/items`, { method: 'POST', token, body: { raw: `${1 + (i % 3)} ${words[i % words.length]}` } });
}
const scratch = await call('list', '/lists', { method: 'POST', token, body: { name: 'Lista di prova' } });
// Sotto carico ogni "utente" aggiunge alla propria lista, come nella realtà: la stessa lista è
// serializzata apposta (lock per la posizione degli articoli) e misurerebbe solo l'attesa del lock.
const parallelLists = [];
for (let i = 0; i < CONCURRENCY; i++) {
  parallelLists.push(await call('list', '/lists', { method: 'POST', token, body: { name: `Lista parallela ${i + 1}` } }));
}
const detail = await call('list', `/lists/${list.id}`, { token });
const productId = detail.items.find((i) => i.product)?.product.id;

// Una spesa registrata, così le metriche del profilo hanno dati da leggere.
const first = await call('pricing', '/comparisons', { method: 'POST', token, body: { listId: list.id, mode: 'single_store', ...HOME } });
const throwaway = await call('list', '/lists', { method: 'POST', token, body: { name: 'Spesa passata' } });
for (const w of words.slice(0, 8)) await call('list', `/lists/${throwaway.id}/items`, { method: 'POST', token, body: { raw: w } });
await call('list', `/lists/${throwaway.id}/purchase`, { method: 'POST', token, body: { storeId: first.results[0].storeId, ...HOME } });

// Cache del confronto: cambiando la versione dei listini ogni richiesta è un calcolo completo.
const Redis = require(require.resolve('ioredis', { paths: ['services/pricing'] }));
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379/0');
const bustCache = () => redis.incr('prices:version');

const receipt = ['SUPERRISPARMIO PIEVE', 'LATTE PS 1L   2,58', '  2 x 1,29', 'MOZZ. 125G   0,99', 'PANE CASSETTA   1,69',
  'SPAGHETTI 500G   0,99', 'BANANE   1,01', '  0,534 kg x 1,89 €/kg', 'CAFFE MACINATO   3,79', 'TONNO 3X80G   3,29',
  'TOTALE COMPLESSIVO   14,34'].join('\n');
const terms = ['la', 'lat', 'latt', 'mo', 'mozz', 'pa', 'pas', 'ba', 'spa', 'caf', 'to', 'uo', 'mozarela', 'parmig', 'detersivo'];

// ---------- Scenari: una richiesta alla volta ----------
console.log('\nLatenza pura (una richiesta alla volta):');
for (const svc of Object.keys(PORTS)) {
  if (!GATEWAY) await scenario(`${svc} · /health`, () => fetch(`${base(svc)}/health`).then((r) => r.text()));
}
await scenario('auth · login (argon2)', () => call('auth', '/auth/login', { method: 'POST', body: { email, password: 'password-sicura' } }), { rounds: Math.min(ROUNDS, 60) });
await scenario('user · profilo', () => call('user', '/users/me', { token }));
await scenario('store · negozi vicini', () => call('store', `/stores?lat=${HOME.lat}&lng=${HOME.lng}&radius_km=25`, { token }));
// Termine e numero di risultati sempre diversi: ogni richiesta arriva al database.
const uncachedSuggest = (i) =>
  call('catalog', `/products/suggest?q=${encodeURIComponent(terms[Math.floor(i / 20) % terms.length])}&limit=${1 + (i % 20)}`, { token });
await scenario('catalog · autocompletamento (senza cache)', uncachedSuggest);
await scenario('catalog · autocompletamento', (i) => call('catalog', `/products/suggest?q=${encodeURIComponent(terms[i % terms.length])}`, { token }));
await scenario('list · aggiunta rapida articolo', (i) => call('list', `/lists/${scratch.id}/items`, { method: 'POST', token, body: { raw: `2 ${words[i % words.length]}` } }));
await scenario('list · lista da 50 articoli', () => call('list', `/lists/${list.id}`, { token }));
await scenario('list · lettura scontrino', () => call('list', `/lists/${list.id}/receipt`, { method: 'POST', token, body: { text: receipt } }));
await scenario('pricing · confronto 50 articoli (senza cache)', () =>
  call('pricing', '/comparisons', { method: 'POST', token, body: { listId: list.id, mode: 'single_store', ...HOME } }), { before: bustCache });
await scenario('pricing · confronto 50 articoli (in cache)', () =>
  call('pricing', '/comparisons', { method: 'POST', token, body: { listId: list.id, mode: 'single_store', ...HOME } }));
await scenario('pricing · confronto 2 negozi (senza cache)', () =>
  call('pricing', '/comparisons', { method: 'POST', token, body: { listId: list.id, mode: 'two_stores', ...HOME } }), { before: bustCache });
await scenario('pricing · prezzi di un prodotto', () => call('pricing', `/products/${productId}/prices?lat=${HOME.lat}&lng=${HOME.lng}&radius_km=25`, { token }));
await scenario('analytics · metriche profilo', () => call('analytics', '/users/me/stats?period=all', { token }));
await scenario('notification · offerte per te', () => call('notification', '/notifications', { token }));

// ---------- Scenari: più utenti contemporaneamente ----------
console.log(`\nSotto carico (${CONCURRENCY} richieste contemporanee):`);
await scenario('catalog · autocompletamento (senza cache)', (i) => uncachedSuggest(i + 1000), { concurrency: CONCURRENCY });
await scenario('catalog · autocompletamento', (i) => call('catalog', `/products/suggest?q=${encodeURIComponent(terms[i % terms.length])}`, { token }), { concurrency: CONCURRENCY });
await scenario('list · aggiunta rapida articolo', (i) =>
  call('list', `/lists/${parallelLists[i % parallelLists.length].id}/items`, { method: 'POST', token, body: { raw: words[i % words.length] } }), { concurrency: CONCURRENCY });
await scenario('pricing · confronto 50 articoli (senza cache)', () =>
  call('pricing', '/comparisons', { method: 'POST', token, body: { listId: list.id, mode: 'single_store', ...HOME } }), { concurrency: CONCURRENCY, before: bustCache });
await scenario('analytics · metriche profilo', () => call('analytics', '/users/me/stats?period=all', { token }), { concurrency: CONCURRENCY });

// ---------- Pulizia e risultati ----------
await call('user', '/users/me', { method: 'DELETE', token, expect: 204 });
await redis.quit();

const pad = (s, n) => String(s).padEnd(n);
const num = (v) => v.toFixed(1).padStart(8);
console.log(`\n${pad('Scenario', 50)}${pad('conc.', 6)}${'p50'.padStart(8)}${'p95'.padStart(8)}${'p99'.padStart(8)}${'max'.padStart(8)}${'req/s'.padStart(8)}  obiettivo`);
let failed = 0;
for (const r of results) {
  // Gli obiettivi valgono per la latenza della singola richiesta; sotto carico i valori sono informativi.
  const target = r.concurrency === 1 ? TARGETS[r.name] : undefined;
  const verdict = target ? (r.p95 <= target ? `p95 ≤ ${target} ms ✓` : `p95 ≤ ${target} ms ✗`) : '';
  if (target && r.p95 > target) failed++;
  console.log(`${pad(r.name, 50)}${pad(r.concurrency, 6)}${num(r.p50)}${num(r.p95)}${num(r.p99)}${num(r.max)}${r.rps.toFixed(0).padStart(8)}  ${verdict}`);
}
console.log('\nTempi in millisecondi.');
if (process.env.LATENCY_JSON) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.LATENCY_JSON, JSON.stringify({ at: new Date().toISOString(), rounds: ROUNDS, concurrency: CONCURRENCY, results }, null, 2));
}
process.exit(failed ? 1 : 0);
