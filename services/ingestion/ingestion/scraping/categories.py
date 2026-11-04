"""Categorie dei siti dei supermercati -> categorie del catalogo, per parole chiave.

Ogni sito ha il suo albero ("Uova, latte e latticini", "Cibo e quasi cibo/Dolciumi e snack",
"Prodotti refrigerati/Latte e panna"...). Si prova dal livello più specifico al più generico; se nessuna
parola chiave corrisponde il prodotto non è spesa (giocattoli, fai da te, tessile...) e viene saltato.
L'ordine delle regole conta: le più specifiche prima ("gelati" prima di "latte").
"""

RULES: list[tuple[tuple[str, ...], str]] = [
    (("surgelat", "gelati"), "Surgelati"),
    (("uova", "latte", "latticini", "formaggi", "yogurt", "burro", "panna", "refrigerat"), "Latticini"),
    (("pane ", "pane,", "panific", "panini", "snack salati", "sostitutivi", "crackers", "grissini"), "Panetteria"),
    (("frutta", "verdura", "ortofrutta"), "Frutta e verdura"),
    (("carne", "pesce", "gastronomia", "salumi", "hamburger", "pollo", "macelleria"), "Carne e pesce"),
    (("acqua", "analcolici", "bevande", "bibite", "succhi", "birra", "vino", "vini", "liquori", "caffè e tè"), "Bevande"),
    (("cura della casa", "cura della persona", "igiene", "detersiv", "bucato", "pulizia", "animali", "pet food",
      "prima infanzia", "salute", "casa e persona"), "Casa e igiene"),
    (("dolci", "dolciumi", "colazione", "biscott", "snack", "pasta", "riso", "farina", "prodotti da forno",
      "condimenti", "conserve", "dispensa", "sfusi", "biologic", "stili alimentari", "alimentari", "cioccolat",
      "caffè", "olio", "sughi", "legumi", "cereali", "spezie"), "Dispensa"),
]


def map_category(*levels: str | None) -> str | None:
    """Categoria del catalogo dal percorso del sito (livelli dal più generico al più specifico)."""
    for level in reversed([lv for lv in levels if lv]):
        text = level.lower()
        for words, category in RULES:
            if any(w in text for w in words):
                return category
    return None
