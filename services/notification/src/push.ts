import { readFileSync } from 'node:fs';
import * as jwt from 'jsonwebtoken';

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushResult {
  /** Token non più validi (app disinstallata): vanno rimossi. */
  invalidTokens: string[];
  sent: number;
}

export interface PushSender {
  send(tokens: string[], message: PushMessage): Promise<PushResult>;
}

/** Sviluppo: scrive la notifica nel log invece di inviarla. */
export class LogSender implements PushSender {
  async send(tokens: string[], message: PushMessage): Promise<PushResult> {
    console.log(`[push] → ${tokens.length} dispositivi: ${message.title} — ${message.body}`);
    return { invalidTokens: [], sent: tokens.length };
  }
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

/**
 * Firebase Cloud Messaging HTTP v1 con un account di servizio (FCM_SERVICE_ACCOUNT_FILE).
 * FCM consegna anche su iOS tramite APNs, se il progetto Firebase ha la chiave APNs configurata.
 */
export class FcmSender implements PushSender {
  private readonly account: ServiceAccount;
  private accessToken?: { value: string; expiresAt: number };

  constructor(serviceAccountFile: string) {
    this.account = JSON.parse(readFileSync(serviceAccountFile, 'utf8'));
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now() + 60_000) return this.accessToken.value;
    const assertion = jwt.sign({ scope: 'https://www.googleapis.com/auth/firebase.messaging' }, this.account.private_key, {
      algorithm: 'RS256',
      issuer: this.account.client_email,
      audience: this.account.token_uri,
      expiresIn: 3600,
    });
    const res = await fetch(this.account.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    if (!res.ok) throw new Error(`OAuth FCM fallito: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async send(tokens: string[], message: PushMessage): Promise<PushResult> {
    const url = `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`;
    const auth = `Bearer ${await this.token()}`;
    const invalidTokens: string[] = [];
    let sent = 0;
    for (const token of tokens) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: message.title, body: message.body },
            data: message.data ?? {},
            android: { priority: 'normal', notification: { channel_id: 'offerte' } },
          },
        }),
      });
      if (res.ok) {
        sent++;
      } else if (res.status === 404 || res.status === 400) {
        const text = await res.text();
        if (text.includes('UNREGISTERED') || text.includes('INVALID_ARGUMENT')) invalidTokens.push(token);
        else console.error(`[push] FCM ${res.status}: ${text}`);
      } else {
        console.error(`[push] FCM ${res.status}: ${await res.text()}`);
      }
    }
    return { invalidTokens, sent };
  }
}

export function createSender(): PushSender {
  const file = process.env.FCM_SERVICE_ACCOUNT_FILE;
  return file ? new FcmSender(file) : new LogSender();
}
