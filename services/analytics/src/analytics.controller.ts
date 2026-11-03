import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, PG_POOL } from '@spesa/common';
import type Redis from 'ioredis';
import { Pool } from 'pg';

export const REDIS = 'REDIS';
const CACHE_TTL_SECONDS = 10 * 60;
const MAX_SLICES = 6;

/** Inizio del periodo: mese corrente, ultimi 3 mesi, ultimi 12 mesi, sempre. */
const PERIOD_START: Record<string, string> = {
  month: "date_trunc('month', now())",
  '3months': "date_trunc('month', now()) - interval '2 months'",
  year: "date_trunc('month', now()) - interval '11 months'",
  all: "'-infinity'::timestamptz",
};

function periodOf(value?: string): string {
  const period = value ?? 'all';
  if (!PERIOD_START[period]) throw new BadRequestException(`period deve essere uno tra ${Object.keys(PERIOD_START).join(', ')}`);
  return period;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

@Controller('users/me/stats')
export class AnalyticsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Metriche del profilo: risparmio totale €, risparmio medio %, top 3 prodotti, spesa per categoria. */
  @Get()
  async stats(@CurrentUser() user: AuthUser, @Query('period') periodParam?: string) {
    const period = periodOf(periodParam);
    return this.cached(`stats:${user.userId}:summary:${period}`, async () => {
      const start = PERIOD_START[period];
      const totals = await this.pool.query(
        `SELECT count(*)::int AS purchases,
                COALESCE(SUM(total_reference - comparable_paid), 0) AS total_saved,
                -- media per spesa di (R - P) / R, solo sulle spese confrontabili
                COALESCE(AVG((total_reference - comparable_paid) / NULLIF(total_reference, 0)) * 100, 0) AS avg_pct,
                COALESCE(SUM(total_paid), 0) AS total_spent
         FROM purchases WHERE user_id = $1 AND purchased_at >= ${start}`,
        [user.userId],
      );
      const top = await this.pool.query(
        `SELECT l.product_id, COALESCE(r.name, 'Prodotto') AS name, count(*)::int AS times, SUM(l.quantity) AS qty
         FROM purchases p JOIN purchase_lines l ON l.purchase_id = p.id
         LEFT JOIN products_ref r ON r.product_id = l.product_id
         WHERE p.user_id = $1 AND p.purchased_at >= ${start}
         GROUP BY l.product_id, r.name
         ORDER BY times DESC, qty DESC, name
         LIMIT 3`,
        [user.userId],
      );
      const t = totals.rows[0];
      return {
        period,
        totalSavedEur: round2(Number(t.total_saved)),
        avgSavingPct: Math.round(Number(t.avg_pct) * 10) / 10,
        totalSpentEur: round2(Number(t.total_spent)),
        purchases: t.purchases,
        topProducts: top.rows.map((r) => ({ productId: r.product_id, name: r.name, times: r.times })),
        categories: (await this.categoryRows(user.userId, period)).categories,
      };
    });
  }

  /** Dati del grafico a ciambella: al massimo 6 spicchi più "Altro". */
  @Get('categories')
  async categories(@CurrentUser() user: AuthUser, @Query('period') periodParam?: string) {
    const period = periodOf(periodParam);
    return this.cached(`stats:${user.userId}:categories:${period}`, () => this.categoryRows(user.userId, period));
  }

  private async categoryRows(userId: string, period: string) {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(c.category_name, 'Altro') AS category, SUM(s.spent_eur) AS spent
       FROM user_category_spend s
       LEFT JOIN (SELECT DISTINCT category_id, category_name FROM products_ref) c ON c.category_id = s.category_id
       WHERE s.user_id = $1 AND s.month >= date_trunc('month', ${PERIOD_START[period]})
       GROUP BY 1 ORDER BY spent DESC`,
      [userId],
    );
    const total = rows.reduce((s, r) => s + Number(r.spent), 0);
    const head = rows.slice(0, MAX_SLICES);
    const restTotal = rows.slice(MAX_SLICES).reduce((s, r) => s + Number(r.spent), 0);
    const slices = head.map((r) => ({ category: r.category, spent: Number(r.spent) }));
    if (restTotal > 0) slices.push({ category: 'Altro', spent: restTotal });
    return {
      period,
      totalEur: round2(total),
      categories: slices.map((s) => ({
        category: s.category,
        spentEur: round2(s.spent),
        sharePct: total > 0 ? Math.round((s.spent / total) * 1000) / 10 : 0,
      })),
    };
  }

  private async cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const hit = await this.redis.get(key).catch(() => null);
    if (hit) return JSON.parse(hit);
    const value = await compute();
    await this.redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return value;
  }
}
