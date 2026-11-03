import { createHash } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  AuthUser,
  BearerToken,
  callService,
  CurrentUser,
  optNumber,
  PG_POOL,
  reqNumber,
  reqUuid,
  serviceUrl,
} from '@spesa/common';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import { buildMatrix, Item, perItem, PriceRow, purchaseQuote, singleStore, StoreInfo, twoStores } from './engine';

export const REDIS = 'REDIS';
const CACHE_TTL_SECONDS = 15 * 60;
const MODES = ['single_store', 'two_stores', 'per_item'] as const;

const CURRENT_PRICES_SQL = `
  SELECT store_id, product_id, price, promo_price, loyalty_only
  FROM prices
  WHERE product_id = ANY($1) AND store_id = ANY($2)
    AND valid_from <= current_date AND (valid_to IS NULL OR valid_to >= current_date)`;

@Controller()
export class PricingController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Confronto prezzi della lista. La blacklist è applicata dallo Store Service. */
  @Post('comparisons')
  @HttpCode(200)
  async compare(@CurrentUser() user: AuthUser, @BearerToken() token: string, @Body() body: any) {
    const listId = reqUuid(body.listId, 'listId');
    const mode = (body.mode ?? 'single_store') as (typeof MODES)[number];
    if (!MODES.includes(mode)) throw new BadRequestException(`mode deve essere uno tra ${MODES.join(', ')}`);
    const geo = this.geo(body);

    const list = await callService<any>(serviceUrl.list(), `/internal/lists/${listId}/items`, { token });
    const items: Item[] = list.items
      .filter((i: any) => i.product && !i.checked)
      .map((i: any) => ({ itemId: i.id, productId: i.product.id, quantity: i.quantity }));

    // Posizione arrotondata a ~1 km: chi è nello stesso posto riusa il calcolo.
    const key = 'cmp:' + createHash('sha1')
      .update(JSON.stringify([user.userId, listId, list.updatedAt, mode, geo.lat.toFixed(2), geo.lng.toFixed(2), geo.radiusKm, items]))
      .digest('hex');
    const cached = await this.redis.get(key).catch(() => null);
    if (cached) return { ...JSON.parse(cached), cached: true };

    const { stores, matrix } = await this.loadMatrix(token, geo, items.map((i) => i.productId));
    const base = {
      mode,
      listId,
      computedAt: new Date().toISOString(),
      pricesAsOf: await this.redis.get('prices:asof').catch(() => null),
      storesConsidered: stores.length,
      unmatchedItems: list.items.filter((i: any) => !i.product).length,
    };
    const result =
      mode === 'single_store'
        ? { ...base, results: singleStore(items, stores, matrix) }
        : mode === 'two_stores'
          ? { ...base, results: twoStores(items, stores, matrix) }
          : { ...base, result: perItem(items, stores, matrix) };

    await this.redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS).catch(() => undefined);
    return { ...result, cached: false };
  }

  /** Prezzi correnti di un prodotto nei negozi ammessi, dal più economico. */
  @Get('products/:id/prices')
  async productPrices(@BearerToken() token: string, @Param('id') id: string, @Query() q: any) {
    const productId = reqUuid(id, 'id');
    const { stores, matrix } = await this.loadMatrix(token, this.geo({ ...q, radiusKm: q.radius_km ?? q.radiusKm }), [productId]);
    const items = stores
      .map((s) => ({ store: s, p: matrix.get(s.id)!.get(productId) }))
      .filter((x) => x.p)
      .map((x) => ({ storeId: x.store.id, name: x.store.name, distanceKm: x.store.distanceKm, ...x.p! }))
      .sort((a, b) => a.unitPrice - b.unitPrice);
    return { productId, items };
  }

  /** Interno (List Service): congela prezzi pagati e di riferimento alla chiusura della spesa. */
  @Post('internal/purchase-quote')
  @HttpCode(200)
  async quote(@BearerToken() token: string, @Body() body: any) {
    const storeId = reqUuid(body.storeId, 'storeId');
    const items: Item[] = (Array.isArray(body.items) ? body.items : []).map((i: any, idx: number) => ({
      itemId: String(idx),
      productId: reqUuid(i.productId, 'productId'),
      quantity: reqNumber(i.quantity, 'quantity', 0.001, 999),
    }));
    const { stores, matrix } = await this.loadMatrix(token, this.geo(body), items.map((i) => i.productId));
    if (!matrix.has(storeId)) throw new BadRequestException('Il negozio indicato non è nel raggio o è escluso');
    const overrides: Record<string, number> = {};
    for (const [productId, unitPaid] of Object.entries(body.overrides ?? {})) {
      overrides[reqUuid(productId, 'overrides')] = reqNumber(unitPaid, 'overrides.unitPaid', 0.01, 999);
    }
    return purchaseQuote(items, stores, matrix, storeId, overrides);
  }

  private geo(body: any) {
    return {
      lat: reqNumber(body.lat, 'lat', -90, 90),
      lng: reqNumber(body.lng, 'lng', -180, 180),
      radiusKm: optNumber(body.radiusKm, 'radiusKm', 1, 25) ?? 10,
    };
  }

  private async loadMatrix(token: string, geo: { lat: number; lng: number; radiusKm: number }, productIds: string[]) {
    const [storesRes, cardsRes] = await Promise.all([
      callService<any>(serviceUrl.store(), `/internal/stores/allowed?lat=${geo.lat}&lng=${geo.lng}&radius_km=${geo.radiusKm}`, { token }),
      callService<any>(serviceUrl.user(), '/internal/users/me/loyalty-chains', { token }).catch(() => ({ chainIds: [] })),
    ]);
    const stores: StoreInfo[] = storesRes.items.map((s: any) => ({ id: s.id, chainId: s.chainId, name: s.name, distanceKm: s.distanceKm }));
    const { rows } = stores.length && productIds.length
      ? await this.pool.query(CURRENT_PRICES_SQL, [productIds, stores.map((s) => s.id)])
      : { rows: [] as any[] };
    const prices: PriceRow[] = rows.map((r) => ({
      storeId: r.store_id,
      productId: r.product_id,
      price: Number(r.price),
      promoPrice: r.promo_price == null ? null : Number(r.promo_price),
      loyaltyOnly: r.loyalty_only,
    }));
    return { stores, matrix: buildMatrix(stores, prices, new Set(cardsRes.chainIds)) };
  }
}
