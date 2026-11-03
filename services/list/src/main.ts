import { Module } from '@nestjs/common';
import { bootstrap, consumeOnce, Events, InfraModule } from '@spesa/common';
import { ListController } from './list.controller';
import { attachLiveUpdates } from './live';
import { ReceiptController } from './receipt.controller';
import { ShareController } from './share.controller';

bootstrap(
  (infra) => {
    @Module({
      imports: [InfraModule.forRoot(infra)],
      // ShareController prima di ListController: "lists/join" non deve finire su "lists/:id".
      controllers: [ShareController, ReceiptController, ListController],
    })
    class AppModule {}
    return AppModule;
  },
  {
    name: 'list',
    publishes: true,
    onReady: async (app, { pool, bus }) => {
      await attachLiveUpdates(app.getHttpServer(), pool, bus);
      await bus.subscribe('list.user-deleted', [Events.UserDeleted], (event) =>
        consumeOnce(pool, event, async (client) => {
          const id = event.payload.userId;
          // Le liste create dall'utente spariscono; dalle liste altrui l'utente esce soltanto.
          await client.query('DELETE FROM shopping_lists WHERE user_id = $1', [id]);
          await client.query('DELETE FROM list_members WHERE user_id = $1', [id]);
          await client.query('DELETE FROM user_product_frequency WHERE user_id = $1', [id]);
        }),
      );
    },
  },
);
