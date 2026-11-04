import { BadRequestException, Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { AuthUser, callService, CurrentUser, PG_POOL, reqString, serviceUrl } from '@spesa/common';
import { Pool } from 'pg';
import { listAccess } from './access';
import { matchLines, parseReceipt } from './receipt';

/**
 * Scansione dello scontrino: l'app fa l'OCR sul telefono (il testo, non la foto, arriva al server),
 * qui si leggono le righe e si abbinano agli articoli della lista. L'utente conferma o corregge e
 * poi chiude la spesa con POST /lists/{id}/purchase passando paidPrices.
 */
@Controller('lists')
export class ReceiptController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Post(':id/receipt')
  @HttpCode(200)
  async read(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    await listAccess(this.pool, user.userId, id);
    const parsed = parseReceipt(reqString(body, 'text', 20_000));
    if (!parsed.lines.length) throw new BadRequestException('Nessuna riga prodotto riconosciuta: riprova con una foto più nitida');
    if (parsed.lines.length > 150) throw new BadRequestException('Scontrino troppo lungo');

    const { rows } = await this.pool.query(
      'SELECT id, product_id, COALESCE(product_name, raw_text) AS label, quantity FROM list_items WHERE list_id = $1 ORDER BY position',
      [id],
    );
    // Il catalogo conosce sinonimi e abbreviazioni ("latte ps"): una ricerca per riga, in parallelo.
    // Una sola chiamata per tutte le righe (prima erano fino a 150 richieste in parallelo).
    const catalog = await callService<{ items: Array<{ product: { id: string } | null; confidence: number }> }>(
      serviceUrl.catalog(),
      '/internal/products/match-batch',
      { method: 'POST', asService: true, body: { q: parsed.lines.map((l) => l.text.toLowerCase()) } },
    )
      .then((r) => r.items.map((m) => ({ productId: m.product?.id ?? null, confidence: Number(m.confidence ?? 0) })))
      .catch(() => parsed.lines.map(() => ({ productId: null, confidence: 0 }))); // senza catalogo: solo somiglianza del testo
    const matches = matchLines(
      parsed.lines,
      rows.map((r) => ({ itemId: r.id, label: r.label, productId: r.product_id })),
      catalog,
    );

    const matchedIds = new Set(matches.filter(Boolean).map((m) => m!.itemId));
    return {
      lines: parsed.lines.map((l, i) => ({ ...l, match: matches[i] })),
      total: parsed.total,
      linesTotal: parsed.linesTotal,
      // Differenza tra totale stampato e righe lette: segnala righe saltate dall'OCR.
      totalMismatch: parsed.total != null ? Math.round((parsed.total - parsed.linesTotal) * 100) / 100 : null,
      unmatchedItems: rows.filter((r) => !matchedIds.has(r.id)).map((r) => ({ itemId: r.id, label: r.label })),
    };
  }
}
