import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventBus, Events, reqUuid } from '@spesa/common';
import { Pool, PoolClient } from 'pg';

export type Role = 'owner' | 'editor';

/** La lista con il ruolo dell'utente; 404 anche per chi non è membro, per non rivelarne l'esistenza. */
export async function listAccess(db: Pool | PoolClient, userId: string, id: string): Promise<{ list: any; role: Role }> {
  const { rows } = await db.query(
    `SELECT l.*, m.role FROM shopping_lists l
     JOIN list_members m ON m.list_id = l.id AND m.user_id = $2
     WHERE l.id = $1`,
    [reqUuid(id, 'id'), userId],
  );
  if (!rows[0]) throw new NotFoundException('Lista non trovata');
  return { list: rows[0], role: rows[0].role };
}

export async function requireOwner(db: Pool | PoolClient, userId: string, id: string) {
  const access = await listAccess(db, userId, id);
  if (access.role !== 'owner') throw new ForbiddenException('Operazione riservata a chi ha creato la lista');
  return access;
}

/** Nome mostrato agli altri membri: la parte dell'email prima della chiocciola. */
export function memberLabel(email: string | undefined): string {
  const local = email?.split('@')[0]?.trim();
  return local ? local.slice(0, 40) : 'Membro';
}

export type ListOp = 'item.added' | 'item.updated' | 'item.removed' | 'list.renamed' | 'list.purchased' | 'list.deleted' | 'members.changed';

/**
 * Avvisa in tempo reale i membri collegati (anche su altre repliche del List Service).
 * È un segnale "best effort": il client ricarica la lista, quindi un segnale perso non corrompe nulla.
 */
export async function notifyChange(bus: EventBus, listId: string, op: ListOp, byUserId: string, data: Record<string, unknown> = {}) {
  await bus.broadcast(Events.ListChanged, { listId, op, by: byUserId, ...data }).catch((err) => {
    console.error('[list] segnale ListChanged non inviato:', err);
  });
}
