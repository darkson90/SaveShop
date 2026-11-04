import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import {
  addToOutbox,
  env,
  Events,
  PG_POOL,
  Public,
  reqString,
  settings,
  signAccessToken,
  uuidv7,
  withTx,
} from '@spesa/common';
import { Pool, PoolClient } from 'pg';

/** Email degli amministratori (pannello dei parametri), separate da virgola. */
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Il refresh token è "<id>.<segreto>": un formato diverso è semplicemente non valido (401, non 500). */
function splitRefreshToken(token: string): [string, string] {
  const [id, secret] = token.split('.');
  if (!UUID_RE.test(id ?? '') || !secret) throw new UnauthorizedException('Refresh token non valido');
  return [id, secret];
}

// Hash di riferimento: il login di un'email inesistente impiega lo stesso tempo di uno reale,
// così i tempi di risposta non rivelano quali email sono registrate.
const DUMMY_HASH = hash('password-di-riferimento-mai-usata');

@Controller('auth')
export class AuthController {
  private readonly privateKey = readFileSync(env('JWT_PRIVATE_KEY_FILE', '/run/keys/jwt-private.pem'), 'utf8');

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Public()
  @Post('register')
  async register(@Body() body: any) {
    const email = reqString(body, 'email', 254).toLowerCase();
    const password = reqString(body, 'password', 200);
    const displayName = typeof body.displayName === 'string' ? body.displayName.slice(0, 80) : null;
    if (!EMAIL_RE.test(email)) throw new BadRequestException('Email non valida');
    if (password.length < 8) throw new BadRequestException('La password deve avere almeno 8 caratteri');
    if (!settings.get<boolean>('auth.registrationOpen') && !ADMIN_EMAILS.has(email)) {
      throw new ForbiddenException('Le registrazioni sono momentaneamente chiuse');
    }

    const userId = uuidv7();
    const passwordHash = await hash(password); // argon2id, parametri di default della libreria
    return withTx(this.pool, async (client) => {
      const res = await client.query(
        'INSERT INTO credentials (user_id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (email) DO NOTHING',
        [userId, email, passwordHash],
      );
      if (!res.rowCount) throw new ConflictException('Email già registrata');
      await addToOutbox(client, Events.UserRegistered, { userId, email, displayName });
      return this.issueTokens(client, userId, email);
    });
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: any) {
    const email = reqString(body, 'email', 254).toLowerCase();
    const password = reqString(body, 'password', 200);
    const { rows } = await this.pool.query('SELECT user_id, password_hash FROM credentials WHERE email = $1', [email]);
    const ok = await verify(rows[0]?.password_hash ?? (await DUMMY_HASH), password);
    if (!ok || !rows[0]) throw new UnauthorizedException('Credenziali non valide');
    return withTx(this.pool, (client) => this.issueTokens(client, rows[0].user_id, email));
  }

  /** Rotazione: il refresh token usato viene revocato e sostituito. */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: any) {
    const [id, secret] = splitRefreshToken(reqString(body, 'refreshToken', 200));
    const result = await withTx(this.pool, async (client) => {
      const { rows } = await client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL AND expires_at > now()
         RETURNING user_id`,
        [id, sha256(secret)],
      );
      if (rows[0]) {
        const user = await client.query('SELECT email FROM credentials WHERE user_id = $1', [rows[0].user_id]);
        return this.issueTokens(client, rows[0].user_id, user.rows[0].email);
      }
      // Un token già ruotato che viene riusato (oltre 60 s di tolleranza per i tentativi ripetuti
      // dell'app) indica un probabile furto: si chiudono tutte le sessioni di quell'utente.
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE revoked_at IS NULL AND user_id = (
           SELECT user_id FROM refresh_tokens
           WHERE id = $1 AND token_hash = $2 AND revoked_at < now() - interval '60 seconds')`,
        [id, sha256(secret)],
      );
      return null;
    });
    if (!result) throw new UnauthorizedException('Refresh token non valido');
    return result;
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: any) {
    // Revoca solo con il token completo: conoscere l'id non basta a chiudere la sessione altrui.
    const [id, secret] = splitRefreshToken(reqString(body, 'refreshToken', 200));
    await this.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND token_hash = $2', [id, sha256(secret)]);
  }

  private async issueTokens(client: PoolClient, userId: string, email: string) {
    const accessTtl = settings.num('auth.accessTokenMinutes') * 60;
    const refreshDays = settings.num('auth.refreshTokenDays');
    const role = ADMIN_EMAILS.has(email.toLowerCase()) ? 'admin' : undefined;
    const id = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    await client.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [id, userId, sha256(secret), refreshDays],
    );
    return {
      userId,
      accessToken: signAccessToken({ userId, email, role }, this.privateKey, accessTtl),
      expiresIn: accessTtl,
      ...(role ? { role } : {}),
      refreshToken: `${id}.${secret}`,
    };
  }
}
