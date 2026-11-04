export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Variabile d'ambiente mancante: ${name}`);
  }
  return value;
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw ? Number.parseInt(raw, 10) : fallback;
}

/** URL base dei servizi interni, sovrascrivibili via env (es. LIST_URL=http://list:3000). */
export const serviceUrl = {
  auth: () => env('AUTH_URL', 'http://auth:3000'),
  user: () => env('USER_URL', 'http://user:3000'),
  store: () => env('STORE_URL', 'http://store:3000'),
  catalog: () => env('CATALOG_URL', 'http://catalog:3000'),
  list: () => env('LIST_URL', 'http://list:3000'),
  pricing: () => env('PRICING_URL', 'http://pricing:3000'),
  analytics: () => env('ANALYTICS_URL', 'http://analytics:3000'),
  notification: () => env('NOTIFICATION_URL', 'http://notification:3000'),
  config: () => env('CONFIG_URL', 'http://config:3000'),
};
