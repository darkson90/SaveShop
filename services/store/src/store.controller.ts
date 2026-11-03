import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  addToOutbox,
  AuthUser,
  CurrentUser,
  Events,
  optNumber,
  PG_POOL,
  Public,
  reqNumber,
  reqUuid,
  uuidv7,
  withTx,
} from '@spesa/common';
import { Pool } from 'pg';

/** Negozi attivi entro il raggio, esclusi quelli in blacklist (per punto vendita o per insegna). */
const NEARBY_SQL = `
  SELECT s.id, s.chain_id, c.name AS chain_name, s.name, s.address,
         ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng,
         ST_Distance(s.location, ST_MakePoint($2, $1)::geography) / 1000 AS distance_km
  FROM stores s JOIN chains c ON c.id = s.chain_id
  WHERE s.active
    AND ST_DWithin(s.location, ST_MakePoint($2, $1)::geography, $3 * 1000)
    AND NOT EXISTS (
      SELECT 1 FROM excluded_stores e
      WHERE e.user_id = $4 AND (e.store_id = s.id OR e.chain_id = s.chain_id))
  ORDER BY distance_km`;

function toStore(r: any) {
  return {
    id: r.id,
    chainId: r.chain_id,
    chainName: r.chain_name,
    name: r.name,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    ...(r.distance_km != null ? { distanceKm: Math.round(r.distance_km * 10) / 10 } : {}),
  };
}

@Controller()
export class StoreController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('stores')
  async nearby(@CurrentUser() user: AuthUser, @Query() q: any) {
    return { items: await this.findAllowed(user.userId, q) };
  }

  @Get('stores/chains')
  async chains() {
    const { rows } = await this.pool.query('SELECT id, name FROM chains ORDER BY name');
    return { items: rows };
  }

  @Get('stores/:id')
  async detail(@Param('id') id: string) {
    const { rows } = await this.pool.query(
      `SELECT s.id, s.chain_id, c.name AS chain_name, s.name, s.address,
              ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng
       FROM stores s JOIN chains c ON c.id = s.chain_id WHERE s.id = $1`,
      [reqUuid(id, 'id')],
    );
    if (!rows[0]) throw new NotFoundException('Negozio non trovato');
    return toStore(rows[0]);
  }

  @Get('users/me/excluded-stores')
  async excluded(@CurrentUser() user: AuthUser) {
    const { rows } = await this.pool.query(
      `SELECT e.id, e.store_id, e.chain_id, e.created_at,
              COALESCE(s.name, c.name) AS label, (e.chain_id IS NOT NULL) AS whole_chain
       FROM excluded_stores e
       LEFT JOIN stores s ON s.id = e.store_id
       LEFT JOIN chains c ON c.id = e.chain_id
       WHERE e.user_id = $1 ORDER BY e.created_at DESC`,
      [user.userId],
    );
    return {
      items: rows.map((r) => ({
        id: r.id,
        storeId: r.store_id,
        chainId: r.chain_id,
        label: r.label,
        kind: r.whole_chain ? 'chain' : 'store',
        createdAt: r.created_at,
      })),
    };
  }

  /** Esclude un singolo punto vendita ({storeId}) oppure un'intera insegna ({chainId}). */
  @Post('users/me/excluded-stores')
  async exclude(@CurrentUser() user: AuthUser, @Body() body: any) {
    const storeId = body.storeId ? reqUuid(body.storeId, 'storeId') : null;
    const chainId = body.chainId ? reqUuid(body.chainId, 'chainId') : null;
    if (!storeId === !chainId) throw new BadRequestException('Indica storeId oppure chainId');
    const id = uuidv7();
    return withTx(this.pool, async (client) => {
      const res = await client.query(
        'INSERT INTO excluded_stores (id, user_id, store_id, chain_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
        [id, user.userId, storeId, chainId],
      ).catch((err) => {
        if (err.code === '23503') throw new NotFoundException('Negozio o insegna inesistente');
        throw err;
      });
      if (!res.rowCount) throw new ConflictException('Già escluso');
      await addToOutbox(client, Events.StoreExcluded, { userId: user.userId, storeId, chainId });
      return { id, storeId, chainId, kind: storeId ? 'store' : 'chain' };
    });
  }

  @Delete('users/me/excluded-stores/:id')
  @HttpCode(204)
  async restore(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const res = await this.pool.query('DELETE FROM excluded_stores WHERE id = $1 AND user_id = $2', [reqUuid(id, 'id'), user.userId]);
    if (!res.rowCount) throw new NotFoundException('Esclusione non trovata');
  }

  /** Interno (Pricing Service): negozi ammessi = raggio meno blacklist. */
  @Get('internal/stores/allowed')
  async allowed(@CurrentUser() user: AuthUser, @Query() q: any) {
    return { items: await this.findAllowed(user.userId, q) };
  }

  /** Interno (Ingestion): risolve il codice del punto vendita della fonte esterna. */
  @Public()
  @Get('internal/stores/by-ref')
  async byRef() {
    const { rows } = await this.pool.query('SELECT id, external_ref FROM stores WHERE external_ref IS NOT NULL');
    return { items: rows.map((r) => ({ id: r.id, externalRef: r.external_ref })) };
  }

  private async findAllowed(userId: string, q: any) {
    const lat = reqNumber(q.lat, 'lat', -90, 90);
    const lng = reqNumber(q.lng, 'lng', -180, 180);
    const radius = optNumber(q.radius_km ?? q.radiusKm, 'radius_km', 1, 25) ?? 10;
    const { rows } = await this.pool.query(NEARBY_SQL, [lat, lng, radius, userId]);
    return rows.map(toStore);
  }
}
