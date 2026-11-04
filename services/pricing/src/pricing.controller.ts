import { createHash } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import {
  AuthUser,
  BearerToken,
  callService,
  CurrentUser,
  PG_POOL,
  radiusKm,
  reqNumber,
  reqUuid,
  serviceUrl,
  settings,
} from '@spesa/common';
import type Redis from 'ioredis';
import { Pool } from 'pg';
import { buildMatrix, Item, perItem, PriceRow, purchaseQuote, singleStore, StoreInfo, twoStores } from './engine';

export const REDIS = 'REDIS';
const MODES = ['single_store', 'two_stores', 'per_item'] as const;

/**
 * Prezzi correnti: la riga aperta (valid_to NULL, servita dall'indice parziale) confermata da una
 * fonte negli ultimi N giorni (parametro pricing.priceMaxAgeDays). Un prezzo che nessuna fonte riporta più (offerta
 * finita, negozio sparito dal feed, segnalazione vecchia) smette di comparire nei confronti.
 */
const CURRENT_PRICES_SQL = `
  SELECT store_id, product_id, price,
         CASE WHEN promo_until < current_date THEN NULL ELSE promo_price END AS promo_price,
         loyalty_only, COALESCE(observed_on, valid_from) AS observed_on
  FROM prices
  WHERE product_id = ANY($1) AND store_id = ANY($2)
    AND valid_to IS NULL AND valid_from <= current_date
    AND COALESCE(observed_on, valid_from) >= current_date - $3::int
    AND (expires_on IS NULL OR expires_on >= current_date)`;

/** Cambia a ogni aggiornamento dei listini: fa parte della chiave di cache, niente scansioni KEYS. */
export const PRICES_VERSION_KEY = 'prices:version';

type Geo = { lat: number; lng: number; radiusKm: number };
type CallAuth = { token?: string; actingUser?: string };

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
    const auth = this.auth(user, token);

    // Lista, negozi ammessi e carte fedeltà in parallelo: sono indipendenti.
    const [list, context, version] = await Promise.all([
      callService<any>(serviceUrl.list(), `/internal/lists/${listId}/items`, auth),
      this.loadContext(auth, geo),
      this.redis.mget(PRICES_VERSION_KEY, 'prices:asof').catch(() => [null, null]),
    ]);
    const items: Item[] = list.items
      .filter((i: any) => i.product && !i.checked)
      .map((i: any) => ({ itemId: i.id, productId: i.product.id, quantity: i.quantity }));

    // La chiave contiene tutto ciò che cambia il risultato: articoli, negozi ammessi (raggio e
    // blacklist), carte fedeltà e versione dei listini. Escludere un negozio dà subito un risultato nuovo.
    const key = 'cmp:' + createHash('sha1')
      .update(JSON.stringify([mode, items, context.stores.map((s) => [s.id, s.distanceKm]), [...context.cards].sort(), version[0]]))
      .digest('hex');
    const cached = await this.redis.get(key).catch(() => null);
    if (cached) return { ...JSON.parse(cached), listId, cached: true };

    const { matrix } = await this.loadMatrix(context, items.map((i) => i.productId));
    const stores = context.stores;
    const base = {
      mode,
      listId,
      computedAt: new Date().toISOString(),
      pricesAsOf: version[1],
      storesConsidered: stores.length,
      unmatchedItems: list.items.filter((i: any) => !i.product).length,
    };
    const result =
      mode === 'single_store'
        ? { ...base, results: singleStore(items, stores, matrix) }
        : mode === 'two_stores'
          ? { ...base, results: twoStores(items, stores, matrix) }
          : { ...base, result: perItem(items, stores, matrix) };

    const ttl = settings.num('pricing.comparisonCacheSeconds');
    if (ttl > 0) await this.redis.set(key, JSON.stringify(result), 'EX', ttl).catch(() => undefined);
    return { ...result, cached: false };
  }

  /** Prezzi correnti di un prodotto nei negozi ammessi, dal più economico. */
  @Get('products/:id/prices')
  async productPrices(@CurrentUser() user: AuthUser, @BearerToken() token: string, @Param('id') id: string, @Query() q: any) {
    const productId = reqUuid(id, 'id');
    const context = await this.loadContext(this.auth(user, token), this.geo({ ...q, radiusKm: q.radius_km ?? q.radiusKm }));
    const { matrix, observedOn } = await this.loadMatrix(context, [productId]);
    const items = context.stores
      .map((s) => ({ store: s, p: matrix.get(s.id)!.get(productId), observedOn: observedOn.get(`${s.id}:${productId}`) }))
      .filter((x) => x.p)
      .map((x) => ({ storeId: x.store.id, name: x.store.name, distanceKm: x.store.distanceKm, ...x.p!, observedOn: x.observedOn }))
      .sort((a, b) => a.unitPrice - b.unitPrice);
    return { productId, items };
  }

  /** Interno (List Service): congela prezzi pagati e di riferimento alla chiusura della spesa. */
  @Post('internal/purchase-quote')
  @HttpCode(200)
  async quote(@CurrentUser() user: AuthUser, @BearerToken() token: string, @Body() body: any) {
    const storeId = reqUuid(body.storeId, 'storeId');
    const items: Item[] = (Array.isArray(body.items) ? body.items : []).map((i: any, idx: number) => ({
      itemId: String(idx),
      productId: reqUuid(i.productId, 'productId'),
      quantity: reqNumber(i.quantity, 'quantity', 0.001, 999),
    }));
    const context = await this.loadContext(this.auth(user, token), this.geo(body));
    const { matrix } = await this.loadMatrix(context, items.map((i) => i.productId));
    const stores = context.stores;
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
      radiusKm: radiusKm(body.radiusKm),
    };
  }

  /** Le chiamate agli altri servizi: con il JWT dell'utente, oppure per suo conto se la richiesta arriva da un servizio. */
  private auth(user: AuthUser, token?: string): CallAuth {
    return token ? { token } : { actingUser: user.userId };
  }

  /** Negozi ammessi (raggio meno blacklist) e insegne di cui l'utente ha la carta. */
  private async loadContext(auth: CallAuth, geo: Geo) {
    const [storesRes, cardsRes] = await Promise.all([
      callService<any>(serviceUrl.store(), `/internal/stores/allowed?lat=${geo.lat}&lng=${geo.lng}&radius_km=${geo.radiusKm}`, auth),
      callService<any>(serviceUrl.user(), '/internal/users/me/loyalty-chains', auth).catch(() => ({ chainIds: [] })),
    ]);
    const stores: StoreInfo[] = storesRes.items.map((s: any) => ({ id: s.id, chainId: s.chainId, name: s.name, distanceKm: s.distanceKm }));
    return { stores, cards: new Set<string>(cardsRes.chainIds) };
  }

  private async loadMatrix(context: { stores: StoreInfo[]; cards: Set<string> }, productIds: string[]) {
    const { stores, cards } = context;
    const { rows } = stores.length && productIds.length
      ? await this.pool.query(CURRENT_PRICES_SQL, [productIds, stores.map((s) => s.id), settings.num('pricing.priceMaxAgeDays')])
      : { rows: [] as any[] };
    const prices: PriceRow[] = rows.map((r) => ({
      storeId: r.store_id,
      productId: r.product_id,
      price: Number(r.price),
      promoPrice: r.promo_price == null ? null : Number(r.promo_price),
      loyaltyOnly: r.loyalty_only,
    }));
    // Data dell'ultima osservazione per "negozio:prodotto", mostrata nel dettaglio prezzi.
    const observedOn = new Map<string, string>(
      rows.map((r) => [`${r.store_id}:${r.product_id}`, new Date(r.observed_on).toISOString().slice(0, 10)]),
    );
    return { matrix: buildMatrix(stores, prices, cards), observedOn };
  }
}
