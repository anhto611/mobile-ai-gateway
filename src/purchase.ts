import { decodeJwsPayload, signJwt } from './jwt';
import type { Env, GatewayConfig } from './types';

/**
 * Purchase proof sent by the app in X-Purchase-Proof:
 *   iOS:     ios:<transactionId>              (StoreKit 2 transaction id, original or latest)
 *   Android: android:<productId>:<purchaseToken>
 *
 * Returns true (premium), false (not premium) or null (could not check right now).
 * Null is never cached, so a store outage does not lock paying users out for long.
 */
export async function verifyPurchase(env: Env, config: GatewayConfig, proof: string): Promise<boolean | null> {
  if (proof.startsWith('ios:')) {
    const apple = config.purchases?.apple;
    if (!apple) return false;
    return verifyApple(env, apple, proof.slice(4));
  }
  if (proof.startsWith('android:')) {
    const google = config.purchases?.google;
    if (!google) return false;
    const rest = proof.slice(8);
    const sep = rest.indexOf(':');
    if (sep <= 0) return false;
    return verifyGoogle(env, google, rest.slice(0, sep), rest.slice(sep + 1));
  }
  return false;
}

// ---------- Apple: App Store Server API ----------

const APPLE_HOSTS = ['https://api.storekit.itunes.apple.com', 'https://api.storekit-sandbox.itunes.apple.com'];

interface AppleTransaction {
  bundleId: string;
  productId: string;
  revocationDate?: number;
  expiresDate?: number;
  originalTransactionId: string;
}

type AppleConfig = NonNullable<NonNullable<GatewayConfig['purchases']>['apple']>;

async function appleToken(env: Env, bundleId: string): Promise<string | null> {
  if (!env.APPLE_IAP_KEY_ID || !env.APPLE_IAP_ISSUER_ID || !env.APPLE_IAP_PRIVATE_KEY) {
    console.warn('[gateway] Apple purchase keys are not set, iOS users are treated as free');
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  return signJwt(
    'ES256',
    env.APPLE_IAP_PRIVATE_KEY,
    { kid: env.APPLE_IAP_KEY_ID },
    { iss: env.APPLE_IAP_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1', bid: bundleId },
  );
}

/** GET a path on production, then sandbox (TestFlight and Xcode purchases live there). */
async function appleGet(token: string, path: string): Promise<unknown | null | undefined> {
  for (const host of APPLE_HOSTS) {
    const res = await fetch(host + path, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return res.json();
    if (res.status === 404) continue;
    console.warn(`[gateway] Apple ${path} returned ${res.status}`);
    return null;
  }
  return undefined; // Not found anywhere.
}

export async function verifyApple(env: Env, apple: AppleConfig, transactionId: string): Promise<boolean | null> {
  if (!/^\d{1,32}$/.test(transactionId)) return false;
  try {
    const token = await appleToken(env, apple.bundleId);
    if (!token) return null;
    const info = (await appleGet(token, `/inApps/v1/transactions/${transactionId}`)) as
      | { signedTransactionInfo: string }
      | null
      | undefined;
    if (info === undefined) return false;
    if (info === null) return null;
    const tx = decodeJwsPayload<AppleTransaction>(info.signedTransactionInfo);
    if (tx.bundleId !== apple.bundleId) return false;

    if (apple.lifetimeProducts?.includes(tx.productId)) return !tx.revocationDate;

    if (apple.subscriptionProducts?.includes(tx.productId)) {
      // The app may send an old transaction id, so ask for the current state of the subscription.
      const status = (await appleGet(token, `/inApps/v1/subscriptions/${tx.originalTransactionId}`)) as
        | { data?: { lastTransactions?: { status: number; signedTransactionInfo: string }[] }[] }
        | null
        | undefined;
      if (status === undefined) return false;
      if (status === null) return null;
      // 1 = active, 4 = billing grace period.
      return (status.data ?? []).some((group) =>
        (group.lastTransactions ?? []).some((last) => {
          if (last.status !== 1 && last.status !== 4) return false;
          const latest = decodeJwsPayload<AppleTransaction>(last.signedTransactionInfo);
          return apple.subscriptionProducts!.includes(latest.productId) && !latest.revocationDate;
        }),
      );
    }
    return false;
  } catch (err) {
    console.warn('[gateway] Apple verification error', err);
    return null;
  }
}

// ---------- Google: Play Developer API ----------

type GoogleConfig = NonNullable<NonNullable<GatewayConfig['purchases']>['google']>;

let googleTokenCache: { token: string; expiresAt: number; email: string } | undefined;

async function googleAccessToken(env: Env): Promise<string | null> {
  if (!env.GOOGLE_SERVICE_ACCOUNT) {
    console.warn('[gateway] GOOGLE_SERVICE_ACCOUNT is not set, Android users are treated as free');
    return null;
  }
  const account = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT) as { client_email: string; private_key: string };
  if (googleTokenCache && googleTokenCache.email === account.client_email && googleTokenCache.expiresAt > Date.now() + 60_000) {
    return googleTokenCache.token;
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt('RS256', account.private_key, {}, {
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    console.warn(`[gateway] Google token request returned ${res.status}`);
    return null;
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  googleTokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000, email: account.client_email };
  return data.access_token;
}

export function resetGoogleTokenCache(): void {
  googleTokenCache = undefined;
}

export async function verifyGoogle(env: Env, google: GoogleConfig, productId: string, purchaseToken: string): Promise<boolean | null> {
  const isLifetime = google.lifetimeProducts?.includes(productId);
  const isSubscription = google.subscriptionProducts?.includes(productId);
  if (!isLifetime && !isSubscription) return false;
  if (!/^[A-Za-z0-9._\-:]{10,1024}$/.test(purchaseToken)) return false;
  try {
    const token = await googleAccessToken(env);
    if (!token) return null;
    const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(google.packageName)}/purchases`;
    const url = isLifetime
      ? `${base}/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`
      : `${base}/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 400 || res.status === 404 || res.status === 410) return false;
    if (!res.ok) {
      console.warn(`[gateway] Google Play returned ${res.status}`);
      return null;
    }
    if (isLifetime) {
      const p = (await res.json()) as { purchaseState?: number };
      return p.purchaseState === 0; // 0 = purchased, 1 = canceled, 2 = pending.
    }
    const s = (await res.json()) as { subscriptionState?: string; lineItems?: { productId: string }[] };
    const active = s.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE' || s.subscriptionState === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD';
    return active && (s.lineItems ?? []).some((item) => item.productId === productId);
  } catch (err) {
    console.warn('[gateway] Google verification error', err);
    return null;
  }
}
