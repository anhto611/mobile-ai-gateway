import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64UrlEncode } from '../src/jwt';
import { resetGoogleTokenCache, verifyPurchase } from '../src/purchase';
import type { Env, GatewayConfig } from '../src/types';
import { jsonResponse, mockFetch } from './helpers';

const config: GatewayConfig = {
  features: {},
  limits: { perMinutePerIp: 10, globalDaily: 10 },
  purchases: {
    apple: { bundleId: 'com.example.app', lifetimeProducts: ['life'], subscriptionProducts: ['monthly'] },
    google: { packageName: 'com.example.app', lifetimeProducts: ['life'], subscriptionProducts: ['sub'] },
  },
};

async function pem(alg: 'ES256' | 'RS256'): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    alg === 'ES256'
      ? { name: 'ECDSA', namedCurve: 'P-256' }
      : { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----`;
}

const jws = (payload: object) => `eyJhbGciOiJFUzI1NiJ9.${base64UrlEncode(JSON.stringify(payload))}.sig`;
let env: Env;

beforeAll(async () => {
  const applePem = await pem('ES256');
  const googlePem = await pem('RS256');
  env = {
    APPLE_IAP_KEY_ID: 'KEY123',
    APPLE_IAP_ISSUER_ID: 'issuer',
    // Literal \n, as pasted from a .env file.
    APPLE_IAP_PRIVATE_KEY: applePem.replace(/\n/g, '\\n'),
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@x.iam.gserviceaccount.com', private_key: googlePem }),
  } as Env;
});
beforeEach(() => resetGoogleTokenCache());
afterEach(() => vi.unstubAllGlobals());

describe('Apple', () => {
  it('accepts a lifetime purchase and signs a valid-looking JWT', async () => {
    const calls = mockFetch(() => jsonResponse({ signedTransactionInfo: jws({ bundleId: 'com.example.app', productId: 'life', originalTransactionId: '1' }) }));
    expect(await verifyPurchase(env, config, 'ios:2000000123')).toBe(true);
    expect(calls[0].url).toBe('https://api.storekit.itunes.apple.com/inApps/v1/transactions/2000000123');
    const token = (calls[0].init.headers as Record<string, string>).Authorization.slice(7);
    const [header, payload] = token.split('.').slice(0, 2).map((p) => JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))));
    expect(header).toMatchObject({ alg: 'ES256', kid: 'KEY123' });
    expect(payload).toMatchObject({ iss: 'issuer', aud: 'appstoreconnect-v1', bid: 'com.example.app' });
  });

  it('falls back to sandbox when production does not know the transaction', async () => {
    const calls = mockFetch((url) =>
      url.includes('sandbox')
        ? jsonResponse({ signedTransactionInfo: jws({ bundleId: 'com.example.app', productId: 'life', originalTransactionId: '1' }) })
        : jsonResponse({ errorCode: 4040010 }, 404),
    );
    expect(await verifyPurchase(env, config, 'ios:42')).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('rejects refunds, other apps and unknown products', async () => {
    const reply = (tx: object) => mockFetch(() => jsonResponse({ signedTransactionInfo: jws({ originalTransactionId: '1', ...tx }) }));
    reply({ bundleId: 'com.example.app', productId: 'life', revocationDate: 1 });
    expect(await verifyPurchase(env, config, 'ios:1')).toBe(false);
    reply({ bundleId: 'com.other', productId: 'life' });
    expect(await verifyPurchase(env, config, 'ios:1')).toBe(false);
    reply({ bundleId: 'com.example.app', productId: 'coins' });
    expect(await verifyPurchase(env, config, 'ios:1')).toBe(false);
  });

  it('checks the current subscription status', async () => {
    const status = (code: number) =>
      mockFetch((url) =>
        url.includes('/subscriptions/')
          ? jsonResponse({ data: [{ lastTransactions: [{ status: code, signedTransactionInfo: jws({ bundleId: 'com.example.app', productId: 'monthly' }) }] }] })
          : jsonResponse({ signedTransactionInfo: jws({ bundleId: 'com.example.app', productId: 'monthly', originalTransactionId: '777' }) }),
      );
    let calls = status(1);
    expect(await verifyPurchase(env, config, 'ios:9')).toBe(true);
    expect(calls[1].url).toContain('/inApps/v1/subscriptions/777');
    calls = status(2); // expired
    expect(await verifyPurchase(env, config, 'ios:9')).toBe(false);
  });

  it('returns null when Apple is unreachable', async () => {
    mockFetch(() => jsonResponse({}, 500));
    expect(await verifyPurchase(env, config, 'ios:1')).toBeNull();
  });

  it('rejects malformed proofs without calling Apple', async () => {
    const calls = mockFetch(() => jsonResponse({}));
    expect(await verifyPurchase(env, config, 'ios:abc')).toBe(false);
    expect(await verifyPurchase(env, config, 'web:1')).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('Google', () => {
  const token = 'tok'.repeat(10);

  it('verifies a lifetime product', async () => {
    const calls = mockFetch((url) =>
      url.includes('oauth2') ? jsonResponse({ access_token: 'at', expires_in: 3600 }) : jsonResponse({ purchaseState: 0 }),
    );
    expect(await verifyPurchase(env, config, `android:life:${token}`)).toBe(true);
    expect(calls[1].url).toBe(
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/purchases/products/life/tokens/${token}`,
    );
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe('Bearer at');
  });

  it('verifies an active subscription and reuses the access token', async () => {
    const calls = mockFetch((url) =>
      url.includes('oauth2')
        ? jsonResponse({ access_token: 'at', expires_in: 3600 })
        : jsonResponse({ subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', lineItems: [{ productId: 'sub' }] }),
    );
    expect(await verifyPurchase(env, config, `android:sub:${token}`)).toBe(true);
    expect(await verifyPurchase(env, config, `android:sub:${token}`)).toBe(true);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
  });

  it('rejects expired subscriptions and unknown products', async () => {
    mockFetch((url) =>
      url.includes('oauth2')
        ? jsonResponse({ access_token: 'at', expires_in: 3600 })
        : jsonResponse({ subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', lineItems: [{ productId: 'sub' }] }),
    );
    expect(await verifyPurchase(env, config, `android:sub:${token}`)).toBe(false);
    expect(await verifyPurchase(env, config, `android:coins:${token}`)).toBe(false);
  });
});
