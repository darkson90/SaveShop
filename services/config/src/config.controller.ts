import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  AdminOnly,
  AuthUser,
  callService,
  CurrentUser,
  EVENT_BUS,
  EventBus,
  Events,
  optNumber,
  PG_POOL,
  Public,
  reqString,
  serviceUrl,
  ServiceOnly,
  SETTING_GROUPS,
  SETTINGS,
  SETTINGS_BY_KEY,
  uuidv7,
  validateSetting,
  withTx,
} from '@spesa/common';
import { Pool } from 'pg';

/** Servizi controllati nella panoramica dello stato. */
const SERVICES = ['auth', 'user', 'store', 'catalog', 'list', 'pricing', 'analytics', 'notification'] as const;

@Controller()
export class ConfigController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(EVENT_BUS) private readonly bus: EventBus,
  ) {}

  private async overrides(): Promise<Map<string, { value: unknown; updated_at: Date; updated_by: string }>> {
    const { rows } = await this.pool.query('SELECT key, value, updated_at, updated_by FROM settings');
    return new Map(rows.map((r) => [r.key, r]));
  }

  // ---------- Per i servizi e per l'app ----------

  /** Interno: i valori impostati dal pannello, letti da ogni servizio all'avvio e a ogni modifica. */
  @ServiceOnly()
  @Get('internal/settings')
  async internal() {
    const values: Record<string, unknown> = {};
    for (const [key, row] of await this.overrides()) if (SETTINGS_BY_KEY.has(key)) values[key] = row.value;
    return { values };
  }

  /** Pubblico (senza accesso): i parametri che l'app legge all'avvio, ad esempio l'avviso di manutenzione. */
  @Public()
  @Get('config/public')
  async publicConfig() {
    const over = await this.overrides();
    const values: Record<string, unknown> = {};
    for (const def of SETTINGS.filter((s) => s.public)) values[def.key] = over.has(def.key) ? over.get(def.key)!.value : def.default;
    return { values };
  }

  // ---------- Pannello di amministrazione ----------

  /** Accesso al pannello: credenziali verificate dall'Auth Service, poi solo chi ha il ruolo admin. */
  @Public()
  @Post('admin/login')
  @HttpCode(200)
  async login(@Body() body: any) {
    const res = await callService<any>(serviceUrl.auth(), '/auth/login', {
      method: 'POST',
      body: { email: reqString(body, 'email', 254), password: reqString(body, 'password', 200) },
    });
    if (res.role !== 'admin') throw new ForbiddenException('Questo account non è amministratore');
    return { accessToken: res.accessToken, refreshToken: res.refreshToken, expiresIn: res.expiresIn, email: String(body.email).toLowerCase() };
  }

  @Public()
  @Post('admin/refresh')
  @HttpCode(200)
  async refresh(@Body() body: any) {
    const res = await callService<any>(serviceUrl.auth(), '/auth/refresh', {
      method: 'POST',
      body: { refreshToken: reqString(body, 'refreshToken', 200) },
    });
    if (res.role !== 'admin') throw new ForbiddenException('Questo account non è più amministratore');
    return { accessToken: res.accessToken, refreshToken: res.refreshToken, expiresIn: res.expiresIn };
  }

  @AdminOnly()
  @Get('admin/settings')
  async list() {
    const over = await this.overrides();
    return {
      groups: SETTING_GROUPS,
      settings: SETTINGS.map((def) => {
        const row = over.get(def.key);
        return {
          ...def,
          value: row ? row.value : def.default,
          modified: !!row,
          updatedAt: row?.updated_at ?? null,
          updatedBy: row?.updated_by ?? null,
        };
      }),
    };
  }

  /**
   * Salva più modifiche insieme: `values` imposta, `reset` riporta al predefinito.
   * Tutto o niente: un valore non valido blocca l'intero salvataggio e indica quale parametro correggere.
   */
  @AdminOnly()
  @Patch('admin/settings')
  async save(@CurrentUser() admin: AuthUser, @Body() body: any) {
    const values: Record<string, unknown> = body?.values && typeof body.values === 'object' ? body.values : {};
    const reset: string[] = Array.isArray(body?.reset) ? body.reset.map(String) : [];
    const keys = [...Object.keys(values), ...reset];
    if (!keys.length) throw new BadRequestException('Nessuna modifica da salvare');

    const errors: Record<string, string> = {};
    const clean: Record<string, unknown> = {};
    for (const key of keys) {
      const def = SETTINGS_BY_KEY.get(key);
      if (!def) {
        errors[key] = 'parametro sconosciuto';
        continue;
      }
      if (key in values) {
        try {
          clean[key] = validateSetting(def, values[key]);
        } catch (err) {
          errors[key] = (err as Error).message;
        }
      }
    }
    if (Object.keys(errors).length) {
      throw new BadRequestException(
        Object.entries(errors).map(([k, m]) => `${SETTINGS_BY_KEY.get(k)?.label ?? k}: ${m}`).join('; '),
      );
    }

    const by = admin.email || admin.userId;
    await withTx(this.pool, async (client) => {
      const { rows } = await client.query('SELECT key, value FROM settings WHERE key = ANY($1) FOR UPDATE', [keys]);
      const before = new Map(rows.map((r) => [r.key, r.value]));
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      for (const [key, value] of Object.entries(clean)) {
        const def = SETTINGS_BY_KEY.get(key)!;
        const old = before.has(key) ? before.get(key) : undefined;
        if (same(value, def.default)) {
          // Uguale al predefinito: si toglie la modifica, così un futuro cambio del predefinito vale anche qui.
          if (old === undefined) continue;
          await client.query('DELETE FROM settings WHERE key = $1', [key]);
        } else {
          if (old !== undefined && same(old, value)) continue;
          await client.query(
            `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
            [key, JSON.stringify(value), by],
          );
        }
        await client.query(
          'INSERT INTO settings_audit (id, key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5)',
          [uuidv7(), key, old === undefined ? null : JSON.stringify(old), same(value, def.default) ? null : JSON.stringify(value), by],
        );
      }
      for (const key of reset) {
        if (!before.has(key)) continue;
        await client.query('DELETE FROM settings WHERE key = $1', [key]);
        await client.query(
          'INSERT INTO settings_audit (id, key, old_value, new_value, changed_by) VALUES ($1, $2, $3, NULL, $4)',
          [uuidv7(), key, JSON.stringify(before.get(key)), by],
        );
      }
    });
    // I servizi rileggono i parametri subito (e comunque entro un minuto se il segnale si perde).
    await this.bus.broadcast(Events.SettingsChanged, { keys }).catch(() => undefined);
    return this.list();
  }

  @AdminOnly()
  @Get('admin/audit')
  async audit(@Query('limit') limit?: string) {
    const { rows } = await this.pool.query(
      'SELECT id, key, old_value, new_value, changed_by, changed_at FROM settings_audit ORDER BY changed_at DESC, id DESC LIMIT $1',
      [optNumber(limit, 'limit', 1, 500) ?? 100],
    );
    return {
      items: rows.map((r) => {
        const def = SETTINGS_BY_KEY.get(r.key);
        return {
          id: r.id,
          key: r.key,
          label: def?.label ?? r.key,
          unit: def?.unit ?? null,
          oldValue: r.old_value ?? def?.default ?? null,
          newValue: r.new_value ?? def?.default ?? null,
          wasDefault: r.old_value === null,
          isDefault: r.new_value === null,
          changedBy: r.changed_by,
          changedAt: r.changed_at,
        };
      }),
    };
  }

  /**
   * Prezzi raccolti, per controllare i dati delle fonti: dal Pricing, con nomi di prodotti e negozi
   * presi da Catalogo e Store.
   */
  @AdminOnly()
  @Get('admin/collected')
  async collected(@Query() q: any) {
    const params = new URLSearchParams();
    if (typeof q.source === 'string' && q.source) params.set('source', q.source.slice(0, 80));
    if (q.promo === '1') params.set('promo', '1');
    params.set('limit', String(optNumber(q.limit, 'limit', 1, 500) ?? 100));
    params.set('offset', String(optNumber(q.offset, 'offset', 0, 1_000_000) ?? 0));
    const data = await callService<any>(serviceUrl.pricing(), `/internal/prices/collected?${params}`, { asService: true });
    const productIds = [...new Set<string>(data.items.map((i: any) => i.productId))];
    const storeIds = [...new Set<string>(data.items.flatMap((i: any) => i.sampleStores))];
    const products = new Map<string, any>();
    for (let i = 0; i < productIds.length; i += 200) {
      const res = await callService<any>(serviceUrl.catalog(), '/internal/products/batch', {
        method: 'POST', body: { ids: productIds.slice(i, i + 200) }, asService: true,
      });
      for (const p of res.items) products.set(p.id, p);
    }
    const stores = new Map<string, any>();
    if (storeIds.length) {
      const res = await callService<any>(serviceUrl.store(), '/internal/stores/batch', { method: 'POST', body: { ids: storeIds }, asService: true });
      for (const st of res.items) stores.set(st.id, st);
    }
    return {
      total: data.total,
      items: data.items.map((i: any) => {
        const p = products.get(i.productId);
        return {
          ...i,
          product: p ? { name: p.name, brand: p.brand, ean: p.ean ?? null, category: p.category ?? null } : null,
          sampleStores: i.sampleStores.map((id: string) => {
            const st = stores.get(id);
            return st ? { name: st.name, chain: st.chainName, address: st.address } : { name: id };
          }),
        };
      }),
    };
  }

  @AdminOnly()
  @Get('admin/collected/sources')
  async collectedSources() {
    return callService<any>(serviceUrl.pricing(), '/internal/prices/sources', { asService: true });
  }

  /** Stato dei servizi: /ready di ciascuno, con il tempo di risposta. */
  @AdminOnly()
  @Get('admin/status')
  async status() {
    const check = async (name: string, base: string) => {
      const started = performance.now();
      try {
        const res = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(2000) });
        const body: any = await res.json().catch(() => ({}));
        return { name, ok: res.ok, ms: Math.round(performance.now() - started), detail: res.ok ? null : body.detail ?? `HTTP ${res.status}` };
      } catch (err) {
        return { name, ok: false, ms: null, detail: (err as Error).name === 'TimeoutError' ? 'nessuna risposta in 2 s' : 'non raggiungibile' };
      }
    };
    const services = await Promise.all(SERVICES.map((s) => check(s, serviceUrl[s]())));
    const db = await this.pool.query('SELECT 1').then(() => true, () => false);
    services.push({ name: 'config', ok: db && this.bus.connected, ms: 0, detail: null });
    return { checkedAt: new Date().toISOString(), services };
  }
}
