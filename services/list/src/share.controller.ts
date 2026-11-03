import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  GoneException,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { AuthUser, CurrentUser, EVENT_BUS, EventBus, PG_POOL, reqString, reqUuid, withTx } from '@spesa/common';
import { Pool } from 'pg';
import { listAccess, memberLabel, notifyChange, requireOwner } from './access';

export const MAX_MEMBERS = 5;
const INVITE_TTL_HOURS = 48;
// Senza caratteri ambigui (0/O, 1/I/L): il codice si detta anche a voce.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode(): string {
  return Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

/** Condivisione di una lista: codice d'invito, ingresso con il codice, gestione dei membri. */
@Controller('lists')
export class ShareController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  /** Il proprietario genera un codice valido 48 ore; un nuovo codice revoca il precedente. */
  @Post(':id/invites')
  async invite(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await requireOwner(this.pool, user.userId, id);
    return withTx(this.pool, async (client) => {
      await client.query('UPDATE list_invites SET revoked_at = now() WHERE list_id = $1 AND revoked_at IS NULL', [id]);
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        const res = await client.query(
          `INSERT INTO list_invites (code, list_id, created_by, expires_at)
           VALUES ($1, $2, $3, now() + make_interval(hours => $4))
           ON CONFLICT (code) DO NOTHING RETURNING expires_at`,
          [code, id, user.userId, INVITE_TTL_HOURS],
        );
        if (res.rowCount) return { code, expiresAt: res.rows[0].expires_at, maxMembers: MAX_MEMBERS };
      }
      throw new ConflictException('Riprova a generare il codice');
    });
  }

  @Post('join')
  @HttpCode(200)
  async join(@CurrentUser() user: AuthUser, @Body() body: any) {
    const code = reqString(body, 'code', 12).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const listId = await withTx(this.pool, async (client) => {
      const { rows } = await client.query(
        `SELECT i.list_id, i.expires_at, i.revoked_at, l.status
         FROM list_invites i JOIN shopping_lists l ON l.id = i.list_id
         WHERE i.code = $1 FOR UPDATE OF l`,
        [code],
      );
      const invite = rows[0];
      if (!invite) throw new NotFoundException('Codice non valido');
      if (invite.revoked_at || invite.expires_at < new Date()) throw new GoneException('Codice scaduto: chiedine uno nuovo');
      if (invite.status !== 'open') throw new ConflictException('Questa lista è già stata chiusa');
      const members = await client.query('SELECT user_id FROM list_members WHERE list_id = $1', [invite.list_id]);
      if (members.rows.some((m) => m.user_id === user.userId)) return invite.list_id; // già membro: idempotente
      if (members.rowCount! >= MAX_MEMBERS) throw new ConflictException(`La lista ha già ${MAX_MEMBERS} membri`);
      await client.query(
        "INSERT INTO list_members (list_id, user_id, role, label) VALUES ($1, $2, 'editor', $3)",
        [invite.list_id, user.userId, memberLabel(user.email)],
      );
      return invite.list_id;
    });
    await notifyChange(this.bus, listId, 'members.changed', user.userId);
    return { listId };
  }

  @Get(':id/members')
  async members(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await listAccess(this.pool, user.userId, id);
    const { rows } = await this.pool.query(
      'SELECT user_id, role, label, joined_at FROM list_members WHERE list_id = $1 ORDER BY joined_at',
      [id],
    );
    return { items: rows.map((r) => ({ userId: r.user_id, role: r.role, label: r.label, joinedAt: r.joined_at, isMe: r.user_id === user.userId })) };
  }

  /** Il proprietario rimuove un membro; un membro può uscire da solo. Il proprietario non può uscire. */
  @Delete(':id/members/:userId')
  @HttpCode(204)
  async removeMember(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('userId') memberId: string) {
    const { role } = await listAccess(this.pool, user.userId, id);
    reqUuid(memberId, 'userId');
    const self = memberId === user.userId;
    if (!self && role !== 'owner') throw new ForbiddenException('Solo chi ha creato la lista può rimuovere i membri');
    if (self && role === 'owner') throw new BadRequestException('Chi ha creato la lista non può uscirne: può eliminarla');
    const res = await this.pool.query("DELETE FROM list_members WHERE list_id = $1 AND user_id = $2 AND role <> 'owner'", [id, memberId]);
    if (!res.rowCount) throw new NotFoundException('Membro non trovato');
    await notifyChange(this.bus, id, 'members.changed', user.userId, { removed: memberId });
  }
}
