import { Module } from '@nestjs/common';
import { bootstrap, consumeOnce, Events, InfraModule } from '@spesa/common';
import Redis from 'ioredis';
import { AnalyticsController, REDIS, statsVersionKey } from './analytics.controller';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379/1', { maxRetriesPerRequest: 2 });

interface Line {
  productId: string;
  quantity: number;
  unitPaid: number;
  unitReference: number | null;
}

/** Lo stesso prodotto due volte nella lista diventa una riga: quantità sommate, prezzi medi ponderati. */
function mergeLines(lines: Line[]): Line[] {
  const byProduct = new Map<string, Line>();
  for (const l of lines) {
    const prev = byProduct.get(l.productId);
    if (!prev) {
      byProduct.set(l.productId, { ...l });
      continue;
    }
    const quantity = prev.quantity + l.quantity;
    const avg = (a: number, b: number) => (a * prev.quantity + b * l.quantity) / quantity;
    byProduct.set(l.productId, {
      productId: l.productId,
      quantity,
      unitPaid: avg(prev.unitPaid, l.unitPaid),
      unitReference: prev.unitReference == null || l.unitReference == null ? null : avg(prev.unitReference, l.unitReference),
    });
  }
  return [...byProduct.values()];
}

/** Nuova versione delle metriche di un utente: le risposte in cache con la versione vecchia non si usano più. */
const bumpStatsVersion = (userId: string) =>
  redis.incr(statsVersionKey(userId)).catch((err) => console.error('[analytics] cache non aggiornata:', err.message));

bootstrap(
  (infra) => {
    @Module({
      imports: [InfraModule.forRoot(infra)],
      controllers: [AnalyticsController],
      providers: [{ provide: REDIS, useValue: redis }],
    })
    class AppModule {}
    return AppModule;
  },
  {
    name: 'analytics',
    onReady: async (_app, { pool, bus }) => {
      await bus.subscribe('analytics.product-created', [Events.ProductCreated], (event) =>
        consumeOnce(pool, event, async (client) => {
          const p = event.payload;
          await client.query(
            `INSERT INTO products_ref (product_id, name, category_id, category_name) VALUES ($1, $2, $3, $4)
             ON CONFLICT (product_id) DO UPDATE SET name = EXCLUDED.name, category_id = EXCLUDED.category_id,
               category_name = EXCLUDED.category_name`,
            [p.productId, p.name, p.categoryId, p.categoryName],
          );
        }),
      );

      await bus.subscribe('analytics.purchase-completed', [Events.PurchaseCompleted], async (event) => {
        const p = event.payload;
        await consumeOnce(pool, event, async (client) => {
          const lines = mergeLines(p.lines ?? []);
          const totalPaid = lines.reduce((s, l) => s + l.quantity * l.unitPaid, 0);
          const comparable = lines.filter((l) => l.unitReference != null);
          const comparablePaid = comparable.reduce((s, l) => s + l.quantity * l.unitPaid, 0);
          const totalReference = comparable.reduce((s, l) => s + l.quantity * (l.unitReference ?? 0), 0);
          await client.query(
            `INSERT INTO purchases (id, user_id, list_id, store_id, purchased_at, total_paid, comparable_paid, total_reference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [p.purchaseId, p.userId, p.listId, p.storeId, p.purchasedAt, totalPaid, comparablePaid, totalReference],
          );
          // Una sola INSERT per tutte le righe (prima una query per riga), con la categoria risolta qui.
          await client.query(
            `INSERT INTO purchase_lines (purchase_id, product_id, category_id, quantity, unit_paid, unit_reference)
             SELECT $1, u.product_id, r.category_id, u.quantity, u.unit_paid, u.unit_reference
             FROM unnest($2::uuid[], $3::numeric[], $4::numeric[], $5::numeric[]) AS u(product_id, quantity, unit_paid, unit_reference)
             LEFT JOIN products_ref r ON r.product_id = u.product_id
             ON CONFLICT (purchase_id, product_id) DO NOTHING`,
            [p.purchaseId, lines.map((l) => l.productId), lines.map((l) => l.quantity), lines.map((l) => l.unitPaid), lines.map((l) => l.unitReference)],
          );
          await client.query(
            `INSERT INTO user_category_spend (user_id, category_name, month, spent_eur)
             SELECT $1, COALESCE(r.category_name, 'Altro'), date_trunc('month', $2::timestamptz)::date, SUM(l.quantity * l.unit_paid)
             FROM purchase_lines l LEFT JOIN products_ref r ON r.product_id = l.product_id
             WHERE l.purchase_id = $3
             GROUP BY 2
             ON CONFLICT (user_id, month, category_name) DO UPDATE SET spent_eur = user_category_spend.spent_eur + EXCLUDED.spent_eur`,
            [p.userId, p.purchasedAt, p.purchaseId],
          );
        });
        await bumpStatsVersion(p.userId);
      });

      await bus.subscribe('analytics.user-deleted', [Events.UserDeleted], async (event) => {
        await consumeOnce(pool, event, async (client) => {
          await client.query('DELETE FROM purchases WHERE user_id = $1', [event.payload.userId]);
          await client.query('DELETE FROM user_category_spend WHERE user_id = $1', [event.payload.userId]);
        });
        await bumpStatsVersion(event.payload.userId);
      });
    },
  },
);
