import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { env } from './config';

export interface AuthUser {
  userId: string;
  email: string;
}

const ISSUER = 'spesa-smart-auth';
let publicKey: string | undefined;

function getPublicKey(): string {
  publicKey ??= readFileSync(env('JWT_PUBLIC_KEY_FILE', '/run/keys/jwt-public.pem'), 'utf8');
  return publicKey;
}

/** Firma un access token RS256 (usato solo dall'Auth Service, unico detentore della chiave privata). */
export function signAccessToken(user: AuthUser, privateKey: string, ttlSeconds = 15 * 60): string {
  return jwt.sign({ email: user.email }, privateKey, {
    algorithm: 'RS256',
    subject: user.userId,
    issuer: ISSUER,
    expiresIn: ttlSeconds,
    keyid: 'k1',
  });
}

export function verifyAccessToken(token: string): AuthUser {
  const claims = jwt.verify(token, getPublicKey(), { algorithms: ['RS256'], issuer: ISSUER }) as jwt.JwtPayload;
  return { userId: String(claims.sub), email: String(claims.email) };
}

export const IS_PUBLIC = 'isPublic';
/** Marca un endpoint come accessibile senza JWT (login, registrazione, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const SERVICE_ONLY = 'serviceOnly';
/** Endpoint chiamabile solo da un altro servizio con il token di servizio (mai da un utente). */
export const ServiceOnly = () => SetMetadata(SERVICE_ONLY, true);

/** Header delle chiamate tra servizi senza un utente collegato (job in background). Il gateway li rimuove. */
export const SERVICE_TOKEN_HEADER = 'x-service-token';
export const ACTING_USER_HEADER = 'x-acting-user';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidServiceToken(value: unknown): boolean {
  const expected = process.env.SERVICE_TOKEN;
  if (!expected || typeof value !== 'string') return false;
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Guard globale: ogni servizio verifica da sé la firma del JWT inoltrato dal gateway.
 * In alternativa accetta il token di servizio con l'utente per conto del quale si agisce
 * (es. il Notification Service che cerca i negozi ammessi di un utente).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const req = context.switchToHttp().getRequest();
    const serviceCall = isValidServiceToken(req.headers[SERVICE_TOKEN_HEADER]);
    if (this.reflector.getAllAndOverride<boolean>(SERVICE_ONLY, targets)) {
      if (!serviceCall) throw new UnauthorizedException('Riservato ai servizi interni');
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (serviceCall) {
      const acting = req.headers[ACTING_USER_HEADER];
      if (typeof acting !== 'string' || !UUID_RE.test(acting)) throw new UnauthorizedException('Utente per conto del quale agire mancante');
      req.user = { userId: acting, email: '' } satisfies AuthUser;
      req.serviceCall = true;
      return true;
    }
    const header: string | undefined = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Token mancante');
    try {
      req.user = verifyAccessToken(header.slice(7));
      req.token = header.slice(7);
      return true;
    } catch {
      throw new UnauthorizedException('Token non valido o scaduto');
    }
  }
}

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

/** Il token grezzo, da inoltrare nelle chiamate sincrone verso altri servizi. */
export const BearerToken = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest().token;
});
