import { Module } from '@nestjs/common';
import { bootstrap, consumeOnce, Events, InfraModule } from '@spesa/common';
import Redis from 'ioredis';
import { PRICES_VERSION_KEY, PricingController, REDIS } from './pricing.controller';
import { applyPricesUpdated } from './prices-updated';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379/0', { lazyConnect: false, maxRetriesPerRequest: 2 });

bootstrap(
  (infra) => {
    @Module({
      imports: [InfraModule.forRoot(infra)],
      controllers: [PricingController],
      providers: [{ provide: REDIS, useValue: redis }],
    })
    class AppModule {}
    return AppModule;
  },
  {
    name: 'pricing',
    // Storico prezzi oltre 180 giorni e registro delle esecuzioni oltre 90: non servono ai confronti.
    maintenance: [
      "DELETE FROM prices WHERE valid_to < current_date - 180",
      "DELETE FROM scrape_runs WHERE started_at < now() - interval '90 days'",
    ],
    onReady: async (_app, { pool, bus }) => {
      await bus.subscribe('pricing.prices-updated', [Events.PricesUpdated], async (event) => {
        await consumeOnce(pool, event, (client) => applyPricesUpdated(client, event.payload));
        // Prezzi nuovi: cambiando versione i confronti in cache non vengono più usati e scadono da soli
        // (prima: KEYS cmp:* + DEL, che blocca Redis e cresce con il numero di chiavi).
        await redis
          .multi()
          .incr(PRICES_VERSION_KEY)
          .set('prices:asof', event.payload.finishedAt ?? event.occurredAt)
          .exec()
          .catch((err) => console.error('[pricing] cache non aggiornata:', err.message));
      });
    },
  },
);
