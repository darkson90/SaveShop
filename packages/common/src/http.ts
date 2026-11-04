import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

const PG_ERRORS: Record<string, [number, string]> = {
  '22P02': [400, 'Valore non valido'],
  '22003': [400, 'Valore fuori intervallo'],
  '22001': [400, 'Testo troppo lungo'],
  '23505': [409, 'Elemento già presente'],
  '23503': [409, 'Elemento collegato inesistente'],
  '23514': [400, 'Valore non ammesso'],
};

/** Converte ogni errore nel formato RFC 7807 (application/problem+json). */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    let status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    let detail = 'Errore interno';
    const pgCode = (exception as any)?.code;
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      detail = typeof body === 'string' ? body : ((body as any).message ?? exception.message);
      if (Array.isArray(detail)) detail = detail.join('; ');
    } else if (typeof pgCode === 'string' && PG_ERRORS[pgCode]) {
      // Errori del database dovuti all'input (valore non valido, duplicato, riferimento inesistente).
      [status, detail] = PG_ERRORS[pgCode];
    } else if ((exception as any)?.type === 'entity.too.large') {
      [status, detail] = [413, 'Richiesta troppo grande'];
    } else if ((exception as any)?.type === 'entity.parse.failed') {
      [status, detail] = [400, 'JSON non valido'];
    } else {
      console.error(exception);
    }
    res
      .status(status)
      .type('application/problem+json')
      .json({ type: 'about:blank', title: HttpStatus[status] ?? 'Error', status, detail, instance: req.originalUrl });
  }
}

/** Chiamata sincrona verso un altro servizio, inoltrando il JWT dell'utente. */
export async function callService<T>(
  baseUrl: string,
  path: string,
  opts: { method?: string; body?: unknown; token?: string; asService?: boolean; actingUser?: string } = {},
): Promise<T> {
  const url = `${baseUrl}/api/v1${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      // Chiamata di servizio (senza JWT utente): token condiviso + eventuale utente impersonato.
      ...(opts.asService || opts.actingUser ? { 'x-service-token': process.env.SERVICE_TOKEN ?? '' } : {}),
      ...(opts.actingUser ? { 'x-acting-user': opts.actingUser } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    // Timeout o servizio irraggiungibile: dettagli nel log, al client solo un messaggio generico.
    console.error(`[http] ${opts.method ?? 'GET'} ${url} fallita:`, (err as Error).message);
    throw new HttpException('Servizio temporaneamente non disponibile, riprova tra poco', 503);
  }
  if (!res.ok) {
    const text = await res.text();
    if (res.status >= 500) {
      console.error(`[http] ${url} ha risposto ${res.status}: ${text.slice(0, 500)}`);
      throw new HttpException('Servizio temporaneamente non disponibile, riprova tra poco', 502);
    }
    // 4xx: il motivo (es. "Lista non trovata") è utile al client; gli indirizzi interni no.
    let detail = text;
    try {
      detail = JSON.parse(text).detail ?? text;
    } catch {
      /* risposta non JSON */
    }
    throw new HttpException(String(detail).slice(0, 300), res.status);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

// --- Validazione minimale degli input --------------------------------------------------------

export function reqString(body: any, field: string, max = 500): string {
  const v = body?.[field];
  if (typeof v !== 'string' || !v.trim()) throw new BadRequestException(`Campo "${field}" obbligatorio`);
  if (v.length > max) throw new BadRequestException(`Campo "${field}" troppo lungo`);
  return v.trim();
}

export function optNumber(value: any, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new BadRequestException(`Campo "${field}" deve essere un numero tra ${min} e ${max}`);
  }
  return n;
}

export function reqNumber(value: any, field: string, min: number, max: number): number {
  const n = optNumber(value, field, min, max);
  if (n === undefined) throw new BadRequestException(`Campo "${field}" obbligatorio`);
  return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function reqUuid(value: any, field: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new BadRequestException(`Campo "${field}" deve essere un UUID`);
  return value;
}

/** Paginazione a cursore: il cursore è l'ID (UUID v7, ordinabile) dell'ultimo elemento restituito. */
export function pageParams(query: any): { cursor?: string; limit: number } {
  const limit = optNumber(query?.limit, 'limit', 1, 100) ?? 20;
  const cursor = query?.cursor ? reqUuid(query.cursor, 'cursor') : undefined;
  return { cursor, limit };
}
