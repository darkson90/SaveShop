import { Module } from '@nestjs/common';
import { bootstrap, InfraModule } from '@spesa/common';
import { CatalogController } from './catalog.controller';

bootstrap(
  (infra) => {
    @Module({ imports: [InfraModule.forRoot(infra)], controllers: [CatalogController] })
    class AppModule {}
    return AppModule;
  },
  {
    name: 'catalog',
    publishes: true,
    // Soglia 0,3 per gli operatori trigram della ricerca, impostata una volta per connessione:
    // prima ogni ricerca apriva una transazione (BEGIN, set_config, query, COMMIT: 4 viaggi al database).
    sessionSql: "SET pg_trgm.word_similarity_threshold = 0.3; SET pg_trgm.similarity_threshold = 0.3",
  },
);
