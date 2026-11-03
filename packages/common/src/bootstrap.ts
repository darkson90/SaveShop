import 'reflect-metadata';
import { join } from 'node:path';
import { Global, INestApplication, Module, DynamicModule, Type } from '@nestjs/common';
import { APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import { Pool } from 'pg';
import { JwtAuthGuard } from './auth';
import { envInt } from './config';
import { createPool, runMigrations } from './db';
import { EventBus, startOutboxRelay } from './events';
import { ProblemFilter } from './http';

export const PG_POOL = 'PG_POOL';
export const EVENT_BUS = 'EVENT_BUS';

export interface Infra {
  pool: Pool;
  bus: EventBus;
}

/** Modulo globale che rende disponibili pool PostgreSQL e bus eventi a tutto il servizio. */
@Global()
@Module({})
export class InfraModule {
  static forRoot(infra: Infra): DynamicModule {
    return {
      module: InfraModule,
      providers: [
        { provide: PG_POOL, useValue: infra.pool },
        { provide: EVENT_BUS, useValue: infra.bus },
        { provide: APP_GUARD, useFactory: (r: Reflector) => new JwtAuthGuard(r), inject: [Reflector] },
      ],
      exports: [PG_POOL, EVENT_BUS],
    };
  }
}

export interface BootstrapOptions {
  name: string;
  /** Cartella delle migrazioni SQL (default: <servizio>/migrations). */
  migrationsDir?: string;
  /** Avvia il relay dell'outbox (servizi che pubblicano eventi). */
  publishes?: boolean;
  /** Registra i consumer di eventi dopo l'avvio. */
  onReady?: (app: INestApplication, infra: Infra) => Promise<void>;
}

/** Avvio standard: migrazioni, connessione al bus, prefisso /api/v1, errori RFC 7807, /health. */
export async function bootstrap(appModule: (infra: Infra) => Type<unknown> | DynamicModule, opts: BootstrapOptions) {
  const pool = createPool();
  await runMigrations(pool, opts.migrationsDir ?? join(process.cwd(), 'migrations'));
  const bus = new EventBus();
  await bus.connect();
  const infra = { pool, bus };

  const app = await NestFactory.create(appModule(infra) as any, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemFilter());
  app.getHttpAdapter().get('/health', (_req: any, res: any) => res.json({ status: 'ok', service: opts.name }));
  app.enableShutdownHooks();

  const relay = opts.publishes ? startOutboxRelay(pool, bus) : undefined;
  await opts.onReady?.(app, infra);

  const port = envInt('PORT', 3000);
  await app.listen(port);
  console.log(`[${opts.name}] in ascolto sulla porta ${port}`);

  const shutdown = async () => {
    if (relay) clearInterval(relay);
    await app.close();
    await bus.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return app;
}
