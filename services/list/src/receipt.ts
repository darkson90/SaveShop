/** Lettura del testo di uno scontrino italiano (OCR fatto sul telefono). Funzioni pure, testate. */

export interface ReceiptLine {
  text: string;        // descrizione come stampata
  amount: number;      // importo della riga, sconti già applicati
  quantity: number;
  unitPrice: number;
  unit: 'pz' | 'kg';
}

export interface ParsedReceipt {
  lines: ReceiptLine[];
  total: number | null;          // TOTALE stampato, se letto
  linesTotal: number;            // somma delle righe lette
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (s: string) => Number.parseFloat(s.replace(/\s/g, '').replace(',', '.'));

// Importo a fine riga, eventualmente seguito da "€", "EUR" o dalla lettera del reparto IVA.
const AMOUNT_AT_END = /(-?\s?\d{1,4}[.,]\d{2})\s*(?:€|EUR|EURO)?\s*[A-Z]?$/i;
// "2 x 0,99" / "2 X 0,99 €"
const QTY_LINE = /^(\d{1,3})\s*[xX*]\s*(\d{1,4}[.,]\d{2})\s*(?:€|EUR)?$/;
// "0,534 kg x 2,49 €/kg"
const WEIGHT_LINE = /^(\d{1,2}[.,]\d{1,3})\s*kg\s*[xX*]\s*(\d{1,4}[.,]\d{2})\s*(?:€|EUR)?\s*(?:\/\s*kg)?$/i;
const TOTAL = /^(TOTALE|TOT\.?)(\s+(COMPLESSIVO|EURO|EUR|DA PAGARE))?\b/i;
const DISCOUNT = /\b(SCONTO|SC\.|PROMO|RIDUZIONE|BUONO)\b/i;
/** Righe che non sono prodotti: pagamento, resto, IVA, intestazione, fiscale. */
const NOISE = /\b(SUBTOTALE|SUB-?TOTALE|CONTANT[EI]|RESTO|PAGAMENTO|PAGATO|BANCOMAT|CARTA|CREDITO|ELETTRONICO|IVA|IMPONIBILE|DOCUMENTO|COMMERCIALE|SCONTRINO|P\.?\s?IVA|C\.?F\.?|CASSA|CASSIERE|OPERATORE|NUMERO|ARTICOLI|PEZZI|DATA|ORA|TEL|GRAZIE|ARRIVEDERCI|EURO\s*$|RT\s)/i;

/**
 * Riconosce le righe prodotto (descrizione + importo), le righe quantità ("2 x 0,99") e peso
 * ("0,534 kg x 2,49"), gli sconti (applicati alla riga precedente) e il totale.
 */
export function parseReceipt(text: string): ParsedReceipt {
  const raw = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const lines: ReceiptLine[] = [];
  let total: number | null = null;
  let pending: { quantity: number; unitPrice: number; unit: 'pz' | 'kg' } | null = null;

  const applyQuantity = (q: { quantity: number; unitPrice: number; unit: 'pz' | 'kg' }) => {
    const prev = lines.at(-1);
    // La riga quantità segue di solito il prodotto e ne giustifica l'importo.
    if (prev && prev.quantity === 1 && Math.abs(prev.amount - q.quantity * q.unitPrice) <= 0.02) {
      Object.assign(prev, { quantity: q.quantity, unitPrice: q.unitPrice, unit: q.unit });
    } else {
      pending = q; // altrimenti vale per il prodotto successivo
    }
  };

  for (const line of raw) {
    let m = line.match(WEIGHT_LINE);
    if (m) {
      applyQuantity({ quantity: num(m[1]), unitPrice: num(m[2]), unit: 'kg' });
      continue;
    }
    m = line.match(QTY_LINE);
    if (m) {
      applyQuantity({ quantity: num(m[1]), unitPrice: num(m[2]), unit: 'pz' });
      continue;
    }
    const amountMatch = line.match(AMOUNT_AT_END);
    if (!amountMatch) continue;
    const amount = num(amountMatch[1]);
    const label = line.slice(0, amountMatch.index).replace(/[€*]+/g, ' ').trim();

    if (TOTAL.test(label) && !/SUB/i.test(label)) {
      total = Math.abs(amount);
      continue;
    }
    if (DISCOUNT.test(label) || amount < 0) {
      const prev = lines.at(-1);
      if (prev) {
        prev.amount = round2(prev.amount - Math.abs(amount));
        prev.unitPrice = round2(prev.amount / prev.quantity);
      }
      continue;
    }
    if (NOISE.test(label) || !/[A-Za-zÀ-ú]{2,}/.test(label)) continue;

    const q: { quantity: number; unitPrice: number; unit: 'pz' | 'kg' } = pending ?? { quantity: 1, unitPrice: amount, unit: 'pz' };
    pending = null;
    lines.push({ text: label, amount, quantity: q.quantity, unitPrice: round2(amount / q.quantity), unit: q.unit });
  }

  return { lines, total, linesTotal: round2(lines.reduce((s, l) => s + l.amount, 0)) };
}

/** Abbreviazioni tipiche degli scontrini, espanse prima del confronto testuale. */
const ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bPS\b/g, 'PARZIALMENTE SCREMATO'],
  [/\bPARZ\b\.?/g, 'PARZIALMENTE'],
  [/\bSCREM\b\.?/g, 'SCREMATO'],
  [/\bEXTRAV?\b\.?/g, 'EXTRAVERGINE'],
  [/\bMOZZ\b\.?/g, 'MOZZARELLA'],
  [/\bPOM\b\.?/g, 'POMODORO'],
  [/\bFORM\b\.?/g, 'FORMAGGIO'],
  [/\bBISC\b\.?/g, 'BISCOTTI'],
  [/\bDET\b\.?/g, 'DETERSIVO'],
];

export function normalizeLabel(s: string): string {
  let t = s.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  for (const [re, full] of ABBREVIATIONS) t = t.replace(re, full);
  return t.replace(/\b\d+([.,]\d+)?\s*(G|GR|KG|ML|CL|L|LT|PZ|X)\b/g, ' ').replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.split(' ')) {
    const w = `  ${word} `;
    for (let i = 0; i < w.length - 2; i++) out.add(w.slice(i, i + 3));
  }
  return out;
}

/** Somiglianza 0–1 tra descrizione dello scontrino e nome in lista (coefficiente di Dice sui trigrammi). */
export function similarity(a: string, b: string): number {
  const ta = trigrams(normalizeLabel(a));
  const tb = trigrams(normalizeLabel(b));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return (2 * common) / (ta.size + tb.size);
}

export interface Candidate {
  itemId: string;
  label: string;
  productId: string | null;
}

export interface LineMatch {
  itemId: string;
  label: string;
  confidence: number;
}

/**
 * Abbina ogni riga a un articolo della lista: prima per prodotto di catalogo (se noto),
 * poi per somiglianza del testo. Ogni articolo è usato al massimo una volta, partendo dalle coppie
 * più sicure; sotto 0,35 la riga resta da abbinare a mano.
 */
export function matchLines(
  lines: ReceiptLine[],
  candidates: Candidate[],
  catalogMatches: Array<{ productId: string | null; confidence: number }>,
  minConfidence = 0.35,
): Array<LineMatch | null> {
  const pairs: Array<{ line: number; item: Candidate; score: number }> = [];
  lines.forEach((line, i) => {
    for (const item of candidates) {
      const byProduct = catalogMatches[i]?.productId && catalogMatches[i].productId === item.productId ? catalogMatches[i].confidence : 0;
      const score = Math.max(byProduct, similarity(line.text, item.label));
      if (score >= minConfidence) pairs.push({ line: i, item, score });
    }
  });
  pairs.sort((a, b) => b.score - a.score);
  const result: Array<LineMatch | null> = lines.map(() => null);
  const usedItems = new Set<string>();
  for (const p of pairs) {
    if (result[p.line] || usedItems.has(p.item.itemId)) continue;
    result[p.line] = { itemId: p.item.itemId, label: p.item.label, confidence: Math.round(p.score * 100) / 100 };
    usedItems.add(p.item.itemId);
  }
  return result;
}
