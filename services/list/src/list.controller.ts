import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  addToOutbox,
  AuthUser,
  BearerToken,
  callService,
  CurrentUser,
  Events,
  optNumber,
  pageParams,
  PG_POOL,
  reqNumber,
  reqString,
  reqUuid,
  serviceUrl,
  uuidv7,
  withTx,
} from '@spesa/common';
import { Pool, PoolClient } from 'pg';
import { parseInput } from './parser';

/** Sotto questa confidenza la voce resta "libera" e l'app propone di sceglierne il prodotto. */
const MIN_MATCH_CONFIDENCE = 0.45;

function toItem(r: any) {
  return {
    id: r.id,
    raw: r.raw_text,
    quantity: Number(r.quantity),
    unit: r.unit,
    product: r.product_id ? { id: r.product_id, name: r.product_name, category: r.category } : null,
    matchConfidence: r.match_confidence == null ? null : Number(r.match_confidence),
    checked: r.checked,
    position: r.position,
  };
}

function toList(r: any) {
  return { id: r.id, name: r.name, status: r.status, itemCount: Number(r.item_count ?? 0), updatedAt: r.updated_at };
}

@Controller()
export class ListController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get('lists')
  async lists(@CurrentUser() user: AuthUser, @Query() q: any) {
    const { cursor, limit } = pageParams(q);
    const { rows } = await this.pool.query(
      `SELECT l.*, (SELECT count(*) FROM list_items i WHERE i.list_id = l.id) AS item_count
       FROM shopping_lists l
       WHERE l.user_id = $1 AND ($2::uuid IS NULL OR l.id < $2) AND l.status <> 'archived'
       ORDER BY l.id DESC LIMIT $3`,
      [user.userId, cursor ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    return { items: page.map(toList), nextCursor: rows.length > limit ? page.at(-1).id : null };
  }

  @Post('lists')
  async create(@CurrentUser() user: AuthUser, @Body() body: any) {
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : 'Spesa';
    const { rows } = await this.pool.query(
      'INSERT INTO shopping_lists (id, user_id, name) VALUES ($1, $2, $3) RETURNING *',
      [uuidv7(), user.userId, name],
    );
    return { ...toList(rows[0]), items: [] };
  }

  @Get('lists/frequent-products')
  async frequent(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    const { rows } = await this.pool.query(
      `SELECT product_id, product_name, times_added FROM user_product_frequency
       WHERE user_id = $1 ORDER BY times_added DESC, last_added DESC LIMIT $2`,
      [user.userId, optNumber(limit, 'limit', 1, 20) ?? 10],
    );
    return { items: rows.map((r) => ({ productId: r.product_id, name: r.product_name, times: r.times_added })) };
  }

  @Get('lists/:id')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const list = await this.ownList(this.pool, user.userId, id);
    const { rows } = await this.pool.query('SELECT * FROM list_items WHERE list_id = $1 ORDER BY position', [list.id]);
    return { ...toList({ ...list, item_count: rows.length }), items: rows.map(toItem) };
  }

  @Patch('lists/:id')
  async rename(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: any) {
    await this.ownList(this.pool, user.userId, id);
    const name = reqString(body, 'name', 60);
    await this.pool.query('UPDATE shopping_lists SET name = $2, updated_at = now() WHERE id = $1', [id, name]);
    return this.detail(user, id);
  }

  @Delete('lists/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.ownList(this.pool, user.userId, id);
    await this.pool.query('DELETE FROM shopping_lists WHERE id = $1', [id]);
  }

  /**
   * Inserimento rapido: accetta testo libero ("2 latte"), oppure productId + quantity dai chip.
   * L'header Idempotency-Key rende sicuro il reinvio dalla coda offline dell'app.
   */
  @Post('lists/:id/items')
  async addItem(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const list = await this.ownList(this.pool, user.userId, id);
    if (list.status !== 'open') throw new ConflictException('La lista è già chiusa');
    if (idemKey) {
      const existing = await this.pool.query('SELECT * FROM list_items WHERE list_id = $1 AND idempotency_key = $2', [id, idemKey]);
      if (existing.rows[0]) return toItem(existing.rows[0]);
    }

    let product: any = null;
    let confidence: number | null = null;
    let raw: string;
    let quantity: number;
    let unit: string | undefined;

    if (body?.productId) {
      const { items } = await callService<any>(serviceUrl.catalog(), '/internal/products/batch', {
        method: 'POST',
        asService: true,
        body: { ids: [reqUuid(body.productId, 'productId')] },
      });
      if (!items[0]) throw new NotFoundException('Prodotto non trovato');
      product = items[0];
      confidence = 1;
      raw = product.name;
      quantity = optNumber(body.quantity, 'quantity', 0.001, 999) ?? 1;
    } else {
      raw = reqString(body, 'raw', 120);
      const parsed = parseInput(raw);
      quantity = optNumber(body.quantity, 'quantity', 0.001, 999) ?? parsed.quantity;
      unit = parsed.unit;
      const match = await callService<any>(serviceUrl.catalog(), `/internal/products/match?q=${encodeURIComponent(parsed.text)}`, {
        asService: true,
      });
      if (match.product && match.confidence >= MIN_MATCH_CONFIDENCE) {
        product = match.product;
        confidence = match.confidence;
        // "spaghetti 500 g": la grammatura descrive la confezione, non la quantità da comprare.
        if (parsed.unit && parsed.unit !== product.unit) quantity = 1;
      }
    }

    return withTx(this.pool, async (client) => {
      const pos = await client.query('SELECT COALESCE(MAX(position), 0) + 1 AS next FROM list_items WHERE list_id = $1', [id]);
      const { rows } = await client.query(
        `INSERT INTO list_items (id, list_id, product_id, product_name, category, raw_text, quantity, unit, match_confidence, position, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [uuidv7(), id, product?.id ?? null, product?.name ?? null, product?.category ?? null, raw, quantity,
          product?.unit ?? unit ?? 'pz', confidence, pos.rows[0].next, idemKey ?? null],
      );
      await client.query('UPDATE shopping_lists SET updated_at = now() WHERE id = $1', [id]);
      if (product) {
        await client.query(
          `INSERT INTO user_product_frequency (user_id, product_id, product_name, times_added, last_added)
           VALUES ($1, $2, $3, 1, now())
           ON CONFLICT (user_id, product_id) DO UPDATE SET times_added = user_product_frequency.times_added + 1, last_added = now()`,
          [user.userId, product.id, product.name],
        );
        await addToOutbox(client, Events.ItemAdded, { userId: user.userId, listId: id, productId: product.id, productName: product.name });
      }
      return toItem(rows[0]);
    });
  }

  @Patch('lists/:id/items/:itemId')
  async updateItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string, @Body() body: any) {
    await this.ownList(this.pool, user.userId, id);
    const quantity = optNumber(body.quantity, 'quantity', 0.001, 999);
    const checked = typeof body.checked === 'boolean' ? body.checked : null;
    let productId: string | null = null;
    let productName: string | null = null;
    let category: string | null = null;
    if (body.productId) {
      // Abbinamento manuale di una voce libera
      const { items } = await callService<any>(serviceUrl.catalog(), '/internal/products/batch', {
        method: 'POST',
        asService: true,
        body: { ids: [reqUuid(body.productId, 'productId')] },
      });
      if (!items[0]) throw new NotFoundException('Prodotto non trovato');
      ({ id: productId, name: productName, category } = items[0]);
    }
    const { rows } = await this.pool.query(
      `UPDATE list_items SET
         quantity = COALESCE($3, quantity),
         checked = COALESCE($4, checked),
         product_id = COALESCE($5, product_id),
         product_name = COALESCE($6, product_name),
         category = COALESCE($7, category),
         match_confidence = CASE WHEN $5::uuid IS NULL THEN match_confidence ELSE 1 END
       WHERE id = $1 AND list_id = $2 RETURNING *`,
      [reqUuid(itemId, 'itemId'), id, quantity ?? null, checked, productId, productName, category],
    );
    if (!rows[0]) throw new NotFoundException('Articolo non trovato');
    await this.pool.query('UPDATE shopping_lists SET updated_at = now() WHERE id = $1', [id]);
    return toItem(rows[0]);
  }

  @Delete('lists/:id/items/:itemId')
  @HttpCode(204)
  async removeItem(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('itemId') itemId: string) {
    await this.ownList(this.pool, user.userId, id);
    const res = await this.pool.query('DELETE FROM list_items WHERE id = $1 AND list_id = $2', [reqUuid(itemId, 'itemId'), id]);
    if (!res.rowCount) throw new NotFoundException('Articolo non trovato');
    await this.pool.query('UPDATE shopping_lists SET updated_at = now() WHERE id = $1', [id]);
  }

  /**
   * Chiusura spesa: il Pricing Service congela prezzo pagato e prezzo di riferimento per riga,
   * poi l'evento PurchaseCompleted alimenta le metriche dell'Analytics Service.
   */
  @Post('lists/:id/purchase')
  async purchase(@CurrentUser() user: AuthUser, @BearerToken() token: string, @Param('id') id: string, @Body() body: any) {
    const list = await this.ownList(this.pool, user.userId, id);
    if (list.status !== 'open') throw new ConflictException('La lista è già chiusa');
    const storeId = reqUuid(body.storeId, 'storeId');
    const lat = reqNumber(body.lat, 'lat', -90, 90);
    const lng = reqNumber(body.lng, 'lng', -180, 180);
    const radiusKm = optNumber(body.radiusKm, 'radiusKm', 1, 25) ?? 10;

    const { rows: items } = await this.pool.query(
      'SELECT product_id, quantity FROM list_items WHERE list_id = $1 AND product_id IS NOT NULL',
      [id],
    );
    if (!items.length) throw new BadRequestException('Nessun articolo abbinato al catalogo nella lista');

    const quote = await callService<any>(serviceUrl.pricing(), '/internal/purchase-quote', {
      method: 'POST',
      token,
      body: { storeId, lat, lng, radiusKm, items: items.map((i) => ({ productId: i.product_id, quantity: Number(i.quantity) })) },
    });

    const purchaseId = uuidv7();
    const purchasedAt = new Date().toISOString();
    await withTx(this.pool, async (client) => {
      await client.query("UPDATE shopping_lists SET status = 'purchased', updated_at = now() WHERE id = $1", [id]);
      await addToOutbox(client, Events.PurchaseCompleted, {
        purchaseId,
        userId: user.userId,
        listId: id,
        storeId,
        referenceStoreId: quote.referenceStoreId,
        purchasedAt,
        lines: quote.lines,
      });
    });

    return {
      purchaseId,
      listId: id,
      storeId,
      purchasedAt,
      totalPaid: quote.totalPaid,
      totalReference: quote.totalReference,
      savedEur: quote.savedEur,
      savedPct: quote.savedPct,
      missingItems: quote.missingItems,
    };
  }

  /** Interno (Pricing Service): articoli abbinati della lista, con verifica di proprietà. */
  @Get('internal/lists/:id/items')
  async internalItems(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const list = await this.ownList(this.pool, user.userId, id);
    const { rows } = await this.pool.query('SELECT * FROM list_items WHERE list_id = $1 ORDER BY position', [id]);
    return { listId: id, updatedAt: list.updated_at, items: rows.map(toItem) };
  }

  private async ownList(db: Pool | PoolClient, userId: string, id: string) {
    const { rows } = await db.query('SELECT * FROM shopping_lists WHERE id = $1 AND user_id = $2', [reqUuid(id, 'id'), userId]);
    if (!rows[0]) throw new NotFoundException('Lista non trovata');
    return rows[0];
  }
}
