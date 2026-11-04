import { Module } from '@nestjs/common';
import { bootstrap, consumeOnce, Events, InfraModule } from '@spesa/common';
import { AuthController } from './auth.controller';

bootstrap(
  (infra) => {
    @Module({ imports: [InfraModule.forRoot(infra)], controllers: [AuthController] })
    class AppModule {}
    return AppModule;
  },
  {
    name: 'auth',
    publishes: true,
    maintenance: ["DELETE FROM refresh_tokens WHERE expires_at < now() OR revoked_at < now() - interval '30 days'"],
    onReady: async (_app, { pool, bus }) => {
      // Cancellazione account (GDPR): le credenziali seguono la cancellazione del profilo.
      await bus.subscribe('auth.user-deleted', [Events.UserDeleted], (event) =>
        consumeOnce(pool, event, async (client) => {
          await client.query('DELETE FROM credentials WHERE user_id = $1', [event.payload.userId]);
        }),
      );
    },
  },
);
