import 'reflect-metadata';
import { join } from 'node:path';
import { Global, INestApplication, Module, DynamicModule, Type } from '@nestjs/common';
import { APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import { Pool } from 'pg';
import { JwtAuthGuard } from './auth';
import { envInt } from './config';
import { createPool, runMigrations, startMaintenance } from './db';
import { EventBus, startOutboxRelay } from './events';
import { ProblemFilter } from './http';
import { settings } from './settings';

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
  /** Pulizie periodiche specifiche del servizio (SQL), oltre a outbox e processed_events. */
  maintenance?: string[];
  /** SQL eseguito su ogni nuova connessione al database (es. soglie di pg_trgm). */
  sessionSql?: string;
}

/** Avvio standard: migrazioni, connessione al bus, prefisso /api/v1, errori RFC 7807, /health e /ready. */
export async function bootstrap(appModule: (infra: Infra) => Type<unknown> | DynamicModule, opts: BootstrapOptions) {
  const pool = createPool(opts.sessionSql);
  await runMigrations(pool, opts.migrationsDir ?? join(process.cwd(), 'migrations'));
  const bus = new EventBus();
  await bus.connect();
  // I parametri del pannello: il Config Service ne è la fonte e li gestisce da sé.
  if (opts.name !== 'config') await settings.start(bus);
  const infra = { pool, bus };

  const app = await NestFactory.create(appModule(infra) as any, { logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemFilter());
  // /health: il processo è vivo (liveness). /ready: può servire richieste, cioè database e bus raggiungibili.
  const http = app.getHttpAdapter();
  http.get('/health', (_req: any, res: any) => res.json({ status: 'ok', service: opts.name }));
  http.get('/ready', async (_req: any, res: any) => {
    try {
      await pool.query('SELECT 1');
      if (!bus.connected) throw new Error('bus non connesso');
      res.json({ status: 'ready', service: opts.name });
    } catch (err) {
      res.status(503).json({ status: 'unavailable', service: opts.name, detail: (err as Error).message });
    }
  });

  const relay = opts.publishes ? startOutboxRelay(pool, bus) : undefined;
  const maintenance = startMaintenance(pool, opts.maintenance ?? []);
  await opts.onReady?.(app, infra);

  const port = envInt('PORT', 3000);
  await app.listen(port);
  console.log(`[${opts.name}] in ascolto sulla porta ${port}`);

  const shutdown = async () => {
    if (relay) clearInterval(relay);
    clearInterval(maintenance);
    await app.close();
    await bus.close();
    await pool.end();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return app;
}
