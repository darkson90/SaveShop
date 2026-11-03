import { Module } from '@nestjs/common';
import { bootstrap, InfraModule } from '@spesa/common';
import { CatalogController } from './catalog.controller';

bootstrap(
  (infra) => {
    @Module({ imports: [InfraModule.forRoot(infra)], controllers: [CatalogController] })
    class AppModule {}
    return AppModule;
  },
  { name: 'catalog', publishes: true },
);
