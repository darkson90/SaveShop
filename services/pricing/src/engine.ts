/** Motore di confronto prezzi: funzioni pure, senza I/O, testate in tests/engine.test.mjs. */

export interface StoreInfo {
  id: string;
  chainId: string;
  name: string;
  distanceKm: number;
}

export interface PriceRow {
  storeId: string;
  productId: string;
  price: number;
  promoPrice: number | null;
  loyaltyOnly: boolean;
}

export interface Item {
  itemId: string;
  productId: string;
  quantity: number;
}

export interface UnitPrice {
  unitPrice: number;
  promo: boolean;
  loyaltyOnly: boolean;
}

export type Matrix = Map<string, Map<string, UnitPrice>>;

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Il prezzo promo vale se non è riservato ai titolari di carta, o se l'utente ha la carta dell'insegna. */
export function effectivePrice(row: PriceRow, hasCard: boolean): UnitPrice {
  const promoUsable = row.promoPrice != null && row.promoPrice < row.price && (!row.loyaltyOnly || hasCard);
  return promoUsable
    ? { unitPrice: row.promoPrice!, promo: true, loyaltyOnly: row.loyaltyOnly }
    : { unitPrice: row.price, promo: false, loyaltyOnly: false };
}

export function buildMatrix(stores: StoreInfo[], prices: PriceRow[], loyaltyChains: Set<string>): Matrix {
  const chainOf = new Map(stores.map((s) => [s.id, s.chainId]));
  const matrix: Matrix = new Map(stores.map((s) => [s.id, new Map()]));
  for (const row of prices) {
    const perStore = matrix.get(row.storeId);
    if (!perStore) continue;
    perStore.set(row.productId, effectivePrice(row, loyaltyChains.has(chainOf.get(row.storeId) ?? '')));
  }
  return matrix;
}

interface StoreTotal {
  store: StoreInfo;
  total: number;
  missing: number;
  lines: Array<{ itemId: string; productId: string } & UnitPrice>;
}

function storeTotal(store: StoreInfo, items: Item[], matrix: Matrix): StoreTotal {
  const perStore = matrix.get(store.id)!;
  let total = 0;
  let missing = 0;
  const lines: StoreTotal['lines'] = [];
  for (const item of items) {
    const p = perStore.get(item.productId);
    if (!p) {
      missing++;
      continue;
    }
    total += p.unitPrice * item.quantity;
    lines.push({ itemId: item.itemId, productId: item.productId, ...p });
  }
  return { store, total: round2(total), missing, lines };
}

/** Ordina per articoli mancanti (meno è meglio), poi per totale, poi per distanza. */
const byCoverageThenTotal = (a: { missing: number; total: number; distance: number }, b: typeof a) =>
  a.missing - b.missing || a.total - b.total || a.distance - b.distance;

/** Modalità "negozio unico": la spesa intera in un solo punto vendita. */
export function singleStore(items: Item[], stores: StoreInfo[], matrix: Matrix) {
  const totals = stores.map((s) => storeTotal(s, items, matrix)).filter((t) => t.lines.length > 0);
  // Il risparmio si misura contro il negozio più caro con la stessa copertura della lista.
  const maxByMissing = new Map<number, number>();
  for (const t of totals) maxByMissing.set(t.missing, Math.max(maxByMissing.get(t.missing) ?? 0, t.total));
  return totals
    .map((t) => ({
      storeId: t.store.id,
      name: t.store.name,
      distanceKm: t.store.distanceKm,
      total: t.total,
      missingItems: t.missing,
      savingVsMax: round2((maxByMissing.get(t.missing) ?? t.total) - t.total),
      items: t.lines.map(({ itemId, unitPrice, promo, loyaltyOnly }) => ({ itemId, unitPrice, promo, loyaltyOnly })),
    }))
    .sort((a, b) => byCoverageThenTotal({ ...a, missing: a.missingItems, distance: a.distanceKm }, { ...b, missing: b.missingItems, distance: b.distanceKm }));
}

/** Modalità "due negozi": ogni articolo va nel più economico della coppia. Restituisce le 5 coppie migliori. */
export function twoStores(items: Item[], stores: StoreInfo[], matrix: Matrix, limit = 5) {
  const best = singleStore(items, stores, matrix)[0];
  const results: Array<{
    stores: Array<{ storeId: string; name: string; distanceKm: number }>;
    total: number;
    missingItems: number;
    savingVsBestSingle: number | null;
    items: Array<{ itemId: string; storeId: string; unitPrice: number; promo: boolean }>;
  }> = [];
  for (let i = 0; i < stores.length; i++) {
    for (let j = i + 1; j < stores.length; j++) {
      const pair = [stores[i], stores[j]];
      let total = 0;
      let missing = 0;
      const assignment: Array<{ itemId: string; storeId: string; unitPrice: number; promo: boolean }> = [];
      for (const item of items) {
        let pick: { store: StoreInfo; p: UnitPrice } | undefined;
        for (const store of pair) {
          const p = matrix.get(store.id)?.get(item.productId);
          if (p && (!pick || p.unitPrice < pick.p.unitPrice)) pick = { store, p };
        }
        if (!pick) {
          missing++;
          continue;
        }
        total += pick.p.unitPrice * item.quantity;
        assignment.push({ itemId: item.itemId, storeId: pick.store.id, unitPrice: pick.p.unitPrice, promo: pick.p.promo });
      }
      // Una coppia in cui un negozio non riceve articoli equivale al negozio unico: la scartiamo.
      const used = new Set(assignment.map((a) => a.storeId));
      if (used.size < 2) continue;
      results.push({
        stores: pair.map((s) => ({ storeId: s.id, name: s.name, distanceKm: s.distanceKm })),
        total: round2(total),
        missingItems: missing,
        savingVsBestSingle: best && best.missingItems >= missing ? round2(best.total - total) : null,
        items: assignment,
      });
    }
  }
  const maxDist = (r: (typeof results)[number]) => Math.max(...r.stores.map((s) => s.distanceKm));
  return results
    .sort((a, b) => byCoverageThenTotal({ missing: a.missingItems, total: a.total, distance: maxDist(a) }, { missing: b.missingItems, total: b.total, distance: maxDist(b) }))
    .slice(0, limit);
}

/** Modalità "miglior prezzo per articolo": il negozio più economico per ciascun prodotto. */
export function perItem(items: Item[], stores: StoreInfo[], matrix: Matrix) {
  const rows = items.map((item) => {
    let best: { store: StoreInfo; p: UnitPrice } | undefined;
    for (const store of stores) {
      const p = matrix.get(store.id)?.get(item.productId);
      if (p && (!best || p.unitPrice < best.p.unitPrice || (p.unitPrice === best.p.unitPrice && store.distanceKm < best.store.distanceKm))) {
        best = { store, p };
      }
    }
    return best
      ? { itemId: item.itemId, storeId: best.store.id, storeName: best.store.name, unitPrice: best.p.unitPrice, promo: best.p.promo, lineTotal: round2(best.p.unitPrice * item.quantity) }
      : { itemId: item.itemId, storeId: null, storeName: null, unitPrice: null, promo: false, lineTotal: 0 };
  });
  return {
    total: round2(rows.reduce((s, r) => s + r.lineTotal, 0)),
    missingItems: rows.filter((r) => r.storeId === null).length,
    storesUsed: new Set(rows.filter((r) => r.storeId).map((r) => r.storeId)).size,
    items: rows,
  };
}

/**
 * Prezzi congelati alla chiusura della spesa. Il riferimento è il negozio più caro del raggio
 * (blacklist esclusa) calcolato sugli articoli disponibili in entrambi i negozi: gli articoli che
 * mancano nel riferimento restano nelle righe (per categorie e top prodotti) ma fuori dal risparmio.
 */
export function purchaseQuote(
  items: Item[],
  stores: StoreInfo[],
  matrix: Matrix,
  storeId: string,
  /** Prezzi realmente pagati letti dallo scontrino, per prodotto: prevalgono sul listino. */
  overrides: Record<string, number> = {},
) {
  const listPrices = matrix.get(storeId);
  if (!listPrices) throw new Error('Negozio non ammesso nel raggio');
  const paidOf = (productId: string) => overrides[productId] ?? listPrices.get(productId)?.unitPrice;
  const available = items.filter((i) => paidOf(i.productId) !== undefined);

  let reference: { storeId: string; covered: number; total: number } | undefined;
  for (const store of stores) {
    if (store.id === storeId) continue;
    const prices = matrix.get(store.id)!;
    const common = available.filter((i) => prices.has(i.productId));
    const total = common.reduce((s, i) => s + prices.get(i.productId)!.unitPrice * i.quantity, 0);
    if (!common.length) continue;
    if (!reference || common.length > reference.covered || (common.length === reference.covered && total > reference.total)) {
      reference = { storeId: store.id, covered: common.length, total };
    }
  }
  const refPrices = reference ? matrix.get(reference.storeId)! : undefined;

  let totalPaid = 0;
  let comparablePaid = 0;
  let totalReference = 0;
  const lines = available.map((i) => {
    const unitPaid = paidOf(i.productId)!;
    const ref = refPrices?.get(i.productId);
    const unitReference = ref ? ref.unitPrice : null;
    totalPaid += unitPaid * i.quantity;
    if (unitReference != null) {
      comparablePaid += unitPaid * i.quantity;
      totalReference += unitReference * i.quantity;
    }
    return { productId: i.productId, quantity: i.quantity, unitPaid, unitReference, fromReceipt: i.productId in overrides };
  });
  const saved = totalReference - comparablePaid;
  return {
    referenceStoreId: reference?.storeId ?? null,
    totalPaid: round2(totalPaid),
    comparablePaid: round2(comparablePaid),
    totalReference: round2(totalReference),
    savedEur: round2(saved),
    savedPct: totalReference > 0 ? Math.round((saved / totalReference) * 1000 + 1e-6) / 10 : 0, // epsilon: 13.75 -> 13.8
    missingItems: items.length - available.length,
    lines,
  };
}
