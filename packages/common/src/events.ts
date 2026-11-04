import * as amqp from 'amqplib';
import { Pool, PoolClient } from 'pg';
import { env } from './config';
import { uuidv7 } from './ids';

export const EXCHANGE = 'spesa.events';
/** Messaggi falliti due volte: restano qui per essere ispezionati e, se serve, rimessi in coda. */
export const DEAD_LETTER_QUEUE = 'spesa.dead';

export interface EventEnvelope<T = unknown> {
  eventId: string;
  type: string;
  occurredAt: string;
  payload: T;
}

/** Tipi di evento del dominio (vedi specifiche, sezione Architettura). */
export const Events = {
  UserRegistered: 'UserRegistered',
  UserDeleted: 'UserDeleted',
  StoreExcluded: 'StoreExcluded',
  ProductCreated: 'ProductCreated',
  ItemAdded: 'ItemAdded',
  PurchaseCompleted: 'PurchaseCompleted',
  PricesUpdated: 'PricesUpdated',
  /** Segnale effimero via broadcast(): una lista condivisa è cambiata. */
  ListChanged: 'ListChanged',
  /** Segnale effimero via broadcast(): un parametro è stato modificato dal pannello. */
  SettingsChanged: 'SettingsChanged',
} as const;

type Handler = (event: EventEnvelope<any>) => Promise<void>;

/**
 * Bus eventi su RabbitMQ con exchange topic. La consegna è "almeno una volta":
 * i consumer usano consumeOnce() per l'idempotenza tramite eventId.
 */
export class EventBus {
  private connection?: Awaited<ReturnType<typeof amqp.connect>>;
  private channel?: amqp.Channel;
  /** Canale con conferme del broker: un evento è "pubblicato" solo quando RabbitMQ lo ha preso in carico. */
  private confirmChannel?: amqp.ConfirmChannel;
  private closing = false;
  /** eventId restituiti dal broker perché nessuna coda era legata a quel tipo di evento. */
  private returned = new Set<string>();

  constructor(private readonly url = env('AMQP_URL', 'amqp://guest:guest@rabbitmq:5672')) {}

  async connect(retries = 30): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        this.connection = await amqp.connect(this.url);
        this.channel = await this.connection.createChannel();
        this.confirmChannel = await this.connection.createConfirmChannel();
        this.confirmChannel.on('return', (msg) => {
          if (msg.properties.messageId) this.returned.add(String(msg.properties.messageId));
        });
        await this.channel.assertExchange(EXCHANGE, 'topic', { durable: true });
        await this.channel.assertQueue(DEAD_LETTER_QUEUE, { durable: true });
        await this.channel.prefetch(20);
        // Connessione persa (broker riavviato, rete): senza bus il servizio non può funzionare
        // correttamente, quindi esce e lascia che Docker/Kubernetes lo riavvii pulito.
        this.connection.on('close', () => {
          if (this.closing) return;
          console.error('[events] connessione a RabbitMQ persa: riavvio del servizio');
          process.exit(1);
        });
        this.connection.on('error', (err) => console.error('[events] errore RabbitMQ:', err.message));
        return;
      } catch (err) {
        if (attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, 1000 * Math.min(attempt, 5)));
      }
    }
  }

  get connected(): boolean {
    return !!this.channel && !this.closing;
  }

  /** Pubblica un lotto di eventi e attende la conferma del broker per tutti. */
  /**
   * Restituisce gli eventId che nessuna coda ha ricevuto (mandatory): succede all'avvio, quando chi li
   * consuma non ha ancora creato la sua coda. Il relay dell'outbox li ripubblica poco dopo.
   */
  async publish(...envelopes: EventEnvelope[]): Promise<string[]> {
    if (!this.confirmChannel) throw new Error('EventBus non connesso');
    for (const envelope of envelopes) {
      this.confirmChannel.publish(EXCHANGE, envelope.type, Buffer.from(JSON.stringify(envelope)), {
        persistent: true,
        contentType: 'application/json',
        messageId: envelope.eventId,
        mandatory: true,
      });
    }
    // Il broker invia basic.return prima della conferma: dopo waitForConfirms l'elenco è completo.
    await this.confirmChannel.waitForConfirms();
    const unroutable = envelopes.map((e) => e.eventId).filter((id) => this.returned.delete(id));
    return unroutable;
  }

  /** Crea una coda durevole per il servizio e la lega ai tipi di evento richiesti. */
  async subscribe(queue: string, types: string[], handler: Handler): Promise<void> {
    if (!this.channel) throw new Error('EventBus non connesso');
    const ch = this.channel;
    await ch.assertQueue(queue, { durable: true });
    for (const type of types) await ch.bindQueue(queue, EXCHANGE, type);
    await ch.consume(queue, async (msg) => {
      if (!msg) return;
      try {
        await handler(JSON.parse(msg.content.toString()));
        ch.ack(msg);
      } catch (err) {
        console.error(`[events] errore su ${queue}:`, err);
        if (!msg.fields.redelivered) {
          ch.nack(msg, false, true); // un secondo tentativo
          return;
        }
        // Fallito due volte: messo da parte in una coda da ispezionare invece di perderlo.
        ch.sendToQueue(DEAD_LETTER_QUEUE, msg.content, {
          persistent: true,
          contentType: 'application/json',
          headers: { 'x-original-queue': queue, 'x-error': String((err as Error)?.message ?? err).slice(0, 500) },
        });
        ch.ack(msg);
      }
    });
  }

  /**
   * Segnale effimero (non persistente, niente outbox): serve a notificare in tempo reale le altre
   * istanze, ad esempio i client WebSocket collegati a un'altra replica dello stesso servizio.
   */
  async broadcast(type: string, payload: unknown): Promise<void> {
    if (!this.channel) throw new Error('EventBus non connesso');
    this.channel.publish(EXCHANGE, type, Buffer.from(JSON.stringify({ type, payload, at: new Date().toISOString() })), {
      persistent: false,
      contentType: 'application/json',
      expiration: '10000',
    });
  }

  /** Ogni istanza riceve tutti i segnali: coda esclusiva, eliminata quando l'istanza si ferma. */
  async onBroadcast(types: string[], handler: (msg: { type: string; payload: any }) => void): Promise<void> {
    if (!this.channel) throw new Error('EventBus non connesso');
    const ch = this.channel;
    const { queue } = await ch.assertQueue('', { exclusive: true, autoDelete: true });
    for (const type of types) await ch.bindQueue(queue, EXCHANGE, type);
    await ch.consume(queue, (msg) => {
      if (!msg) return;
      try {
        handler(JSON.parse(msg.content.toString()));
      } catch (err) {
        console.error('[events] segnale non valido:', err);
      }
    }, { noAck: true });
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.confirmChannel?.close().catch(() => undefined);
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}

/** Pattern outbox: l'evento viene scritto nella stessa transazione della modifica di dominio. */
export async function addToOutbox(client: PoolClient | Pool, type: string, payload: unknown): Promise<void> {
  await client.query('INSERT INTO outbox (id, type, payload) VALUES ($1, $2, $3)', [uuidv7(), type, JSON.stringify(payload)]);
}

/** Inoltra periodicamente sul bus gli eventi dell'outbox non ancora pubblicati. */
/** Per quanto si ritenta un evento che nessuna coda riceve: dopo, si considera senza destinatari. */
const UNROUTABLE_RETRY_MS = 10 * 60_000;

export function startOutboxRelay(pool: Pool, bus: EventBus, intervalMs = 500): NodeJS.Timeout {
  let running = false;
  const nextTry = new Map<string, number>(); // eventi senza coda in attesa di un nuovo tentativo
  return setInterval(async () => {
    if (running) return;
    running = true;
    let client: PoolClient | undefined;
    try {
      // Controllo leggero (indice parziale) prima di aprire una transazione: quasi sempre l'outbox è vuota.
      const pending = await pool.query('SELECT 1 FROM outbox WHERE published_at IS NULL LIMIT 1');
      if (!pending.rowCount) return;
      client = await pool.connect();
      await client.query('BEGIN');
      const now = Date.now();
      const waiting = [...nextTry].filter(([, at]) => at > now).map(([id]) => id);
      // Quelli in attesa di un nuovo tentativo restano fuori, così non bloccano gli eventi successivi.
      const { rows } = await client.query(
        `SELECT id, type, payload, created_at FROM outbox
         WHERE published_at IS NULL AND NOT (id = ANY($1::uuid[]))
         ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`,
        [waiting],
      );
      const due = rows;
      const unroutable = new Set(
        await bus.publish(
          ...due.map((row) => ({ eventId: row.id, type: row.type, occurredAt: row.created_at.toISOString(), payload: row.payload })),
        ),
      );
      // Un evento senza coda (es. al primo avvio il consumer non c'è ancora) si ritenta ogni 5 secondi
      // per 10 minuti, poi si chiude: alcuni tipi di evento non hanno davvero destinatari.
      const done = due.filter((r) => !unroutable.has(r.id) || now - r.created_at.getTime() > UNROUTABLE_RETRY_MS).map((r) => r.id);
      for (const r of due) {
        if (done.includes(r.id)) nextTry.delete(r.id);
        else nextTry.set(r.id, now + 5000);
      }
      if (done.length) {
        await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1)', [done]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client?.query('ROLLBACK').catch(() => undefined);
      console.error('[outbox] relay fallito:', err);
    } finally {
      client?.release();
      running = false;
    }
  }, intervalMs);
}

/** Esegue l'handler una sola volta per eventId, nella stessa transazione della registrazione. */
export async function consumeOnce(pool: Pool, event: EventEnvelope, fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [event.eventId],
    );
    if (inserted.rowCount) await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
