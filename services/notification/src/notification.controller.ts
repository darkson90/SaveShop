import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put } from '@nestjs/common';
import { AuthUser, CurrentUser, PG_POOL, reqString } from '@spesa/common';
import { Pool } from 'pg';

@Controller('notifications')
export class NotificationController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Registra (o riassegna) il token push del dispositivo all'utente corrente. */
  @Put('devices')
  @HttpCode(204)
  async registerDevice(@CurrentUser() user: AuthUser, @Body() body: any) {
    const token = reqString(body, 'token', 4096);
    const platform = body.platform;
    if (platform !== 'android' && platform !== 'ios') throw new BadRequestException('platform deve essere android o ios');
    await this.pool.query(
      `INSERT INTO devices (token, user_id, platform) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_seen = now()`,
      [token, user.userId, platform],
    );
  }

  /** Al logout l'app rimuove il proprio token. */
  @Delete('devices/:token')
  @HttpCode(204)
  async removeDevice(@CurrentUser() user: AuthUser, @Param('token') token: string) {
    await this.pool.query('DELETE FROM devices WHERE token = $1 AND user_id = $2', [token, user.userId]);
  }

  @Get('preferences')
  async preferences(@CurrentUser() user: AuthUser) {
    const { rows } = await this.pool.query('SELECT offers_enabled FROM preferences WHERE user_id = $1', [user.userId]);
    return { offersEnabled: rows[0]?.offers_enabled ?? false };
  }

  @Patch('preferences')
  async updatePreferences(@CurrentUser() user: AuthUser, @Body() body: any) {
    if (typeof body?.offersEnabled !== 'boolean') throw new BadRequestException('offersEnabled deve essere true o false');
    await this.pool.query(
      `INSERT INTO preferences (user_id, offers_enabled) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET offers_enabled = EXCLUDED.offers_enabled, updated_at = now()`,
      [user.userId, body.offersEnabled],
    );
    return { offersEnabled: body.offersEnabled };
  }

  /** Casella "Offerte per te": ultime 50 offerte segnalate, valide da non più di 7 giorni. */
  @Get()
  async inbox(@CurrentUser() user: AuthUser) {
    const { rows } = await this.pool.query(
      `SELECT * FROM notifications
       WHERE user_id = $1 AND valid_from >= current_date - 7
       ORDER BY id DESC LIMIT 50`,
      [user.userId],
    );
    return {
      unread: rows.filter((r) => !r.read_at).length,
      items: rows.map((r) => ({
        id: r.id,
        productId: r.product_id,
        productName: r.product_name,
        storeId: r.store_id,
        storeName: r.store_name,
        price: Number(r.price),
        promoPrice: Number(r.promo_price),
        loyaltyOnly: r.loyalty_only,
        validFrom: r.valid_from,
        read: !!r.read_at,
        createdAt: r.created_at,
      })),
    };
  }

  @Post('read')
  @HttpCode(204)
  async markAllRead(@CurrentUser() user: AuthUser) {
    await this.pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [user.userId]);
  }
}
