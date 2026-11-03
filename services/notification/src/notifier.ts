import { callService, serviceUrl, uuidv7 } from '@spesa/common';
import { Pool } from 'pg';
import { AllowedStore, FrequentProduct, Offer, promosFrom, pushText, selectOffers } from './offers';
import { PushSender } from './push';

/** Un prodotto è "frequente" dopo almeno N aggiunte alla lista. */
const MIN_TIMES_ADDED = Number(process.env.NOTIFY_MIN_TIMES_ADDED ?? 2);

interface PricesUpdated {
  validFrom: string;
  prices: Array<{ storeId: string; productId: string; price: number; promoPrice?: number | null; loyaltyOnly?: boolean }>;
}

/**
 * Su PricesUpdated: per ogni utente che ha attivato le offerte, segnala le promo sui suoi prodotti
 * frequenti nei negozi ammessi (raggio dalla posizione di casa, blacklist esclusa).
 * Idempotente: il vincolo UNIQUE su (utente, prodotto, negozio, giorno) impedisce i doppioni,
 * quindi un evento consegnato due volte non genera una seconda push.
 */
export async function notifyOffers(pool: Pool, sender: PushSender, payload: PricesUpdated): Promise<number> {
  const promos = promosFrom(payload.prices ?? []);
  if (!promos.length) return 0;

  const { rows } = await pool.query(
    `SELECT f.user_id, f.product_id, f.product_name
     FROM user_frequent_products f
     JOIN preferences p ON p.user_id = f.user_id AND p.offers_enabled
     WHERE f.product_id = ANY($1) AND f.times_added >= $2`,
    [[...new Set(promos.map((p) => p.productId))], MIN_TIMES_ADDED],
  );
  const byUser = new Map<string, FrequentProduct[]>();
  for (const r of rows) {
    const list = byUser.get(r.user_id) ?? [];
    list.push({ productId: r.product_id, productName: r.product_name });
    byUser.set(r.user_id, list);
  }

  let notified = 0;
  for (const [userId, frequent] of byUser) {
    try {
      const offers = await offersForUser(userId, frequent, promos);
      const fresh = await saveOffers(pool, userId, offers, payload.validFrom);
      if (fresh.length) {
        notified++;
        await push(pool, sender, userId, fresh);
      }
    } catch (err) {
      console.error(`[notification] utente ${userId}:`, err); // un utente in errore non blocca gli altri
    }
  }
  return notified;
}

async function offersForUser(userId: string, frequent: FrequentProduct[], promos: ReturnType<typeof promosFrom>): Promise<Offer[]> {
  const profile = await callService<any>(serviceUrl.user(), '/users/me', { actingUser: userId });
  if (!profile.home) return []; // senza posizione di casa non sappiamo quali negozi sono "vicini"
  const [stores, cards] = await Promise.all([
    callService<{ items: AllowedStore[] }>(
      serviceUrl.store(),
      `/internal/stores/allowed?lat=${profile.home.lat}&lng=${profile.home.lng}&radius_km=${profile.defaultRadiusKm}`,
      { actingUser: userId },
    ),
    callService<{ chainIds: string[] }>(serviceUrl.user(), '/internal/users/me/loyalty-chains', { actingUser: userId }),
  ]);
  return selectOffers(promos, frequent, stores.items, new Set(cards.chainIds));
}

/** Registra le offerte nello storico e restituisce solo quelle mai segnalate prima. */
async function saveOffers(pool: Pool, userId: string, offers: Offer[], validFrom: string): Promise<Offer[]> {
  const fresh: Offer[] = [];
  for (const o of offers) {
    const res = await pool.query(
      `INSERT INTO notifications (id, user_id, product_id, product_name, store_id, store_name, price, promo_price, loyalty_only, valid_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, product_id, store_id, valid_from) DO NOTHING`,
      [uuidv7(), userId, o.productId, o.productName, o.storeId, o.storeName, o.price, o.promoPrice, o.loyaltyOnly, validFrom],
    );
    if (res.rowCount) fresh.push(o);
  }
  return fresh;
}

async function push(pool: Pool, sender: PushSender, userId: string, offers: Offer[]): Promise<void> {
  const { rows } = await pool.query('SELECT token FROM devices WHERE user_id = $1', [userId]);
  if (!rows.length) return; // le offerte restano comunque nella casella "Offerte per te"
  const result = await sender.send(rows.map((r) => r.token), { ...pushText(offers), data: { route: '/offerte' } });
  if (result.invalidTokens.length) await pool.query('DELETE FROM devices WHERE token = ANY($1)', [result.invalidTokens]);
  if (result.sent) {
    await pool.query(
      `UPDATE notifications SET pushed_at = now()
       WHERE user_id = $1 AND pushed_at IS NULL AND product_id = ANY($2)`,
      [userId, offers.map((o) => o.productId)],
    );
  }
}
