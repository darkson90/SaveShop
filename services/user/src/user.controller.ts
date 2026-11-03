import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  addToOutbox,
  AuthUser,
  CurrentUser,
  env,
  Events,
  optNumber,
  PG_POOL,
  reqString,
  reqUuid,
  uuidv7,
  withTx,
} from '@spesa/common';
import { Pool } from 'pg';

/** Cifratura AES-256-GCM del numero di fidelity card: iv(12) | tag(16) | ciphertext. */
function encryptCard(cardNumber: string): Buffer {
  const key = createHash('sha256').update(env('LOYALTY_KEY')).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(cardNumber, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

const PROFILE_SQL = `
  SELECT id, email, display_name, default_radius_km,
         ST_Y(home_location::geometry) AS home_lat, ST_X(home_location::geometry) AS home_lng, created_at
  FROM users WHERE id = $1`;

function toProfile(row: any) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    defaultRadiusKm: row.default_radius_km,
    home: row.home_lat == null ? null : { lat: row.home_lat, lng: row.home_lng },
    createdAt: row.created_at,
  };
}

@Controller()
export class UserController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('users/me')
  async me(@CurrentUser() user: AuthUser) {
    const { rows } = await this.pool.query(PROFILE_SQL, [user.userId]);
    if (!rows[0]) throw new NotFoundException('Profilo non ancora disponibile, riprova tra un istante');
    return toProfile(rows[0]);
  }

  @Patch('users/me')
  async update(@CurrentUser() user: AuthUser, @Body() body: any) {
    const radius = optNumber(body.defaultRadiusKm, 'defaultRadiusKm', 1, 25);
    const lat = optNumber(body.home?.lat, 'home.lat', -90, 90);
    const lng = optNumber(body.home?.lng, 'home.lng', -180, 180);
    const name = typeof body.displayName === 'string' ? body.displayName.slice(0, 80) : undefined;
    await this.pool.query(
      `UPDATE users SET
         display_name = COALESCE($2, display_name),
         default_radius_km = COALESCE($3, default_radius_km),
         home_location = CASE WHEN $4::float8 IS NULL THEN home_location
                              ELSE ST_SetSRID(ST_MakePoint($5, $4), 4326)::geography END
       WHERE id = $1`,
      [user.userId, name ?? null, radius ?? null, lat ?? null, lng ?? null],
    );
    return this.me(user);
  }

  /** Diritto all'oblio: elimina il profilo e notifica gli altri servizi con UserDeleted. */
  @Delete('users/me')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser) {
    await withTx(this.pool, async (client) => {
      await client.query('DELETE FROM users WHERE id = $1', [user.userId]);
      await addToOutbox(client, Events.UserDeleted, { userId: user.userId });
    });
  }

  @Get('users/me/loyalty-cards')
  async cards(@CurrentUser() user: AuthUser) {
    const { rows } = await this.pool.query(
      'SELECT id, chain_id, card_last4, created_at FROM loyalty_cards WHERE user_id = $1 ORDER BY created_at',
      [user.userId],
    );
    return { items: rows.map((r) => ({ id: r.id, chainId: r.chain_id, last4: r.card_last4, createdAt: r.created_at })) };
  }

  @Post('users/me/loyalty-cards')
  async addCard(@CurrentUser() user: AuthUser, @Body() body: any) {
    const chainId = reqUuid(body.chainId, 'chainId');
    const cardNumber = reqString(body, 'cardNumber', 40).replace(/\s/g, '');
    const id = uuidv7();
    const res = await this.pool.query(
      `INSERT INTO loyalty_cards (id, user_id, chain_id, card_number_enc, card_last4)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, chain_id) DO NOTHING`,
      [id, user.userId, chainId, encryptCard(cardNumber), cardNumber.slice(-4)],
    );
    if (!res.rowCount) throw new ConflictException('Hai già una carta per questa insegna');
    return { id, chainId, last4: cardNumber.slice(-4) };
  }

  @Delete('users/me/loyalty-cards/:id')
  @HttpCode(204)
  async removeCard(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const res = await this.pool.query('DELETE FROM loyalty_cards WHERE id = $1 AND user_id = $2', [reqUuid(id, 'id'), user.userId]);
    if (!res.rowCount) throw new NotFoundException('Carta non trovata');
  }

  /** Interno (Pricing Service): insegne per cui l'utente ha una carta, per applicare i prezzi riservati. */
  @Get('internal/users/me/loyalty-chains')
  async loyaltyChains(@CurrentUser() user: AuthUser) {
    const { rows } = await this.pool.query('SELECT chain_id FROM loyalty_cards WHERE user_id = $1', [user.userId]);
    return { chainIds: rows.map((r) => r.chain_id) };
  }
}
