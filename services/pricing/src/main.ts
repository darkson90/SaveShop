import { Module } from '@nestjs/common';
import { bootstrap, consumeOnce, Events, InfraModule } from '@spesa/common';
import Redis from 'ioredis';
import { PricingController, REDIS } from './pricing.controller';
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
    onReady: async (_app, { pool, bus }) => {
      await bus.subscribe('pricing.prices-updated', [Events.PricesUpdated], async (event) => {
        await consumeOnce(pool, event, (client) => applyPricesUpdated(client, event.payload));
        // Prezzi nuovi: i confronti in cache non sono più validi.
        const keys = await redis.keys('cmp:*');
        if (keys.length) await redis.del(...keys);
        await redis.set('prices:asof', event.payload.finishedAt ?? event.occurredAt);
      });
    },
  },
);
