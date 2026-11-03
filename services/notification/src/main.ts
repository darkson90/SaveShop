import { Module } from '@nestjs/common';
import { bootstrap, consumeOnce, Events, InfraModule } from '@spesa/common';
import { NotificationController } from './notification.controller';
import { notifyOffers } from './notifier';
import { createSender } from './push';

const sender = createSender();

bootstrap(
  (infra) => {
    @Module({ imports: [InfraModule.forRoot(infra)], controllers: [NotificationController] })
    class AppModule {}
    return AppModule;
  },
  {
    name: 'notification',
    onReady: async (_app, { pool, bus }) => {
      // Proiezione dei prodotti frequenti, alimentata dalle aggiunte alla lista.
      await bus.subscribe('notification.item-added', [Events.ItemAdded], (event) =>
        consumeOnce(pool, event, async (client) => {
          const { userId, productId, productName } = event.payload;
          if (!productName) return;
          await client.query(
            `INSERT INTO user_frequent_products (user_id, product_id, product_name, times_added, last_added)
             VALUES ($1, $2, $3, 1, $4)
             ON CONFLICT (user_id, product_id) DO UPDATE
               SET times_added = user_frequent_products.times_added + 1, last_added = EXCLUDED.last_added`,
            [userId, productId, productName, event.occurredAt],
          );
        }),
      );

      await bus.subscribe('notification.prices-updated', [Events.PricesUpdated], async (event) => {
        const notified = await notifyOffers(pool, sender, event.payload);
        if (notified) console.log(`[notification] offerte segnalate a ${notified} utenti`);
      });

      await bus.subscribe('notification.user-deleted', [Events.UserDeleted], (event) =>
        consumeOnce(pool, event, async (client) => {
          const id = event.payload.userId;
          for (const table of ['devices', 'preferences', 'user_frequent_products', 'notifications']) {
            await client.query(`DELETE FROM ${table} WHERE user_id = $1`, [id]);
          }
        }),
      );
    },
  },
);
