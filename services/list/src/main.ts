import { Module } from '@nestjs/common';
import { bootstrap, consumeOnce, Events, InfraModule } from '@spesa/common';
import { ListController } from './list.controller';
import { appleAppSiteAssociation, assetLinks, invitePage } from './invite-page';
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
    maintenance: ["DELETE FROM list_invites WHERE expires_at < now() - interval '7 days'"],
    onReady: async (app, { pool, bus }) => {
      await attachLiveUpdates(app.getHttpServer(), pool, bus);
      // Link d'invito pubblici (fuori da /api/v1): pagina di atterraggio e file per App/Universal Links.
      const http = app.getHttpAdapter();
      http.get('/i/:code', (req: any, res: any) => {
        const page = invitePage(String(req.params.code));
        res.status(page.status).type('html').set('Cache-Control', 'no-store').send(page.html);
      });
      http.get('/.well-known/assetlinks.json', (_req: any, res: any) => res.json(assetLinks()));
      http.get('/.well-known/apple-app-site-association', (_req: any, res: any) => res.json(appleAppSiteAssociation()));
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
