/* Pannello parametri SaveShop: pagina statica, nessuna dipendenza.
   Parla solo con le API della stessa origine (/api/v1/admin/*); il DOM si costruisce con
   textContent, mai con HTML preso dai dati. Le credenziali restano in sessionStorage. */
'use strict';

const API = '/api/v1';
const STORE_KEY = 'saveshop-admin';
const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  session: null, // { accessToken, refreshToken, email }
  groups: [],
  settings: [],
  byKey: new Map(),
  drafts: new Map(), // key → valore da salvare
  resets: new Set(), // key da riportare al predefinito
  errors: new Map(), // key → messaggio
  status: null,
};

// ---------- Sessione e chiamate ----------

function loadSession() {
  try { state.session = JSON.parse(sessionStorage.getItem(STORE_KEY) || 'null'); } catch { state.session = null; }
}
function saveSession(s) {
  state.session = s;
  try { s ? sessionStorage.setItem(STORE_KEY, JSON.stringify(s)) : sessionStorage.removeItem(STORE_KEY); } catch { /* solo in memoria */ }
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && state.session) headers.Authorization = `Bearer ${state.session.accessToken}`;
  let res;
  try {
    res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'Il server non risponde. Controlla la connessione e riprova.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = Array.isArray(data.message) ? data.message.join('; ') : data.message || data.detail || `Errore ${res.status}`;
    throw new ApiError(res.status, msg);
  }
  return data;
}

let refreshing = null;
async function api(path, opts) {
  try {
    return await request(path, opts);
  } catch (err) {
    if (err.status !== 401 || !state.session?.refreshToken) throw err;
    // Accesso scaduto: un solo rinnovo alla volta, poi si ripete la chiamata.
    refreshing ??= request('/admin/refresh', { method: 'POST', body: { refreshToken: state.session.refreshToken }, auth: false })
      .then((r) => saveSession({ ...state.session, accessToken: r.accessToken, refreshToken: r.refreshToken }))
      .finally(() => { refreshing = null; });
    try {
      await refreshing;
    } catch {
      logout('Sessione scaduta: accedi di nuovo.');
      throw err;
    }
    return request(path, opts);
  }
}

// ---------- Formattazione ----------

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function formatValue(def, v) {
  if (!def) return JSON.stringify(v);
  switch (def.type) {
    case 'bool': return v ? 'attivo' : 'disattivato';
    case 'choices': {
      const labels = (v || []).map((x) => def.options?.find((o) => o.value === x)?.label ?? x);
      return labels.length ? labels.join(', ') : 'nessuna';
    }
    case 'list': return v?.length ? `${v.length} ${v.length === 1 ? 'elemento' : 'elementi'}` : 'nessuno';
    case 'text': return v ? `“${v.length > 40 ? v.slice(0, 40) + '…' : v}”` : 'vuoto';
    case 'version': return v;
    default: {
      const n = Number(v).toLocaleString('it-IT', { maximumFractionDigits: 2 });
      return def.unit ? `${n} ${def.unit}` : n;
    }
  }
}

const dateFmt = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function when(iso) { return iso ? dateFmt.format(new Date(iso)) : ''; }

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

let toastTimer;
function toast(message, bad = false) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('bad', bad);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 6000 : 3000);
}

// ---------- Bozze e validazione ----------

/** Valore mostrato nel controllo: la bozza se c'è, il predefinito se si sta ripristinando, altrimenti quello attuale. */
function shownValue(s) {
  if (state.drafts.has(s.key)) return state.drafts.get(s.key);
  if (state.resets.has(s.key)) return s.default;
  return s.value;
}

function validate(def, v) {
  if (def.type === 'int' || def.type === 'float') {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 'Inserisci un numero';
    if (def.type === 'int' && !Number.isInteger(v)) return 'Inserisci un numero intero';
    if (def.min !== undefined && v < def.min) return `Il minimo è ${formatValue(def, def.min)}`;
    if (def.max !== undefined && v > def.max) return `Il massimo è ${formatValue(def, def.max)}`;
  }
  if (def.type === 'version' && !/^\d+\.\d+\.\d+$/.test(v)) return 'Usa il formato 1.2.3';
  if (def.type === 'choices' && !v.length) return 'Scegli almeno una voce';
  if (def.type === 'list') {
    const bad = v.find((u) => !/^https:\/\/[^\s]+$/.test(u));
    if (bad) return `Indirizzo non valido: ${bad} (serve https://)`;
  }
  if (def.type === 'text' && v.length > 300) return 'Al massimo 300 caratteri';
  return null;
}

function setDraft(s, v) {
  state.resets.delete(s.key);
  const err = validate(s, v);
  if (err) state.errors.set(s.key, err); else state.errors.delete(s.key);
  if (same(v, s.value) && !err) state.drafts.delete(s.key); else state.drafts.set(s.key, v);
  refreshRow(s.key);
  updateChrome();
}

function resetToDefault(s) {
  state.drafts.delete(s.key);
  state.errors.delete(s.key);
  if (s.modified) state.resets.add(s.key);
  refreshRow(s.key, true);
  updateChrome();
}

function undoRow(s) {
  state.drafts.delete(s.key);
  state.resets.delete(s.key);
  state.errors.delete(s.key);
  refreshRow(s.key, true);
  updateChrome();
}

const dirtyCount = () => state.drafts.size + state.resets.size;

// ---------- Controlli per tipo ----------

function control(s) {
  const v = shownValue(s);
  const id = `f-${s.key}`;
  const invalid = state.errors.has(s.key) ? 'true' : undefined;
  const described = `${id}-desc`;

  if (s.type === 'int' || s.type === 'float') {
    const input = el('input', {
      id, type: 'number', inputmode: s.type === 'int' ? 'numeric' : 'decimal',
      min: s.min, max: s.max, step: s.step ?? (s.type === 'int' ? 1 : 'any'),
      value: String(v), 'aria-invalid': invalid, 'aria-describedby': described,
      oninput: (e) => setDraft(s, e.target.value === '' ? NaN : Number(String(e.target.value).replace(',', '.'))),
    });
    const plain = (n) => Number(n).toLocaleString('it-IT', { maximumFractionDigits: 2 });
    const range = s.min !== undefined && s.max !== undefined ? `Tra ${plain(s.min)} e ${plain(s.max)}${s.unit ? ' ' + s.unit : ''}` : null;
    return [el('div', { class: 'num' }, input, s.unit ? el('span', { class: 'unit', text: s.unit }) : null), range ? el('span', { class: 'range', text: range }) : null];
  }
  if (s.type === 'bool') {
    return [el('label', { class: 'switch', for: id },
      el('input', { id, type: 'checkbox', role: 'switch', checked: !!v, 'aria-describedby': described, onchange: (e) => setDraft(s, e.target.checked) }),
      el('span', { class: 'track', 'aria-hidden': 'true' }),
      el('span', { text: v ? 'Attivo' : 'Disattivato' }))];
  }
  if (s.type === 'choices') {
    return [el('fieldset', { class: 'choices', 'aria-describedby': described, style: null },
      el('legend', { class: 'sr-only', text: s.label }),
      (s.options || []).map((o) => el('label', {},
        el('input', {
          type: 'checkbox', value: o.value, checked: v.includes(o.value),
          onchange: (e) => {
            const cur = new Set(shownValue(s));
            e.target.checked ? cur.add(o.value) : cur.delete(o.value);
            setDraft(s, s.options.map((x) => x.value).filter((x) => cur.has(x)));
          },
        }),
        o.label)))];
  }
  if (s.type === 'list') {
    return [el('textarea', {
      id, rows: 3, spellcheck: 'false', placeholder: 'https://… (uno per riga)', 'aria-invalid': invalid, 'aria-describedby': described,
      oninput: (e) => setDraft(s, e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)),
    }, v.join('\n'))];
  }
  if (s.type === 'text') {
    return [el('textarea', {
      id, rows: 2, maxlength: 300, placeholder: 'Nessun messaggio', 'aria-invalid': invalid, 'aria-describedby': described,
      oninput: (e) => setDraft(s, e.target.value),
    }, v)];
  }
  // version
  return [el('input', {
    id, type: 'text', value: v, inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', placeholder: '1.2.3',
    'aria-invalid': invalid, 'aria-describedby': described, oninput: (e) => setDraft(s, e.target.value.trim()),
  })];
}

function settingRow(s) {
  const dirty = state.drafts.has(s.key) || state.resets.has(s.key);
  const resetting = state.resets.has(s.key);
  const descId = `f-${s.key}-desc`;

  const meta = el('div', { class: 'meta' },
    el('span', {}, 'Chiave ', el('code', { text: s.key })),
    el('span', { text: `Usato da ${s.services.join(', ')}` }),
    s.env ? el('span', {}, 'Variabile ', el('code', { text: s.env })) : null,
    s.public ? el('span', { text: 'Letto dall\'app' }) : null);

  const side = [];
  if (resetting) {
    side.push(el('span', { class: 'changed-by', text: `Tornerà al predefinito (${formatValue(s, s.default)}) al salvataggio` }));
  } else if (s.modified && !state.drafts.has(s.key)) {
    side.push(el('span', { class: 'pricetag', title: 'Modificato rispetto al predefinito' },
      el('s', { text: formatValue(s, s.default) }), formatValue(s, s.value)));
    side.push(el('span', { class: 'changed-by', text: `${s.updatedBy || 'sconosciuto'}, ${when(s.updatedAt)}` }));
  }
  if (state.errors.has(s.key)) side.push(el('span', { class: 'field-error', role: 'alert', text: state.errors.get(s.key) }));

  const actions = el('div', { class: 'row-actions' },
    dirty ? el('button', { class: 'btn small', type: 'button', onclick: () => undoRow(s), text: 'Annulla modifica' }) : null,
    (s.modified || state.drafts.has(s.key)) && !resetting && !same(shownValue(s), s.default)
      ? el('button', { class: 'btn small ghost', type: 'button', onclick: () => resetToDefault(s), text: 'Ripristina predefinito' })
      : null);

  return el('div', { class: `setting${dirty ? ' dirty' : ''}`, id: `row-${s.key}`, 'data-key': s.key },
    el('div', { class: 'setting-text' },
      el('h3', {}, el('label', { for: `f-${s.key}`, text: s.label })),
      el('p', { class: 'desc', id: descId, text: s.description }),
      meta),
    el('div', { class: 'control' }, control(s), side, actions.childElementCount ? actions : null));
}

/** Ridisegna una riga; se si sta scrivendo nel campo, quel campo resta lo stesso (fuoco e cursore intatti). */
function refreshRow(key, force = false) {
  const old = document.getElementById(`row-${key}`);
  if (!old) return;
  const active = document.activeElement;
  const inside = active && old.contains(active);
  const keepField = !force && inside && active.id && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && active.type !== 'checkbox'));
  let sel = null;
  if (keepField) { try { sel = [active.selectionStart, active.selectionEnd]; } catch { sel = null; } }
  const focusValue = inside && active.type === 'checkbox' ? active.value : null;
  const fresh = settingRow(state.byKey.get(key));
  if (keepField) {
    const slot = fresh.querySelector(`#${CSS.escape(active.id)}`);
    active.setAttribute('aria-invalid', state.errors.has(key) ? 'true' : 'false');
    slot?.replaceWith(active);
  }
  old.replaceWith(fresh);
  if (keepField) {
    active.focus({ preventScroll: true });
    if (sel && sel[0] !== null) { try { active.setSelectionRange(sel[0], sel[1]); } catch { /* campi numerici */ } }
  } else if (inside) {
    const target = focusValue !== null
      ? [...fresh.querySelectorAll('input[type=checkbox]')].find((i) => i.value === focusValue)
      : fresh.querySelector(active.id ? `#${CSS.escape(active.id)}` : 'button');
    (target || fresh.querySelector('input, textarea, button'))?.focus({ preventScroll: true });
  }
}

// ---------- Viste ----------

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [view, arg] = hash.split('/');
  return { view: view || 'panoramica', arg: arg ? decodeURIComponent(arg) : null };
}

function renderSidebar() {
  const { view, arg } = route();
  const nav = $('#sidebar');
  const link = (href, label, current, count) => el('a', { href, 'aria-current': current ? 'page' : null },
    el('span', { text: label }), count ? el('span', { class: 'count', title: `${count} modificati`, text: String(count) }) : null);
  nav.replaceChildren(
    link('#/panoramica', 'Panoramica', view === 'panoramica'),
    el('h2', { text: 'Parametri' }),
    ...state.groups.map((g) => link(`#/gruppo/${g.id}`, g.label, view === 'gruppo' && arg === g.id,
      state.settings.filter((s) => s.group === g.id && s.modified).length)),
    el('h2', { text: 'Dati' }),
    link('#/prezzi', 'Prezzi raccolti', view === 'prezzi'),
    el('h2', { text: 'Storico' }),
    link('#/registro', 'Registro modifiche', view === 'registro'));
}

function pageHead(title, text) {
  return el('div', { class: 'page-head' }, el('h1', { text: title }), text ? el('p', { text }) : null);
}

function renderGroup(groupId) {
  const g = state.groups.find((x) => x.id === groupId);
  if (!g) return renderOverview();
  const items = state.settings.filter((s) => s.group === groupId);
  $('#content').replaceChildren(pageHead(g.label, g.description), el('section', { class: 'group' }, items.map(settingRow)));
}

function renderSearch(q) {
  const needle = q.toLowerCase();
  const found = state.settings.filter((s) => [s.label, s.description, s.key, s.env || ''].some((t) => t.toLowerCase().includes(needle)));
  const content = $('#content');
  content.replaceChildren(pageHead(`Risultati per “${q}”`, found.length ? `${found.length} parametri trovati.` : null));
  if (!found.length) {
    content.append(el('p', { class: 'empty', text: 'Nessun parametro corrisponde. Prova con un\'altra parola, ad esempio “raggio” o “notifiche”.' }));
    return;
  }
  for (const g of state.groups) {
    const items = found.filter((s) => s.group === g.id);
    if (items.length) content.append(el('section', { class: 'group' }, el('h2', { text: g.label }), items.map(settingRow)));
  }
}

async function renderOverview() {
  const content = $('#content');
  const modified = state.settings.filter((s) => s.modified);
  const statusList = el('ul', { class: 'status-list', 'aria-busy': 'true' }, el('li', {}, el('span'), el('span', { class: 'detail', text: 'Controllo dei servizi…' }), el('span')));
  const upCount = el('strong', { text: '…' });
  const refresh = el('button', { class: 'btn small', type: 'button', text: 'Ricontrolla', onclick: () => loadStatus() });

  content.replaceChildren(
    pageHead('Panoramica', 'Stato dei servizi e parametri diversi dal predefinito. Le modifiche salvate arrivano ai servizi in pochi secondi, senza riavvii.'),
    el('div', { class: 'summary' },
      el('div', {}, upCount, el('span', { text: 'servizi attivi' })),
      el('div', {}, el('strong', { text: String(modified.length) }), el('span', { text: 'parametri modificati' })),
      el('div', {}, el('strong', { text: String(state.settings.length) }), el('span', { text: 'parametri in tutto' }))),
    el('div', { class: 'section-head' }, el('h2', { text: 'Servizi' }), refresh),
    statusList,
    el('div', { class: 'section-head' }, el('h2', { text: 'Parametri modificati' })),
    modified.length
      ? el('ul', { class: 'modified-list' }, modified.map((s) => el('li', {},
        el('a', { href: `#/gruppo/${s.group}`, text: s.label, onclick: () => { pendingFocus = s.key; } }),
        el('span', { class: 'pricetag' }, el('s', { text: formatValue(s, s.default) }), formatValue(s, s.value)))))
      : el('p', { class: 'empty', text: 'Tutti i parametri hanno il valore predefinito.' }));

  async function loadStatus() {
    refresh.disabled = true;
    try {
      const st = await api('/admin/status');
      const up = st.services.filter((x) => x.ok).length;
      upCount.textContent = `${up}/${st.services.length}`;
      statusList.replaceChildren(...st.services.map((x) => el('li', {},
        el('span', { class: `dot${x.ok ? '' : ' down'}`, 'aria-hidden': 'true' }),
        el('span', {}, el('span', { class: 'name', text: x.name }), el('span', { class: 'sr-only', text: x.ok ? ' attivo' : ' non attivo' })),
        el('span', { class: 'detail', text: x.ok ? (x.ms ? `${x.ms} ms` : 'attivo') : x.detail || 'non attivo' }))));
    } catch (err) {
      statusList.replaceChildren(el('li', {}, el('span', { class: 'dot down' }), el('span', { text: err.message }), el('span')));
    } finally {
      statusList.removeAttribute('aria-busy');
      refresh.disabled = false;
    }
  }
  loadStatus();
}

async function renderAudit() {
  const content = $('#content');
  content.replaceChildren(pageHead('Registro modifiche', 'Le ultime 200 modifiche ai parametri, con chi le ha fatte. Il registro conserva due anni di storico.'), el('p', { class: 'empty', text: 'Caricamento…' }));
  try {
    const { items } = await api('/admin/audit?limit=200');
    if (!items.length) {
      content.lastChild.replaceWith(el('p', { class: 'empty', text: 'Ancora nessuna modifica. Quando salvi un parametro, la trovi qui.' }));
      return;
    }
    const row = (i) => {
      const def = state.byKey.get(i.key);
      return el('tr', {},
        el('td', { class: 'when', text: when(i.changedAt) }),
        el('td', {}, el('strong', { text: i.label })),
        el('td', { class: 'change' },
          el('s', { text: formatValue(def, i.oldValue) + (i.wasDefault ? ' (predefinito)' : '') }), ' → ',
          formatValue(def, i.newValue) + (i.isDefault ? ' (predefinito)' : '')),
        el('td', { text: i.changedBy }));
    };
    content.lastChild.replaceWith(el('table', { class: 'audit' },
      el('thead', {}, el('tr', {}, ['Quando', 'Parametro', 'Modifica', 'Chi'].map((h) => el('th', { scope: 'col', text: h })))),
      el('tbody', {}, items.map(row))));
  } catch (err) {
    content.lastChild.replaceWith(el('p', { class: 'error', text: err.message }));
  }
}


// ---------- Prezzi raccolti ----------

const SOURCE_NAMES = {
  'web:carrefour': 'Carrefour', 'web:lidl': 'Lidl', 'web:aldi': 'Aldi', 'web:eurospin': 'Eurospin',
  'web:penny': 'Penny', 'web:easycoop': 'EasyCoop (Coop Alleanza 3.0)', 'api:open-prices': 'Open Prices',
};
function sourceName(id) {
  if (SOURCE_NAMES[id]) return SOURCE_NAMES[id];
  if (id.startsWith('demo:')) return 'Listini dimostrativi';
  if (id.startsWith('feed:')) return `Feed ${id.slice(5)}`;
  return id;
}
const euro = (n) => n == null ? '' : `${Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const day = (iso) => iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : '';

const collected = { source: '', promo: true, offset: 0, limit: 100, search: '' };

async function renderCollected() {
  const content = $('#content');
  const summaryBox = el('div', {}, el('p', { class: 'empty', text: 'Caricamento delle fonti…' }));
  const tableBox = el('div', {});
  const sourceSelect = el('select', { id: 'f-source', 'aria-label': 'Fonte' }, el('option', { value: '', text: 'Tutte le fonti' }));
  const promoBox = el('input', { type: 'checkbox', id: 'f-promo', checked: collected.promo });
  const search = el('input', { type: 'search', id: 'f-search', placeholder: 'Filtra per prodotto, marca, EAN o negozio', value: collected.search });
  const pager = el('div', { class: 'pager' });

  content.replaceChildren(
    pageHead('Prezzi raccolti', 'Quello che la raccolta notturna ha salvato, fonte per fonte, per controllare i dati. Un listino d\'insegna vale per tutti i negozi della catena nell\'area: qui è una riga sola con il numero di negozi.'),
    summaryBox,
    el('div', { class: 'section-head spaced' }, el('h2', { text: 'Prezzi' })),
    el('div', { class: 'filters' },
      sourceSelect,
      el('label', { class: 'check', for: 'f-promo' }, promoBox, 'Solo offerte'),
      search),
    tableBox,
    pager);

  const loadTable = async () => {
    tableBox.replaceChildren(el('p', { class: 'empty', text: 'Caricamento…' }));
    const qs = new URLSearchParams({ limit: String(collected.limit), offset: String(collected.offset) });
    if (collected.source) qs.set('source', collected.source);
    if (collected.promo) qs.set('promo', '1');
    try {
      const data = await api(`/admin/collected?${qs}`);
      drawTable(data);
    } catch (err) {
      tableBox.replaceChildren(el('p', { class: 'error', text: err.message }));
    }
  };

  const drawTable = (data) => {
    const needle = collected.search.trim().toLowerCase();
    const rows = data.items.filter((i) => !needle || [i.product?.name, i.product?.brand, i.product?.ean, ...i.sampleStores.map((s) => `${s.name} ${s.chain ?? ''}`)]
      .some((t) => (t || '').toLowerCase().includes(needle)));
    if (!data.items.length) {
      tableBox.replaceChildren(el('p', { class: 'empty', text: collected.promo ? 'Nessuna offerta in corso per questa scelta. Togli "Solo offerte" per vedere tutti i prezzi.' : 'Nessun prezzo raccolto per questa scelta.' }));
    } else if (!rows.length) {
      tableBox.replaceChildren(el('p', { class: 'empty', text: 'Nessuna riga di questa pagina corrisponde al filtro.' }));
    } else {
      tableBox.replaceChildren(el('table', { class: 'audit prices' },
        el('thead', {}, el('tr', {}, ['Prodotto', 'Fonte', 'Prezzo', 'Validità', 'Negozi', 'Visto'].map((h) => el('th', { scope: 'col', text: h })))),
        el('tbody', {}, rows.map((i) => el('tr', {},
          el('td', {},
            el('strong', { text: i.product?.name ?? i.productId }),
            el('div', { class: 'sub', text: [i.product?.brand, i.product?.category, i.product?.ean ? `EAN ${i.product.ean}` : null].filter(Boolean).join(' · ') })),
          el('td', { 'data-label': 'Fonte', text: sourceName(i.source) }),
          el('td', { class: 'change', 'data-label': 'Prezzo' },
            i.promoPrice != null
              ? [el('s', { text: euro(i.price) }), ' ', el('strong', { text: euro(i.promoPrice) }), i.loyaltyOnly ? el('div', { class: 'sub', text: 'con carta fedeltà' }) : null]
              : euro(i.price)),
          el('td', { class: 'when', 'data-label': 'Validità', text: i.promoUntil ? `fino al ${day(i.promoUntil)}` : i.expiresOn ? `fino al ${day(i.expiresOn)}` : '' }),
          el('td', { 'data-label': 'Negozi' },
            el('span', { text: i.stores === 1 ? '1 negozio' : `${i.stores} negozi` }),
            el('div', { class: 'sub', text: i.sampleStores.map((s) => s.name).join(', ') + (i.stores > i.sampleStores.length ? '…' : '') })),
          el('td', { class: 'when', 'data-label': 'Visto il', text: day(i.observedOn) }))))));
    }
    const from = data.total ? collected.offset + 1 : 0;
    const to = Math.min(collected.offset + collected.limit, data.total);
    pager.replaceChildren(
      el('span', { class: 'muted', text: `${from}–${to} di ${data.total.toLocaleString('it-IT')}` }),
      el('button', { class: 'btn small', type: 'button', text: 'Precedenti', disabled: collected.offset === 0,
        onclick: () => { collected.offset = Math.max(0, collected.offset - collected.limit); loadTable(); } }),
      el('button', { class: 'btn small', type: 'button', text: 'Successivi', disabled: to >= data.total,
        onclick: () => { collected.offset += collected.limit; loadTable(); } }));
    lastData = data;
  };
  let lastData = null;

  sourceSelect.addEventListener('change', () => { collected.source = sourceSelect.value; collected.offset = 0; loadTable(); });
  promoBox.addEventListener('change', () => { collected.promo = promoBox.checked; collected.offset = 0; loadTable(); });
  search.addEventListener('input', () => { collected.search = search.value; if (lastData) drawTable(lastData); });

  try {
    const { items } = await api('/admin/collected/sources');
    for (const s of items) sourceSelect.append(el('option', { value: s.source, text: sourceName(s.source), selected: s.source === collected.source }));
    summaryBox.replaceChildren(items.length
      ? el('table', { class: 'audit' },
        el('thead', {}, el('tr', {}, ['Fonte', 'Prodotti', 'Negozi', 'Offerte in corso', 'Ultimo aggiornamento'].map((h) => el('th', { scope: 'col', text: h })))),
        el('tbody', {}, items.map((s) => el('tr', {},
          el('td', {}, el('a', { href: '#/prezzi', text: sourceName(s.source), onclick: (e) => {
            e.preventDefault(); collected.source = s.source; sourceSelect.value = s.source; collected.offset = 0; loadTable();
          } })),
          el('td', { 'data-label': 'Prodotti', text: s.products.toLocaleString('it-IT') }),
          el('td', { 'data-label': 'Negozi', text: s.stores.toLocaleString('it-IT') }),
          el('td', { 'data-label': 'Offerte in corso', text: s.promos.toLocaleString('it-IT') }),
          el('td', { class: 'when', 'data-label': 'Aggiornato', text: s.lastFetched ? when(s.lastFetched) : '' })))))
      : el('p', { class: 'empty', text: 'Nessun prezzo raccolto finora: la raccolta parte ogni notte, oppure avviala a mano (README, "Raccolta prezzi").' }));
  } catch (err) {
    summaryBox.replaceChildren(el('p', { class: 'error', text: err.message }));
  }
  loadTable();
}

let pendingFocus = null;
function render() {
  renderSidebar();
  const q = $('#search').value.trim();
  const { view, arg } = route();
  if (q) renderSearch(q);
  else if (view === 'gruppo') renderGroup(arg);
  else if (view === 'registro') renderAudit();
  else if (view === 'prezzi') renderCollected();
  else renderOverview();
  if (pendingFocus) {
    const row = document.getElementById(`row-${pendingFocus}`);
    pendingFocus = null;
    if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('highlight'); row.querySelector('input, textarea')?.focus({ preventScroll: true }); }
  }
}

function updateChrome() {
  const n = dirtyCount();
  const bar = $('#savebar');
  bar.hidden = n === 0;
  $('#savebar-text').textContent = state.errors.size
    ? 'Correggi i valori segnati in rosso per salvare'
    : n === 1 ? '1 modifica non salvata' : `${n} modifiche non salvate`;
  $('#save').disabled = state.errors.size > 0;
  $('#save').title = state.errors.size ? 'Correggi i valori segnati in rosso' : '';
}

// ---------- Dati ----------

function applySettings(data) {
  state.groups = data.groups;
  state.settings = data.settings;
  state.byKey = new Map(data.settings.map((s) => [s.key, s]));
}

async function loadSettings() {
  applySettings(await api('/admin/settings'));
}

async function save() {
  if (state.errors.size) return;
  const btn = $('#save');
  btn.disabled = true;
  btn.textContent = 'Salvataggio…';
  const changed = [...state.drafts.keys(), ...state.resets].map((k) => state.byKey.get(k)?.label);
  try {
    applySettings(await api('/admin/settings', { method: 'PATCH', body: { values: Object.fromEntries(state.drafts), reset: [...state.resets] } }));
    state.drafts.clear();
    state.resets.clear();
    toast(changed.length === 1 ? `Salvato: ${changed[0]}. I servizi lo applicano subito.` : `Salvate ${changed.length} modifiche. I servizi le applicano subito.`);
    render();
  } catch (err) {
    // Il server indica "Etichetta: motivo; …": si riportano gli errori sulle righe.
    for (const part of err.message.split('; ')) {
      const [label, ...rest] = part.split(': ');
      const s = state.settings.find((x) => x.label === label);
      if (s && rest.length) { state.errors.set(s.key, rest.join(': ')); refreshRow(s.key, true); }
    }
    toast(err.message, true);
  } finally {
    btn.textContent = 'Salva modifiche';
    updateChrome();
  }
}

function discard() {
  state.drafts.clear();
  state.resets.clear();
  state.errors.clear();
  render();
  updateChrome();
}

// ---------- Accesso ----------

function showLogin(message) {
  $('#panel').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = message || '';
  $('#email').focus();
}

async function showPanel() {
  $('#login').hidden = true;
  $('#panel').hidden = false;
  $('#who').textContent = state.session.email;
  try {
    await loadSettings();
  } catch (err) {
    if (err.status === 401 || err.status === 403) return logout(err.status === 403 ? 'Questo account non è amministratore.' : 'Sessione scaduta: accedi di nuovo.');
    $('#content').replaceChildren(el('p', { class: 'error', text: `Impossibile leggere i parametri: ${err.message}` }));
    return;
  }
  render();
  updateChrome();
}

function logout(message) {
  saveSession(null);
  state.drafts.clear();
  state.resets.clear();
  state.errors.clear();
  showLogin(message);
}

async function onLogin(e) {
  e.preventDefault();
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const error = $('#login-error');
  if (!email || !password) { error.textContent = 'Inserisci email e password.'; return; }
  const btn = e.submitter || $('#login-form button');
  btn.disabled = true;
  error.textContent = '';
  try {
    const r = await request('/admin/login', { method: 'POST', body: { email, password }, auth: false });
    saveSession({ accessToken: r.accessToken, refreshToken: r.refreshToken, email: r.email });
    $('#password').value = '';
    await showPanel();
  } catch (err) {
    error.textContent = err.status === 401 ? 'Email o password non corrette.' : err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Avvio ----------

function closeMenu() {
  $('#sidebar').classList.remove('open');
  $('#menu-toggle').setAttribute('aria-expanded', 'false');
}

document.addEventListener('DOMContentLoaded', () => {
  $('#login-form').addEventListener('submit', onLogin);
  $('#logout').addEventListener('click', () => {
    if (dirtyCount() && !confirm('Hai modifiche non salvate. Uscire comunque?')) return;
    logout();
  });
  $('#save').addEventListener('click', save);
  $('#discard').addEventListener('click', discard);
  let searchTimer;
  $('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 150); });
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; render(); } });
  $('#menu-toggle').addEventListener('click', () => {
    const open = $('#sidebar').classList.toggle('open');
    $('#menu-toggle').setAttribute('aria-expanded', String(open));
  });
  $('#sidebar').addEventListener('click', (e) => {
    if (e.target.closest('a')) { $('#search').value = ''; closeMenu(); }
  });
  window.addEventListener('hashchange', () => { if (state.session && state.settings.length) { render(); $('#content').focus({ preventScroll: true }); window.scrollTo(0, 0); } });
  window.addEventListener('beforeunload', (e) => { if (dirtyCount()) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && dirtyCount()) { e.preventDefault(); save(); }
    if (e.key === 'Escape') closeMenu();
  });

  loadSession();
  if (state.session?.accessToken) showPanel(); else showLogin();
});
