import { env } from '@spesa/common';

/** Indirizzo pubblico dell'app (dominio dei link d'invito), es. https://saveshop.example.it */
export const publicBaseUrl = () => env('PUBLIC_BASE_URL', 'http://localhost:8080').replace(/\/$/, '');

export const inviteUrl = (code: string) => `${publicBaseUrl()}/i/${code}`;

const CODE_RE = /^[A-Z2-9]{6}$/;

/**
 * Pagina aperta quando il link d'invito non viene intercettato dall'app (app non installata, desktop):
 * mostra il codice e come usarlo. Con App Links / Universal Links configurati, sul telefono il link
 * apre direttamente l'app, che entra nella lista.
 */
export function invitePage(rawCode: string): { status: number; html: string } {
  const code = rawCode.toUpperCase();
  const valid = CODE_RE.test(code);
  const body = valid
    ? `<p>Ti hanno invitato a una lista della spesa condivisa.</p>
       <p class="code">${code}</p>
       <a class="btn" href="saveshop://join?code=${code}">Apri in SaveShop</a>
       <p class="hint">Se l'app non si apre: installala, poi nella lista tocca l'icona delle persone →
       "Entra con un codice" e inserisci il codice qui sopra. Il codice vale 48 ore.</p>`
    : `<p>Questo link d'invito non è valido. Chiedi un nuovo codice a chi ti ha invitato.</p>`;
  return {
    status: valid ? 200 : 404,
    html: `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Invito · SaveShop</title>
<style>
body{font-family:system-ui,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#1b1c1a;background:#fbfdf7;text-align:center}
h1{font-size:22px}.code{font-size:36px;letter-spacing:8px;font-weight:700;margin:24px 0}
.btn{display:inline-block;background:#1e7a4c;color:#fff;padding:14px 24px;border-radius:12px;text-decoration:none}
.hint{font-size:14px;color:#555;margin-top:24px}
@media (prefers-color-scheme:dark){body{background:#121411;color:#e2e3dd}.hint{color:#aaa}}
</style></head><body><h1>SaveShop</h1>${body}</body></html>`,
  };
}

/** Android App Links: dichiara che l'app può aprire i link di questo dominio. */
export function assetLinks() {
  const fingerprints = env('ANDROID_CERT_SHA256', '').split(',').map((s) => s.trim()).filter(Boolean);
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: env('ANDROID_PACKAGE', 'it.spesasmart.spesa_smart'), sha256_cert_fingerprints: fingerprints },
    },
  ];
}

/** iOS Universal Links: solo i percorsi /i/* aprono l'app. */
export function appleAppSiteAssociation() {
  return {
    applinks: { details: [{ appIDs: [env('IOS_APP_ID', 'TEAMID.it.spesasmart.spesaSmart')], components: [{ '/': '/i/*' }] }] },
  };
}
