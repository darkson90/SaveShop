import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import { AuthUser, CurrentUser, PG_POOL, settings } from '@spesa/common';
import type Redis from 'ioredis';
import { Pool } from 'pg';

export const REDIS = 'REDIS';
export const statsVersionKey = (userId: string) => `stats:${userId}:version`;

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
    return this.cached(user.userId, `summary:${period}`, async () => {
      const start = PERIOD_START[period];
      // Le tre letture sono indipendenti: in parallelo invece che una dopo l'altra.
      const [totals, top, categories] = await Promise.all([
        this.pool.query(
        `SELECT count(*)::int AS purchases,
                COALESCE(SUM(total_reference - comparable_paid), 0) AS total_saved,
                -- media per spesa di (R - P) / R, solo sulle spese confrontabili
                COALESCE(AVG((total_reference - comparable_paid) / NULLIF(total_reference, 0)) * 100, 0) AS avg_pct,
                COALESCE(SUM(total_paid), 0) AS total_spent
         FROM purchases WHERE user_id = $1 AND purchased_at >= ${start}`,
        [user.userId],
        ),
        this.pool.query(
        `SELECT l.product_id, COALESCE(r.name, 'Prodotto') AS name, count(*)::int AS times, SUM(l.quantity) AS qty
         FROM purchases p JOIN purchase_lines l ON l.purchase_id = p.id
         LEFT JOIN products_ref r ON r.product_id = l.product_id
         WHERE p.user_id = $1 AND p.purchased_at >= ${start}
         GROUP BY l.product_id, r.name
         ORDER BY times DESC, qty DESC, name
         LIMIT 3`,
        [user.userId],
        ),
        this.categoryRows(user.userId, period),
      ]);
      const t = totals.rows[0];
      return {
        period,
        totalSavedEur: round2(Number(t.total_saved)),
        avgSavingPct: Math.round(Number(t.avg_pct) * 10) / 10,
        totalSpentEur: round2(Number(t.total_spent)),
        purchases: t.purchases,
        topProducts: top.rows.map((r) => ({ productId: r.product_id, name: r.name, times: r.times })),
        categories: categories.categories,
      };
    });
  }

  /** Dati del grafico a ciambella: al massimo 6 spicchi più "Altro". */
  @Get('categories')
  async categories(@CurrentUser() user: AuthUser, @Query('period') periodParam?: string) {
    const period = periodOf(periodParam);
    return this.cached(user.userId, `categories:${period}`, () => this.categoryRows(user.userId, period));
  }

  private async categoryRows(userId: string, period: string) {
    const { rows } = await this.pool.query(
      `SELECT category_name AS category, SUM(spent_eur) AS spent
       FROM user_category_spend
       WHERE user_id = $1 AND month >= date_trunc('month', ${PERIOD_START[period]})
       GROUP BY 1 ORDER BY spent DESC`,
      [userId],
    );
    const total = rows.reduce((s, r) => s + Number(r.spent), 0);
    // Le categorie oltre la sesta confluiscono in "Altro", insieme a un'eventuale "Altro" già presente.
    const named = rows.filter((r) => r.category !== 'Altro');
    const head = named.slice(0, settings.num('stats.maxCategorySlices'));
    const otherTotal = total - head.reduce((s, r) => s + Number(r.spent), 0);
    const slices = head.map((r) => ({ category: r.category as string, spent: Number(r.spent) }));
    if (otherTotal > 0.004) slices.push({ category: 'Altro', spent: otherTotal });
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

  /** Cache per utente con versione: una nuova spesa incrementa la versione e invalida tutto in O(1). */
  private async cached<T>(userId: string, name: string, compute: () => Promise<T>): Promise<T> {
    const version = (await this.redis.get(statsVersionKey(userId)).catch(() => null)) ?? '0';
    const key = `stats:${userId}:${version}:${name}`;
    const hit = await this.redis.get(key).catch(() => null);
    if (hit) return JSON.parse(hit);
    const value = await compute();
    const ttl = settings.num('stats.cacheSeconds');
    if (ttl > 0) await this.redis.set(key, JSON.stringify(value), 'EX', ttl).catch(() => undefined);
    return value;
  }
}
