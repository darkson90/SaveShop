"""Codici a barre (GTIN/EAN): i siti li scrivono spesso con zeri davanti ("0000040052410" = EAN-8 40052410)."""


def _check_digit_ok(code: str) -> bool:
    digits = [int(c) for c in code]
    body, check = digits[:-1], digits[-1]
    # Pesi 3 e 1 alternati partendo dalla cifra accanto a quella di controllo.
    total = sum(d * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(body)))
    return (10 - total % 10) % 10 == check


def normalize_gtin(raw: str | None) -> str | None:
    """EAN-13 (o EAN-8) valido, senza zeri di riempimento; None se non è un codice a barre valido.

    I codici interni dei negozi (es. "0000000000208", prodotti a peso o sfusi) restano fuori: non sono
    confrontabili tra catene diverse.
    """
    digits = "".join(c for c in str(raw or "") if c.isdigit())
    if not digits or len(digits) > 14:
        return None
    significant = digits.lstrip("0")
    if len(significant) < 7:
        return None  # codice interno
    if len(significant) <= 8:
        code = significant.zfill(8)  # EAN-8 riempito di zeri
    else:
        # EAN-13 (un UPC-A diventa EAN-13 con uno 0 davanti); 14 cifre significative = GTIN-14 d'imballo.
        code = significant.zfill(13)
    if not _check_digit_ok(code):
        return None
    # Prefissi a circolazione ristretta: prodotti a peso variabile o codici interni del negozio
    # (EAN-13 che iniziano con 2, EAN-8 che iniziano con 0 o 2). Non sono confrontabili tra catene.
    if (len(code) == 13 and code[0] == "2") or (len(code) == 8 and code[0] in "02"):
        return None
    return code
