import { Module } from '@nestjs/common';
import { bootstrap, consumeOnce, Events, InfraModule } from '@spesa/common';
import { ListController } from './list.controller';

bootstrap(
  (infra) => {
    @Module({ imports: [InfraModule.forRoot(infra)], controllers: [ListController] })
    class AppModule {}
    return AppModule;
  },
  {
    name: 'list',
    publishes: true,
    onReady: async (_app, { pool, bus }) => {
      await bus.subscribe('list.user-deleted', [Events.UserDeleted], (event) =>
        consumeOnce(pool, event, async (client) => {
          await client.query('DELETE FROM shopping_lists WHERE user_id = $1', [event.payload.userId]);
          await client.query('DELETE FROM user_product_frequency WHERE user_id = $1', [event.payload.userId]);
        }),
      );
    },
  },
);
