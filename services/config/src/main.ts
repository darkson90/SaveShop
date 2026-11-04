import { join } from 'node:path';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { bootstrap, InfraModule } from '@spesa/common';
import { ConfigController } from './config.controller';

bootstrap(
  (infra) => {
    @Module({ imports: [InfraModule.forRoot(infra)], controllers: [ConfigController] })
    class AppModule {}
    return AppModule;
  },
  {
    name: 'config',
    maintenance: ["DELETE FROM settings_audit WHERE changed_at < now() - interval '2 years'"],
    onReady: async (app) => {
      const web = app as NestExpressApplication;
      // Pannello di amministrazione: pagina statica servita da questo servizio su /admin/.
      // Stessa origine delle API, quindi niente CORS; intestazioni restrittive contro iframe e script esterni.
      web.use('/admin', (req: any, res: any, next: () => void) => {
        res.set({
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Cache-Control': 'no-cache',
        });
        // "/admin" senza barra finale: i percorsi relativi della pagina (styles.css, app.js) richiedono la barra.
        if (req.originalUrl === '/admin') return res.redirect(301, '/admin/');
        next();
      });
      web.useStaticAssets(join(process.cwd(), 'admin'), { prefix: '/admin/' });
    },
  },
);
