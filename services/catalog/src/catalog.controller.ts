import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { optNumber, PG_POOL, Public, reqString, reqUuid } from '@spesa/common';
import { Pool } from 'pg';

/**
 * Ricerca per autocompletamento: prefisso e sottostringa sul nome o su un sinonimo,
 * più somiglianza trigram (pg_trgm) per tollerare errori di battitura.
 */
const SEARCH_SQL = `
  WITH q AS (SELECT lower($1::text) AS t, replace(replace(replace(lower($1::text), '\\', '\\\\'), '%', '\\%'), '_', '\\_') AS esc),
  cand AS (
    SELECT p.id AS product_id,
           GREATEST(word_similarity(q.t, lower(p.name)),
                    CASE WHEN lower(p.name) LIKE q.esc || '%' THEN 1.0
                         WHEN lower(p.name) LIKE '%' || q.esc || '%' THEN 0.8 ELSE 0 END) AS score
    FROM products p, q
    UNION ALL
    SELECT a.product_id,
           GREATEST(similarity(q.t, a.alias),
                    CASE WHEN a.alias = q.t THEN 1.0
                         WHEN a.alias LIKE q.esc || '%' THEN 0.9 ELSE 0 END)
    FROM product_aliases a, q
  )
  SELECT p.id, p.name, p.brand, p.unit, p.size, p.category_id, c.name AS category_name, MAX(cand.score) AS score
  FROM cand
  JOIN products p ON p.id = cand.product_id
  JOIN categories c ON c.id = p.category_id
  GROUP BY p.id, c.name
  HAVING MAX(cand.score) >= 0.3
  ORDER BY score DESC, p.popularity DESC
  LIMIT $2`;

const DETAIL_SQL = `
  SELECT p.id, p.name, p.brand, p.ean, p.unit, p.size, p.category_id, c.name AS category_name
  FROM products p JOIN categories c ON c.id = p.category_id`;

function toProduct(r: any) {
  return {
    id: r.id,
    name: r.name,
    brand: r.brand,
    unit: r.unit,
    size: r.size == null ? null : Number(r.size),
    categoryId: r.category_id,
    category: r.category_name,
  };
}

@Controller()
export class CatalogController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('products/suggest')
  async suggest(@Query('q') q: string, @Query('limit') limit?: string) {
    const term = (q ?? '').trim();
    if (term.length < 2) return { items: [] };
    if (term.length > 60) throw new BadRequestException('Ricerca troppo lunga');
    const { rows } = await this.pool.query(SEARCH_SQL, [term, optNumber(limit, 'limit', 1, 20) ?? 8]);
    return { items: rows.map(toProduct) };
  }

  @Get('products/:id')
  async detail(@Param('id') id: string) {
    const { rows } = await this.pool.query(`${DETAIL_SQL} WHERE p.id = $1`, [reqUuid(id, 'id')]);
    if (!rows[0]) throw new NotFoundException('Prodotto non trovato');
    return { ...toProduct(rows[0]), ean: rows[0].ean };
  }

  @Get('categories')
  async categories() {
    const { rows } = await this.pool.query('SELECT id, parent_id, name FROM categories ORDER BY name');
    const byParent = new Map<string | null, any[]>();
    for (const r of rows) {
      const list = byParent.get(r.parent_id) ?? [];
      list.push(r);
      byParent.set(r.parent_id, list);
    }
    const build = (parent: string | null): any[] =>
      (byParent.get(parent) ?? []).map((r) => ({ id: r.id, name: r.name, children: build(r.id) }));
    return { items: build(null) };
  }

  /** Interno (List Service): abbina il testo libero al prodotto più probabile. */
  @Public()
  @Get('internal/products/match')
  async match(@Query('q') q: string) {
    const { rows } = await this.pool.query(SEARCH_SQL, [reqString({ q }, 'q', 120), 1]);
    if (!rows[0]) return { product: null, confidence: 0 };
    return { product: toProduct(rows[0]), confidence: Math.round(Number(rows[0].score) * 100) / 100 };
  }

  /** Interno: dettagli di più prodotti in una chiamata (List, Pricing). */
  @Public()
  @Post('internal/products/batch')
  async batch(@Body() body: any) {
    const ids: string[] = Array.isArray(body?.ids) ? body.ids.slice(0, 200).map((id: any) => reqUuid(id, 'ids')) : [];
    if (!ids.length) return { items: [] };
    const { rows } = await this.pool.query(`${DETAIL_SQL} WHERE p.id = ANY($1)`, [ids]);
    return { items: rows.map(toProduct) };
  }

  /** Interno (Ingestion): mappa EAN -> prodotto. */
  @Public()
  @Get('internal/products/eans')
  async eans() {
    const { rows } = await this.pool.query('SELECT id, ean FROM products WHERE ean IS NOT NULL');
    return { items: rows.map((r) => ({ id: r.id, ean: r.ean })) };
  }
}
