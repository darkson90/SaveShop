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
  }>;
}

/**
 * Applica un lotto di prezzi: chiude le righe correnti delle coppie (negozio, prodotto) ricevute
 * e inserisce i nuovi prezzi validi da validFrom. Lo storico resta interrogabile.
 */
export async function applyPricesUpdated(client: PoolClient, p: PricesUpdatedPayload): Promise<void> {
  if (!p.prices?.length) return;
  const storeIds = p.prices.map((r) => r.storeId);
  const productIds = p.prices.map((r) => r.productId);

  await client.query(
    `UPDATE prices AS pr SET valid_to = ($3::date - 1)
     FROM unnest($1::uuid[], $2::uuid[]) AS u(store_id, product_id)
     WHERE pr.store_id = u.store_id AND pr.product_id = u.product_id
       AND pr.valid_to IS NULL AND pr.valid_from < $3::date`,
    [storeIds, productIds, p.validFrom],
  );
  await client.query(
    `INSERT INTO prices (store_id, product_id, price, promo_price, loyalty_only, valid_from, source, fetched_at)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::numeric[], $4::numeric[], $5::boolean[])
            AS u(store_id, product_id, price, promo_price, loyalty_only),
          LATERAL (SELECT $6::date, $7::text, $8::timestamptz) AS meta
     ON CONFLICT (store_id, product_id, valid_from) DO UPDATE
       SET price = EXCLUDED.price, promo_price = EXCLUDED.promo_price,
           loyalty_only = EXCLUDED.loyalty_only, fetched_at = EXCLUDED.fetched_at, valid_to = NULL`,
    [
      storeIds,
      productIds,
      p.prices.map((r) => r.price),
      p.prices.map((r) => r.promoPrice ?? null),
      p.prices.map((r) => r.loyaltyOnly ?? false),
      p.validFrom,
      p.source,
      p.finishedAt,
    ],
  );
  await client.query(
    `INSERT INTO scrape_runs (id, source, started_at, finished_at, rows_upserted, status)
     VALUES ($1, $2, $3, $4, $5, 'ok')
     ON CONFLICT (id) DO UPDATE SET finished_at = EXCLUDED.finished_at,
       rows_upserted = scrape_runs.rows_upserted + EXCLUDED.rows_upserted, status = 'ok'`,
    [p.runId, p.source, p.startedAt, p.finishedAt, p.prices.length],
  );
}
