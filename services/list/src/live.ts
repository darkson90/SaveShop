import { IncomingMessage, Server } from 'node:http';
import { EventBus, Events, verifyAccessToken } from '@spesa/common';
import { Pool } from 'pg';
import { WebSocket, WebSocketServer } from 'ws';

const PATH = /^\/api\/v1\/lists\/([0-9a-f-]{36})\/live$/i;
const HEARTBEAT_MS = 25_000;

interface Client extends WebSocket {
  userId: string;
  listId: string;
  alive: boolean;
}

/**
 * Aggiornamenti in tempo reale delle liste condivise: GET /api/v1/lists/{id}/live (WebSocket).
 * Autenticazione con l'header Authorization: Bearer <JWT>, come le chiamate REST.
 * I messaggi sono segnali ({ op, itemId, by }): il client ricarica la lista, così il server resta
 * l'unica fonte di verità e un messaggio perso non lascia dati incoerenti.
 */
export async function attachLiveUpdates(server: Server, pool: Pool, bus: EventBus): Promise<void> {
  const wss = new WebSocketServer({ noServer: true });
  const byList = new Map<string, Set<Client>>();

  server.on('upgrade', async (req: IncomingMessage, socket, head) => {
    const match = req.url?.split('?')[0].match(PATH);
    if (!match) return socket.destroy();
    const reject = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    let userId: string;
    try {
      const header = req.headers.authorization ?? '';
      userId = verifyAccessToken(header.replace(/^Bearer /, '')).userId;
    } catch {
      return reject(401, 'Unauthorized');
    }
    const listId = match[1];
    const member = await pool
      .query('SELECT 1 FROM list_members WHERE list_id = $1 AND user_id = $2', [listId, userId])
      .catch(() => ({ rowCount: 0 }));
    if (!member.rowCount) return reject(404, 'Not Found');

    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = Object.assign(ws, { userId, listId, alive: true }) as Client;
      const set = byList.get(listId) ?? new Set<Client>();
      set.add(client);
      byList.set(listId, set);
      client.on('pong', () => (client.alive = true));
      client.on('close', () => {
        set.delete(client);
        if (!set.size) byList.delete(listId);
      });
      client.send(JSON.stringify({ op: 'hello', listId }));
    });
  });

  // Ogni replica riceve tutti i segnali e li inoltra ai propri client della lista interessata.
  await bus.onBroadcast([Events.ListChanged], ({ payload }) => {
    const clients = byList.get(payload.listId);
    if (!clients) return;
    const message = JSON.stringify(payload);
    for (const c of clients) {
      if (c.readyState !== WebSocket.OPEN) continue;
      // Un membro rimosso viene scollegato.
      if (payload.op === 'members.changed' && payload.removed === c.userId) {
        c.close(4403, 'Rimosso dalla lista');
        continue;
      }
      c.send(message);
      if (payload.op === 'list.deleted') c.close(4410, 'Lista eliminata');
    }
  });

  // Connessioni morte (rete mobile che cade) chiuse con il ping periodico.
  const timer = setInterval(() => {
    for (const set of byList.values()) {
      for (const c of set) {
        if (!c.alive) {
          c.terminate();
          continue;
        }
        c.alive = false;
        c.ping();
      }
    }
  }, HEARTBEAT_MS);
  timer.unref();
}
