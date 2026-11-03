/**
 * Mappa le categorie di Open Food Facts (categories_tags) sulle categorie del catalogo.
 * Le regole sono in ordine: vince la prima che trova un tag. Le più specifiche vengono prima
 * (es. "surgelati" prima di "verdure", perché i piselli surgelati hanno entrambi i tag).
 */
const RULES: Array<{ category: string; tags: string[] }> = [
  { category: 'Surgelati', tags: ['en:frozen-foods', 'en:frozen-desserts', 'en:ice-creams'] },
  { category: 'Bevande', tags: ['en:beverages', 'en:waters', 'en:juices', 'en:beers', 'en:wines', 'en:sodas', 'en:alcoholic-beverages'] },
  { category: 'Carne e pesce', tags: ['en:meats', 'en:poultries', 'en:fishes', 'en:seafood', 'en:prepared-meats', 'en:hams', 'en:sausages'] },
  { category: 'Latticini', tags: ['en:dairies', 'en:milks', 'en:cheeses', 'en:yogurts', 'en:butters', 'en:creams', 'en:eggs'] },
  { category: 'Panetteria', tags: ['en:breads', 'en:rusks', 'en:crackers', 'en:breadsticks', 'en:sandwich-breads'] },
  {
    category: 'Frutta e verdura',
    tags: ['en:fresh-fruits', 'en:fresh-vegetables', 'en:fruits', 'en:vegetables', 'en:salads', 'en:lettuces', 'en:potatoes', 'en:tomatoes'],
  },
  // Tutto il resto dell'alimentare confezionato (pasta, riso, sughi, olio, caffè, snack...).
  { category: 'Dispensa', tags: ['en:pastas', 'en:rices', 'en:sauces', 'en:condiments', 'en:fats', 'en:coffees', 'en:snacks', 'en:canned-foods', 'en:cereals-and-potatoes'] },
];

/** Prodotti non alimentari (Open Beauty Facts / Open Products Facts) e default. */
export function mapCategory(tags: string[] | undefined, source?: string): string {
  if (source === 'obf' || source === 'opf') return 'Casa e igiene';
  const set = new Set(tags ?? []);
  for (const rule of RULES) if (rule.tags.some((t) => set.has(t))) return rule.category;
  return 'Dispensa';
}

/** Quantità della confezione nell'unità base del catalogo (kg o l): 160 g -> 0,16. */
export function packageSize(quantity: number | null | undefined, unit: string | null | undefined): number | null {
  if (!quantity || quantity <= 0) return null;
  const u = (unit ?? '').toLowerCase();
  if (u === 'g' || u === 'ml') return Math.round((quantity / 1000) * 1000) / 1000;
  if (u === 'cl') return Math.round((quantity / 100) * 1000) / 1000;
  if (u === 'kg' || u === 'l') return quantity;
  return null;
}
