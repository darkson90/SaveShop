import { Module } from '@nestjs/common';
import { bootstrap, consumeOnce, Events, InfraModule } from '@spesa/common';
import { UserController } from './user.controller';

bootstrap(
  (infra) => {
    @Module({ imports: [InfraModule.forRoot(infra)], controllers: [UserController] })
    class AppModule {}
    return AppModule;
  },
  {
    name: 'user',
    publishes: true,
    onReady: async (_app, { pool, bus }) => {
      // Il profilo nasce quando l'Auth Service registra le credenziali.
      await bus.subscribe('user.user-registered', [Events.UserRegistered], (event) =>
        consumeOnce(pool, event, async (client) => {
          const { userId, email, displayName } = event.payload;
          await client.query(
            'INSERT INTO users (id, email, display_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
            [userId, email, displayName],
          );
        }),
      );
    },
  },
);
