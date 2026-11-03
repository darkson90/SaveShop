export interface ParsedInput {
  text: string;
  quantity: number;
  unit?: 'pz' | 'kg' | 'l';
}

const UNIT_ALIASES: Record<string, ParsedInput['unit']> = {
  pz: 'pz', pezzi: 'pz', pezzo: 'pz', conf: 'pz',
  kg: 'kg', chili: 'kg', chilo: 'kg', g: 'kg', gr: 'kg', etti: 'kg', etto: 'kg', hg: 'kg',
  l: 'l', lt: 'l', litri: 'l', litro: 'l', ml: 'l', cl: 'l',
};

/** Fattore per riportare l'unità digitata all'unità base del catalogo. */
const UNIT_FACTOR: Record<string, number> = { g: 0.001, gr: 0.001, etti: 0.1, etto: 0.1, hg: 0.1, ml: 0.001, cl: 0.01 };

const num = (s: string) => Number.parseFloat(s.replace(',', '.'));
const UNITS = Object.keys(UNIT_ALIASES).sort((a, b) => b.length - a.length).join('|');

/**
 * Interpreta l'inserimento rapido: "2 latte", "latte x2", "1,5 kg mele", "mele 500 g", "3x tonno".
 * Senza quantità esplicita restituisce 1.
 */
export function parseInput(raw: string): ParsedInput {
  let text = raw.trim().replace(/\s+/g, ' ');
  let quantity = 1;
  let unit: ParsedInput['unit'];

  const apply = (qty: string, u?: string) => {
    const key = u?.toLowerCase();
    quantity = num(qty) * (key ? UNIT_FACTOR[key] ?? 1 : 1);
    unit = key ? UNIT_ALIASES[key] : undefined;
  };

  const leading = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*(?:x\\s*)?(?:(${UNITS})\\b\\.?\\s*)?(?:di\\s+)?(.+)$`, 'i');
  const trailing = new RegExp(`^(.+?)\\s+(?:x\\s*)?(\\d+(?:[.,]\\d+)?)\\s*(?:(${UNITS})\\b\\.?)?$`, 'i');
  const trailingX = /^(.+?)\s*x\s*(\d+(?:[.,]\d+)?)$/i;

  let m = text.match(leading);
  if (m && m[3]) {
    apply(m[1], m[2]);
    text = m[3];
  } else if ((m = text.match(trailingX))) {
    apply(m[2]);
    text = m[1];
  } else if ((m = text.match(trailing))) {
    apply(m[2], m[3]);
    text = m[1];
  }

  if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1;
  quantity = Math.round(quantity * 1000) / 1000;
  return { text: text.trim(), quantity, ...(unit ? { unit } : {}) };
}
