/**
 * Parametri dell'app modificabili a runtime dal pannello di amministrazione.
 *
 * Ogni parametro è definito qui una volta sola (tipo, limiti, valore predefinito, descrizione) e
 * letto dai servizi con `settings.get(key)`. Valore effettivo, in ordine:
 *   1. valore impostato dal pannello (Config Service, tabella settings);
 *   2. variabile d'ambiente indicata in `env`, se presente;
 *   3. `default`.
 * Le modifiche arrivano ai servizi in tempo reale (segnale SettingsChanged) e comunque entro un minuto.
 */
import { BadRequestException } from '@nestjs/common';
import { serviceUrl } from './config';
import { EventBus, Events } from './events';
import { callService } from './http';

export type SettingType = 'int' | 'float' | 'bool' | 'text' | 'version' | 'choices' | 'list';

export interface SettingDef {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  type: SettingType;
  default: unknown;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Per "choices": i valori ammessi, con etichetta. */
  options?: Array<{ value: string; label: string }>;
  /** Servizi che usano il parametro (mostrato nel pannello). */
  services: string[];
  /** Variabile d'ambiente che lo imposta quando il pannello non l'ha modificato. */
  env?: string;
  /** Leggibile senza accesso da `GET /api/v1/config/public` (lo usa l'app). */
  public?: boolean;
}

export type SettingGroup = 'catalog' | 'pricing' | 'lists' | 'receipts' | 'offers' | 'stats' | 'access' | 'ingestion' | 'app';

export const SETTING_GROUPS: Array<{ id: SettingGroup; label: string; description: string }> = [
  { id: 'catalog', label: 'Ricerca e catalogo', description: 'Autocompletamento e riconoscimento dei prodotti scritti nella lista.' },
  { id: 'pricing', label: 'Prezzi e confronto', description: 'Raggio di ricerca dei negozi e validità dei prezzi nei confronti.' },
  { id: 'lists', label: 'Liste condivise', description: 'Inviti e numero di membri delle liste condivise.' },
  { id: 'receipts', label: 'Scontrini', description: 'Abbinamento delle righe dello scontrino agli articoli della lista.' },
  { id: 'offers', label: 'Offerte e notifiche', description: 'Quando segnalare un\'offerta e quante notifiche inviare.' },
  { id: 'stats', label: 'Statistiche', description: 'Metriche del profilo utente.' },
  { id: 'access', label: 'Accesso e sicurezza', description: 'Registrazione e durata delle sessioni.' },
  { id: 'ingestion', label: 'Raccolta prezzi', description: 'Fonti e area della raccolta notturna dei prezzi.' },
  { id: 'app', label: 'App', description: 'Messaggi e requisiti mostrati nell\'app.' },
];

export const SETTINGS: SettingDef[] = [
  // Ricerca e catalogo
  { key: 'catalog.minSearchScore', group: 'catalog', label: 'Somiglianza minima nella ricerca', type: 'float', default: 0.3, min: 0.3, max: 0.95, step: 0.05,
    description: 'Quanto un prodotto deve somigliare al testo digitato per comparire tra i suggerimenti. Più alto: meno suggerimenti, più precisi.', services: ['catalog'] },
  { key: 'catalog.searchCacheSeconds', group: 'catalog', label: 'Durata cache della ricerca', type: 'int', default: 300, min: 0, max: 3600, unit: 's',
    description: 'Per quanto i risultati di un prefisso restano in memoria. 0 disattiva la cache.', services: ['catalog'] },
  { key: 'lists.minMatchConfidence', group: 'catalog', label: 'Somiglianza minima per riconoscere un prodotto', type: 'float', default: 0.45, min: 0.3, max: 1, step: 0.05,
    description: 'Sotto questo valore il testo inserito resta una voce libera, da abbinare a mano.', services: ['list'] },

  // Prezzi e confronto
  { key: 'geo.defaultRadiusKm', group: 'pricing', label: 'Raggio predefinito', type: 'int', default: 10, min: 1, max: 100, unit: 'km', public: true,
    description: 'Raggio usato quando la richiesta non ne indica uno.', services: ['store', 'pricing', 'list'] },
  { key: 'geo.maxRadiusKm', group: 'pricing', label: 'Raggio massimo', type: 'int', default: 25, min: 5, max: 100, unit: 'km', public: true,
    description: 'Il raggio più ampio che un utente può scegliere nelle impostazioni.', services: ['store', 'pricing', 'list', 'user'] },
  { key: 'pricing.priceMaxAgeDays', group: 'pricing', label: 'Età massima di un prezzo', type: 'int', default: 60, min: 1, max: 365, unit: 'giorni', env: 'PRICE_MAX_AGE_DAYS',
    description: 'Un prezzo che nessuna fonte conferma da più giorni smette di comparire nei confronti.', services: ['pricing'] },
  { key: 'pricing.comparisonCacheSeconds', group: 'pricing', label: 'Durata cache dei confronti', type: 'int', default: 900, min: 0, max: 86400, unit: 's',
    description: 'Per quanto un confronto già calcolato viene riusato. La cache si svuota comunque a ogni aggiornamento dei listini.', services: ['pricing'] },

  // Liste condivise
  { key: 'lists.maxMembers', group: 'lists', label: 'Membri massimi per lista', type: 'int', default: 5, min: 2, max: 20,
    description: 'Compreso chi ha creato la lista.', services: ['list'] },
  { key: 'lists.inviteTtlHours', group: 'lists', label: 'Validità del codice d\'invito', type: 'int', default: 48, min: 1, max: 720, unit: 'ore',
    description: 'Vale per i codici generati da ora in poi.', services: ['list'] },

  // Scontrini
  { key: 'receipts.minLineConfidence', group: 'receipts', label: 'Somiglianza minima di una riga', type: 'float', default: 0.35, min: 0.1, max: 0.9, step: 0.05,
    description: 'Sotto questo valore la riga dello scontrino resta da abbinare a mano.', services: ['list'] },

  // Offerte e notifiche
  { key: 'offers.enabled', group: 'offers', label: 'Notifiche offerte attive', type: 'bool', default: true,
    description: 'Interruttore generale: spento, nessuna offerta viene segnalata né notificata.', services: ['notification'] },
  { key: 'offers.minDiscountPct', group: 'offers', label: 'Sconto minimo', type: 'int', default: 10, min: 1, max: 90, unit: '%',
    description: 'Le promo con uno sconto minore non vengono segnalate.', services: ['notification'] },
  { key: 'offers.minTimesAdded', group: 'offers', label: 'Quando un prodotto è "frequente"', type: 'int', default: 2, min: 1, max: 20, unit: 'aggiunte', env: 'NOTIFY_MIN_TIMES_ADDED',
    description: 'Quante volte l\'utente deve aver aggiunto un prodotto prima di ricevere le sue offerte.', services: ['notification'] },
  { key: 'offers.minHoursBetweenPushes', group: 'offers', label: 'Pausa minima tra due notifiche', type: 'int', default: 12, min: 0, max: 168, unit: 'ore', env: 'NOTIFY_MIN_HOURS_BETWEEN_PUSHES',
    description: 'Per lo stesso utente. Le offerte restano comunque visibili in "Offerte per te".', services: ['notification'] },

  // Statistiche
  { key: 'stats.cacheSeconds', group: 'stats', label: 'Durata cache delle metriche', type: 'int', default: 600, min: 0, max: 86400, unit: 's',
    description: 'Una nuova spesa registrata aggiorna comunque subito le metriche.', services: ['analytics'] },
  { key: 'stats.maxCategorySlices', group: 'stats', label: 'Categorie nel grafico', type: 'int', default: 6, min: 3, max: 10,
    description: 'Le altre confluiscono in "Altro".', services: ['analytics'] },

  // Accesso e sicurezza
  { key: 'auth.registrationOpen', group: 'access', label: 'Registrazioni aperte', type: 'bool', default: true,
    description: 'Spento, nessuno può creare un account nuovo; chi è registrato continua ad accedere.', services: ['auth'] },
  { key: 'auth.accessTokenMinutes', group: 'access', label: 'Durata del token di accesso', type: 'int', default: 15, min: 5, max: 120, unit: 'minuti',
    description: 'Scaduto, l\'app lo rinnova da sola con il token di aggiornamento.', services: ['auth'] },
  { key: 'auth.refreshTokenDays', group: 'access', label: 'Durata della sessione', type: 'int', default: 30, min: 1, max: 365, unit: 'giorni',
    description: 'Dopo questo tempo senza aprire l\'app bisogna accedere di nuovo.', services: ['auth'] },

  // Raccolta prezzi
  { key: 'ingestion.sources', group: 'ingestion', label: 'Fonti attive', type: 'choices', default: ['demo', 'open_prices', 'osm_stores', 'carrefour', 'lidl', 'aldi', 'eurospin', 'penny', 'easycoop'], env: 'INGESTION_SOURCES',
    options: [
      { value: 'demo', label: 'Listini dimostrativi' },
      { value: 'open_prices', label: 'Open Prices (prezzi reali, ODbL)' },
      { value: 'osm_stores', label: 'Supermercati d\'Italia da OpenStreetMap (solo negozi, ODbL)' },
      { value: 'carrefour', label: 'Sito Carrefour (negozi e prezzi della spesa online)' },
      { value: 'lidl', label: 'Sito Lidl (prezzi nazionali, spesso con codice a barre)' },
      { value: 'aldi', label: 'Sito Aldi (assortimento con prezzi nazionali, abbinato per nome)' },
      { value: 'eurospin', label: 'Sito Eurospin (offerte nazionali, abbinate per nome)' },
      { value: 'penny', label: 'Sito Penny (offerte della settimana, anche con PENNYCard)' },
      { value: 'easycoop', label: 'EasyCoop, spesa online Coop Alleanza 3.0 (Emilia-Romagna, Veneto e vicine)' },
      { value: 'feeds', label: 'Feed dei negozi partner' },
    ],
    description: 'Usate dal giro notturno successivo. In produzione disattiva i listini dimostrativi.', services: ['ingestion'] },
  { key: 'ingestion.openPricesLat', group: 'ingestion', label: 'Area di raccolta: latitudine del centro', type: 'float', default: 46.14, min: -90, max: 90, step: 0.0001, env: 'OPEN_PRICES_LAT',
    description: 'Centro dell\'area: Open Prices legge i prezzi segnalati qui, i listini dei siti si applicano ai negozi di quest\'area.', services: ['ingestion'] },
  { key: 'ingestion.openPricesLon', group: 'ingestion', label: 'Area di raccolta: longitudine del centro', type: 'float', default: 12.22, min: -180, max: 180, step: 0.0001, env: 'OPEN_PRICES_LON',
    description: 'Centro dell\'area: Open Prices legge i prezzi segnalati qui, i listini dei siti si applicano ai negozi di quest\'area.', services: ['ingestion'] },
  { key: 'ingestion.openPricesRadiusKm', group: 'ingestion', label: 'Area di raccolta: raggio', type: 'int', default: 40, min: 1, max: 200, unit: 'km', env: 'OPEN_PRICES_RADIUS_KM',
    description: 'Ampiezza dell\'area di raccolta (Open Prices e negozi a cui applicare i listini dei siti).', services: ['ingestion'] },
  { key: 'ingestion.openPricesDays', group: 'ingestion', label: 'Open Prices: segnalazioni degli ultimi', type: 'int', default: 60, min: 1, max: 365, unit: 'giorni', env: 'OPEN_PRICES_DAYS',
    description: 'Segnalazioni più vecchie non vengono lette.', services: ['ingestion'] },
  { key: 'ingestion.feeds', group: 'ingestion', label: 'Feed dei negozi partner', type: 'list', default: [], env: 'INGESTION_FEEDS',
    description: 'Un indirizzo https:// per riga (formato in docs/feed-format.md). Serve la fonte "Feed dei negozi partner" attiva.', services: ['ingestion'] },
  { key: 'ingestion.osmWholeItaly', group: 'ingestion', label: 'OpenStreetMap: supermercati di tutta Italia', type: 'bool', default: true, env: 'OSM_WHOLE_ITALY',
    description: 'Acceso: tutti i supermercati italiani (circa 25.000). Spento: solo quelli dell\'area di raccolta.', services: ['ingestion'] },
  { key: 'ingestion.osmEveryDays', group: 'ingestion', label: 'OpenStreetMap: aggiorna l\'elenco ogni', type: 'int', default: 1, min: 1, max: 90, unit: 'giorni', env: 'OSM_EVERY_DAYS',
    description: '1 = ogni notte (una sola richiesta a OpenStreetMap). Con un valore più alto i negozi nuovi arrivano più tardi.', services: ['ingestion'] },
  { key: 'scraping.minNameMatch', group: 'ingestion', label: 'Somiglianza minima per abbinare per nome', type: 'float', default: 0.6, min: 0.3, max: 1, step: 0.05, env: 'SCRAPING_MIN_NAME_MATCH',
    description: 'Per le fonti senza codice a barre: sotto questa somiglianza il prezzo viene scartato invece di finire sul prodotto sbagliato.', services: ['ingestion'] },
  { key: 'scraping.maxRequestsPerRun', group: 'ingestion', label: 'Siti dei supermercati: pagine per notte', type: 'int', default: 1500, min: 50, max: 20000, unit: 'pagine', env: 'SCRAPING_MAX_REQUESTS',
    description: 'Tetto di pagine lette da ciascun sito a ogni giro. Il catalogo si copre a rotazione nelle notti successive: più pagine, prezzi più freschi ma giro più lungo.', services: ['ingestion'] },
  { key: 'scraping.delaySeconds', group: 'ingestion', label: 'Siti dei supermercati: pausa tra due pagine', type: 'float', default: 1.5, min: 0.5, max: 30, step: 0.5, unit: 's', env: 'SCRAPING_DELAY_SECONDS',
    description: 'Attesa minima tra due richieste allo stesso sito, per non appesantirlo. Se il robots.txt del sito chiede di più, vale il suo valore.', services: ['ingestion'] },
  { key: 'scraping.createProducts', group: 'ingestion', label: 'Siti dei supermercati: aggiungi prodotti nuovi', type: 'bool', default: true, env: 'SCRAPING_CREATE_PRODUCTS',
    description: 'Acceso: i prodotti della spesa trovati sui siti entrano nel catalogo. Spento: si aggiornano solo i prezzi dei prodotti già presenti.', services: ['ingestion', 'catalog'] },
  { key: 'scraping.carrefourFormats', group: 'ingestion', label: 'Carrefour: negozi a cui applicare i prezzi online', type: 'choices', default: ['iper', 'market', 'express', 'altri'], env: 'CARREFOUR_FORMATS',
    options: [
      { value: 'iper', label: 'Carrefour Iper' },
      { value: 'market', label: 'Carrefour Market' },
      { value: 'express', label: 'Carrefour Express' },
      { value: 'altri', label: 'Altri punti vendita Carrefour' },
    ],
    description: 'I prezzi della spesa online valgono per tutta Italia; nei negozi possono differire, soprattutto negli Express.', services: ['ingestion'] },

  // App
  { key: 'app.maintenanceMessage', group: 'app', label: 'Avviso in cima all\'app', type: 'text', default: '', public: true,
    description: 'Mostrato a tutti nella schermata della lista, ad esempio per una manutenzione. Vuoto: nessun avviso.', services: ['app'] },
  { key: 'app.minSupportedVersion', group: 'app', label: 'Versione minima dell\'app', type: 'version', default: '0.1.0', public: true,
    description: 'Le versioni precedenti mostrano un invito ad aggiornare. Formato 1.2.3.', services: ['app'] },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** Controlla un valore rispetto alla sua definizione; restituisce il valore normalizzato o lancia un errore leggibile. */
export function validateSetting(def: SettingDef, value: unknown): unknown {
  const range = (n: number) => {
    if (def.min !== undefined && n < def.min) throw new Error(`deve essere almeno ${def.min}`);
    if (def.max !== undefined && n > def.max) throw new Error(`deve essere al massimo ${def.max}`);
    return n;
  };
  switch (def.type) {
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('deve essere un numero intero');
      return range(value);
    case 'float':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('deve essere un numero');
      return range(Math.round(value * 10000) / 10000);
    case 'bool':
      if (typeof value !== 'boolean') throw new Error('deve essere vero o falso');
      return value;
    case 'text':
      if (typeof value !== 'string') throw new Error('deve essere un testo');
      if (value.length > 300) throw new Error('al massimo 300 caratteri');
      return value.trim();
    case 'version':
      if (typeof value !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value.trim())) throw new Error('formato 1.2.3');
      return value.trim();
    case 'choices': {
      if (!Array.isArray(value)) throw new Error('deve essere un elenco');
      const allowed = new Set((def.options ?? []).map((o) => o.value));
      const bad = value.find((v) => typeof v !== 'string' || !allowed.has(v));
      if (bad !== undefined) throw new Error(`valore non ammesso: ${String(bad)}`);
      return [...new Set(value as string[])];
    }
    case 'list': {
      if (!Array.isArray(value)) throw new Error('deve essere un elenco');
      const items = (value as unknown[]).map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
      if (items.length > 50) throw new Error('al massimo 50 voci');
      const bad = items.find((v) => !/^https:\/\/[^\s]+$/.test(v) || v.length > 500);
      if (bad) throw new Error(`indirizzo non valido (serve https://): ${bad}`);
      return items;
    }
  }
}

/** Valore della variabile d'ambiente del parametro, interpretato secondo il tipo; undefined se assente o non valido. */
export function envValue(def: SettingDef, env: NodeJS.ProcessEnv = process.env): unknown {
  const raw = def.env ? env[def.env] : undefined;
  if (raw === undefined || raw === '') return undefined;
  try {
    const parsed =
      def.type === 'int' || def.type === 'float' ? Number(raw)
      : def.type === 'bool' ? raw === 'true' || raw === '1'
      : def.type === 'choices' || def.type === 'list' ? raw.split(',').map((s) => s.trim()).filter(Boolean)
      : raw;
    return validateSetting(def, parsed);
  } catch {
    return undefined;
  }
}

/** Valori effettivi dei servizi: impostati dal pannello, poi variabile d'ambiente, poi predefiniti. */
export class SettingsClient {
  private overrides = new Map<string, unknown>();
  private started = false;

  get<T = unknown>(key: string): T {
    const def = SETTINGS_BY_KEY.get(key);
    if (!def) throw new Error(`Parametro sconosciuto: ${key}`);
    if (this.overrides.has(key)) return this.overrides.get(key) as T;
    const fromEnv = envValue(def);
    return (fromEnv !== undefined ? fromEnv : def.default) as T;
  }

  num(key: string): number {
    return this.get<number>(key);
  }

  /** Imposta i valori del pannello (usato dal Config Service per sé stesso e nei test). */
  apply(values: Record<string, unknown>): void {
    const next = new Map<string, unknown>();
    for (const [key, value] of Object.entries(values)) {
      const def = SETTINGS_BY_KEY.get(key);
      if (!def) continue;
      try {
        next.set(key, validateSetting(def, value));
      } catch {
        /* valore non più valido per la definizione attuale: si usa il predefinito */
      }
    }
    this.overrides = next;
  }

  async refresh(): Promise<void> {
    const res = await callService<{ values: Record<string, unknown> }>(serviceUrl.config(), '/internal/settings', { asService: true });
    this.apply(res.values);
  }

  /** Primo caricamento (senza bloccare l'avvio se il Config Service non risponde) e aggiornamenti in tempo reale. */
  async start(bus: EventBus): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.refresh().catch((err) => console.warn('[settings] Config Service non raggiungibile, uso i valori predefiniti:', err.message));
    await bus.onBroadcast([Events.SettingsChanged], () => {
      this.refresh().catch((err) => console.warn('[settings] aggiornamento fallito:', err.message));
    });
    setInterval(() => this.refresh().catch(() => undefined), 60_000).unref();
  }
}

export const settings = new SettingsClient();

/**
 * Raggio richiesto, con predefinito e massimo presi dai parametri. Un raggio oltre il massimo viene
 * ridotto al massimo invece di dare errore: se l'amministratore abbassa il limite, le preferenze già
 * salvate dagli utenti continuano a funzionare.
 */
export function radiusKm(value: unknown): number {
  const max = settings.num('geo.maxRadiusKm');
  if (value === undefined || value === null || value === '') return Math.min(settings.num('geo.defaultRadiusKm'), max);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) throw new BadRequestException(`Il raggio deve essere tra 1 e ${max} km`);
  return Math.min(n, max);
}
