/** Selezione delle offerte da segnalare a un utente: funzione pura, testata in tests/offers.test.mjs. */

export interface Promo {
  storeId: string;
  productId: string;
  price: number;
  promoPrice: number;
  loyaltyOnly: boolean;
}

export interface AllowedStore {
  id: string;
  chainId: string;
  name: string;
  distanceKm: number;
}

export interface FrequentProduct {
  productId: string;
  productName: string;
}

export interface Offer extends Promo {
  productName: string;
  storeName: string;
  discountPct: number;
}

/** Le offerte valide per un prezzo pieno e scontato: promo reale e sconto almeno di minDiscountPct (parametro offers.minDiscountPct). */
export function promosFrom(
  prices: Array<{ storeId: string; productId: string; price: number; promoPrice?: number | null; loyaltyOnly?: boolean }>,
  minDiscountPct = 10,
): Promo[] {
  return prices
    .filter((p) => p.promoPrice != null && p.promoPrice > 0 && p.promoPrice < p.price)
    .filter((p) => ((p.price - p.promoPrice!) / p.price) * 100 >= minDiscountPct)
    .map((p) => ({ storeId: p.storeId, productId: p.productId, price: p.price, promoPrice: p.promoPrice!, loyaltyOnly: !!p.loyaltyOnly }));
}

/**
 * Per ogni prodotto frequente, l'offerta migliore tra i negozi ammessi (raggio meno blacklist).
 * Le promo riservate ai titolari valgono solo se l'utente ha la carta di quell'insegna.
 * Ordinate per sconto percentuale, dalla più conveniente.
 */
export function selectOffers(
  promos: Promo[],
  frequent: FrequentProduct[],
  allowed: AllowedStore[],
  loyaltyChains: Set<string>,
): Offer[] {
  const stores = new Map(allowed.map((s) => [s.id, s]));
  const names = new Map(frequent.map((f) => [f.productId, f.productName]));
  const best = new Map<string, Offer>();
  for (const p of promos) {
    const store = stores.get(p.storeId);
    const productName = names.get(p.productId);
    if (!store || !productName) continue;
    if (p.loyaltyOnly && !loyaltyChains.has(store.chainId)) continue;
    const offer: Offer = {
      ...p,
      productName,
      storeName: store.name,
      discountPct: Math.round(((p.price - p.promoPrice) / p.price) * 100),
    };
    const current = best.get(p.productId);
    const closer = current && offer.promoPrice === current.promoPrice && store.distanceKm < (stores.get(current.storeId)?.distanceKm ?? Infinity);
    if (!current || offer.promoPrice < current.promoPrice || closer) best.set(p.productId, offer);
  }
  return [...best.values()].sort((a, b) => b.discountPct - a.discountPct || a.productName.localeCompare(b.productName));
}

const euro = (n: number) => `${n.toFixed(2).replace('.', ',')} €`;

/** Testo della push: un solo messaggio per esecuzione, con l'offerta migliore in evidenza. */
export function pushText(offers: Offer[]): { title: string; body: string } {
  const [top, ...rest] = offers;
  const card = top.loyaltyOnly ? ' con la carta' : '';
  const more = rest.length === 1 ? ' e un\'altra offerta' : rest.length > 1 ? ` e altre ${rest.length} offerte` : '';
  return {
    title: rest.length ? 'Offerte sui prodotti che compri spesso' : `${top.productName} in offerta`,
    body: `${top.productName} a ${euro(top.promoPrice)} (-${top.discountPct}%) da ${top.storeName}${card}${more}`,
  };
}
