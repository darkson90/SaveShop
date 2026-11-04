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
  radiusKm,
  PG_POOL,
  ServiceOnly,
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

  /**
   * Interno (Ingestion): crea o aggiorna i punti vendita arrivati da una fonte esterna
   * (es. "osm:node:2620770361" da Open Prices). L'insegna si crea al primo uso.
   */
  @ServiceOnly()
  @Post('internal/stores/upsert')
  async upsert(@Body() body: any) {
    const items: any[] = Array.isArray(body?.items) ? body.items.slice(0, 500) : [];
    return withTx(this.pool, async (client) => {
      const result: Array<{ externalRef: string; id: string }> = [];
      for (const raw of items) {
        const externalRef = typeof raw?.externalRef === 'string' ? raw.externalRef.slice(0, 100) : '';
        const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 120) : '';
        const lat = Number(raw?.lat);
        const lng = Number(raw?.lng);
        if (!externalRef || !name || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
        const chainName = (typeof raw.chain === 'string' && raw.chain.trim() ? raw.chain : name).trim().slice(0, 80);
        const chain = await client.query(
          `INSERT INTO chains (id, name) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          [uuidv7(), chainName],
        );
        const store = await client.query(
          `INSERT INTO stores (id, chain_id, name, address, location, external_ref)
           VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($6, $5), 4326)::geography, $7)
           ON CONFLICT (external_ref) DO UPDATE
             SET name = EXCLUDED.name, address = EXCLUDED.address, location = EXCLUDED.location, active = true
           RETURNING id`,
          [uuidv7(), chain.rows[0].id, name, typeof raw.address === 'string' ? raw.address.slice(0, 200) : '', lat, lng, externalRef],
        );
        result.push({ externalRef, id: store.rows[0].id });
      }
      return { items: result };
    });
  }

  /**
   * Interno (Ingestion): punti vendita attivi delle insegne indicate entro l'area di raccolta, per applicare
   * a tutti i negozi di un'insegna un listino unico (es. i prezzi online di Carrefour).
   */
  @ServiceOnly()
  @Post('internal/stores/chain-members')
  @HttpCode(200)
  async chainMembers(@Body() body: any) {
    const chains: string[] = (Array.isArray(body?.chains) ? body.chains : [])
      .filter((c: unknown) => typeof c === 'string' && c.trim())
      .slice(0, 20)
      .map((c: string) => c.trim().toLowerCase());
    if (!chains.length) return { items: [] };
    const lat = reqNumber(body.lat, 'lat', -90, 90);
    const lng = reqNumber(body.lng, 'lng', -180, 180);
    const radius = reqNumber(body.radiusKm, 'radiusKm', 1, 500);
    const { rows } = await this.pool.query(
      `SELECT s.id, c.name AS chain_name FROM stores s JOIN chains c ON c.id = s.chain_id
       WHERE s.active AND lower(c.name) = ANY($1)
         AND ST_DWithin(s.location, ST_MakePoint($3, $2)::geography, $4 * 1000)`,
      [chains, lat, lng, radius],
    );
    return { items: rows.map((r) => ({ id: r.id, chainName: r.chain_name })) };
  }

  /** Interno (Ingestion): risolve il codice del punto vendita della fonte esterna. */
  @ServiceOnly()
  @Get('internal/stores/by-ref')
  async byRef() {
    const { rows } = await this.pool.query('SELECT id, external_ref FROM stores WHERE external_ref IS NOT NULL');
    return { items: rows.map((r) => ({ id: r.id, externalRef: r.external_ref })) };
  }

  private async findAllowed(userId: string, q: any) {
    const lat = reqNumber(q.lat, 'lat', -90, 90);
    const lng = reqNumber(q.lng, 'lng', -180, 180);
    const radius = radiusKm(q.radius_km ?? q.radiusKm);
    const { rows } = await this.pool.query(NEARBY_SQL, [lat, lng, radius, userId]);
    return rows.map(toStore);
  }
}
