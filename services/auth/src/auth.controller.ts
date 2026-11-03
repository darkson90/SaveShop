import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { BadRequestException, Body, ConflictException, Controller, HttpCode, Inject, Post, UnauthorizedException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import {
  addToOutbox,
  env,
  Events,
  PG_POOL,
  Public,
  reqString,
  signAccessToken,
  uuidv7,
  withTx,
} from '@spesa/common';
import { Pool, PoolClient } from 'pg';

const REFRESH_TTL_DAYS = 30;
const ACCESS_TTL_SECONDS = 15 * 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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
    const ok = rows[0] && (await verify(rows[0].password_hash, password));
    if (!ok) throw new UnauthorizedException('Credenziali non valide');
    return withTx(this.pool, (client) => this.issueTokens(client, rows[0].user_id, email));
  }

  /** Rotazione: il refresh token usato viene revocato e sostituito. */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: any) {
    const [id, secret] = reqString(body, 'refreshToken', 200).split('.');
    return withTx(this.pool, async (client) => {
      const { rows } = await client.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL AND expires_at > now()
         RETURNING user_id`,
        [id, sha256(secret ?? '')],
      );
      if (!rows[0]) throw new UnauthorizedException('Refresh token non valido');
      const user = await client.query('SELECT email FROM credentials WHERE user_id = $1', [rows[0].user_id]);
      return this.issueTokens(client, rows[0].user_id, user.rows[0].email);
    });
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: any) {
    const [id] = reqString(body, 'refreshToken', 200).split('.');
    await this.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [id]);
  }

  private async issueTokens(client: PoolClient, userId: string, email: string) {
    const id = uuidv7();
    const secret = randomBytes(32).toString('base64url');
    await client.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
      [id, userId, sha256(secret), REFRESH_TTL_DAYS],
    );
    return {
      userId,
      accessToken: signAccessToken({ userId, email }, this.privateKey, ACCESS_TTL_SECONDS),
      expiresIn: ACCESS_TTL_SECONDS,
      refreshToken: `${id}.${secret}`,
    };
  }
}
