import { Module } from '@nestjs/common';
import { bootstrap, consumeOnce, Events, InfraModule } from '@spesa/common';
import Redis from 'ioredis';
import { AnalyticsController, REDIS } from './analytics.controller';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379/1', { maxRetriesPerRequest: 2 });

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
          const lines: any[] = p.lines ?? [];
          const totalPaid = lines.reduce((s, l) => s + l.quantity * l.unitPaid, 0);
          const comparable = lines.filter((l) => l.unitReference != null);
          const comparablePaid = comparable.reduce((s, l) => s + l.quantity * l.unitPaid, 0);
          const totalReference = comparable.reduce((s, l) => s + l.quantity * l.unitReference, 0);
          await client.query(
            `INSERT INTO purchases (id, user_id, list_id, store_id, purchased_at, total_paid, comparable_paid, total_reference)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [p.purchaseId, p.userId, p.listId, p.storeId, p.purchasedAt, totalPaid, comparablePaid, totalReference],
          );
          for (const l of lines) {
            await client.query(
              `INSERT INTO purchase_lines (purchase_id, product_id, category_id, quantity, unit_paid, unit_reference)
               VALUES ($1, $2, (SELECT category_id FROM products_ref WHERE product_id = $2), $3, $4, $5)`,
              [p.purchaseId, l.productId, l.quantity, l.unitPaid, l.unitReference],
            );
          }
        });
        await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY user_category_spend');
        const keys = await redis.keys(`stats:${p.userId}:*`);
        if (keys.length) await redis.del(...keys);
      });

      await bus.subscribe('analytics.user-deleted', [Events.UserDeleted], async (event) => {
        await consumeOnce(pool, event, async (client) => {
          await client.query('DELETE FROM purchases WHERE user_id = $1', [event.payload.userId]);
        });
        await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY user_category_spend');
      });
    },
  },
);
