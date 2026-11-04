import { PoolClient } from 'pg';

export interface PricesUpdatedPayload {
  runId: string;
  source: string;
  startedAt: string;
  finishedAt: string;
  validFrom: string; // YYYY-MM-DD
  prices: Array<{
    storeId: string;
    productId: string;
    price: number;
    promoPrice?: number | null;
    loyaltyOnly?: boolean;
    /** Giorno dell'osservazione (YYYY-MM-DD); se manca vale validFrom. */
    observedOn?: string | null;
  }>;
}

/**
 * Applica un lotto di prezzi: chiude le righe correnti delle coppie (negozio, prodotto) ricevute
 * e inserisce i nuovi prezzi validi da validFrom. Lo storico resta interrogabile.
 */
export async function applyPricesUpdated(client: PoolClient, p: PricesUpdatedPayload): Promise<void> {
  if (!p.prices?.length) return;
  // Una coppia ripetuta nello stesso lotto farebbe fallire l'INSERT … ON CONFLICT ("cannot affect
  // row a second time") e con lui tutto il lotto: vale l'ultima riga, come in un listino.
  const unique = [...new Map(p.prices.map((r) => [`${r.storeId}:${r.productId}`, r])).values()];
  const storeIds = unique.map((r) => r.storeId);
  const productIds = unique.map((r) => r.productId);

  await client.query(
    `UPDATE prices AS pr SET valid_to = ($3::date - 1)
     FROM unnest($1::uuid[], $2::uuid[]) AS u(store_id, product_id)
     WHERE pr.store_id = u.store_id AND pr.product_id = u.product_id
       AND pr.valid_to IS NULL AND pr.valid_from < $3::date`,
    [storeIds, productIds, p.validFrom],
  );
  await client.query(
    `INSERT INTO prices (store_id, product_id, price, promo_price, loyalty_only, observed_on, valid_from, source, fetched_at)
     SELECT u.store_id, u.product_id, u.price, u.promo_price, u.loyalty_only, COALESCE(u.observed_on, $6::date),
            $6::date, $7::text, $8::timestamptz
     FROM unnest($1::uuid[], $2::uuid[], $3::numeric[], $4::numeric[], $5::boolean[], $9::date[])
          AS u(store_id, product_id, price, promo_price, loyalty_only, observed_on)
     ON CONFLICT (store_id, product_id, valid_from) DO UPDATE
       SET price = EXCLUDED.price, promo_price = EXCLUDED.promo_price, loyalty_only = EXCLUDED.loyalty_only,
           observed_on = EXCLUDED.observed_on, fetched_at = EXCLUDED.fetched_at, valid_to = NULL`,
    [
      storeIds,
      productIds,
      unique.map((r) => r.price),
      unique.map((r) => r.promoPrice ?? null),
      unique.map((r) => r.loyaltyOnly ?? false),
      p.validFrom,
      p.source,
      p.finishedAt,
      unique.map((r) => r.observedOn ?? null),
    ],
  );
  await client.query(
    `INSERT INTO scrape_runs (id, source, started_at, finished_at, rows_upserted, status)
     VALUES ($1, $2, $3, $4, $5, 'ok')
     ON CONFLICT (id) DO UPDATE SET finished_at = EXCLUDED.finished_at,
       rows_upserted = scrape_runs.rows_upserted + EXCLUDED.rows_upserted, status = 'ok'`,
    [p.runId, p.source, p.startedAt, p.finishedAt, unique.length],
  );
}
