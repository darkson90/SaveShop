# Formato dei feed partner (versione 1)

Un negozio o un'insegna può pubblicare il proprio listino in un file JSON. L'Ingestion lo legge a ogni
giro notturno, da un URL HTTPS o da un file. I prezzi pubblicati così sono completi e aggiornati, senza
bisogno di raccoglierli dai siti web.

Attivazione:

```bash
INGESTION_SOURCES=open_prices,feeds
INGESTION_FEEDS=https://esempio.it/saveshop/listino.json,/data/feed/altro.json
```

## Struttura

```json
{
  "version": 1,
  "publisher": "alimentari-rossi",
  "generatedAt": "2026-11-03T06:00:00+01:00",
  "stores": [
    { "ref": "vodo-01", "name": "Alimentari Rossi Vodo", "chain": "Alimentari Rossi",
      "address": "Via Nazionale 5, Vodo di Cadore", "lat": 46.4188, "lng": 12.2449 }
  ],
  "products": [
    { "ean": "8099999000024", "name": "Formaggio Piave DOP 250 g", "brand": "Latteria Esempio",
      "categories": ["en:dairies", "en:cheeses"], "quantity": 250, "quantityUnit": "g" }
  ],
  "prices": [
    { "store": "vodo-01", "ean": "8000000000101", "price": 1.35, "promoPrice": 0.99, "promoUntil": "2026-11-15" },
    { "store": "vodo-01", "ean": "8000000000126", "price": 2.60, "promoPrice": 2.20, "loyaltyOnly": true }
  ]
}
```

| Campo | Obbligatorio | Note |
| --- | --- | --- |
| `version` | sì | Sempre `1` |
| `publisher` | sì | Identificativo stabile di chi pubblica il feed, senza spazi |
| `stores[].ref` | sì | Codice del punto vendita, univoco per `publisher` |
| `stores[].name`, `lat`, `lng` | sì | Coordinate WGS84 in gradi decimali |
| `stores[].chain`, `address` | no | Insegna (default: `publisher`) e indirizzo |
| `products[]` | no | Serve solo per prodotti non ancora nel catalogo; la categoria segue i tag di Open Food Facts |
| `prices[].store`, `ean`, `price` | sì | Prezzo pieno in euro, IVA inclusa; EAN di 8–14 cifre |
| `prices[].promoPrice` | no | Prezzo scontato, minore di `price` |
| `prices[].promoUntil` | no | Ultimo giorno della promo (`AAAA-MM-GG`); dopo vale il prezzo pieno |
| `prices[].loyaltyOnly` | no | `true` se la promo vale solo con la carta fedeltà |

Le righe non valide vengono scartate una per una e segnalate nel log dell'Ingestion; il resto del
feed viene importato. Negozi e prodotti nuovi vengono creati automaticamente.
