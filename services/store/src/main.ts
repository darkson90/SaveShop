import { Module } from '@nestjs/common';
import { bootstrap, consumeOnce, Events, InfraModule } from '@spesa/common';
import { StoreController } from './store.controller';

bootstrap(
  (infra) => {
    @Module({ imports: [InfraModule.forRoot(infra)], controllers: [StoreController] })
    class AppModule {}
    return AppModule;
  },
  {
    name: 'store',
    publishes: true,
    onReady: async (_app, { pool, bus }) => {
      await bus.subscribe('store.user-deleted', [Events.UserDeleted], (event) =>
        consumeOnce(pool, event, async (client) => {
          await client.query('DELETE FROM excluded_stores WHERE user_id = $1', [event.payload.userId]);
        }),
      );
    },
  },
);
