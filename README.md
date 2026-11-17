# mobile-ai-gateway

A small Cloudflare Worker that sits between your mobile app and AI providers (Gemini, Claude, OpenAI, Groq).

Your app never ships an API key. You describe each AI feature once in a config file (prompt, input, output schema, which models to try, daily limits) and the app calls it by name:

```ts
const { data, usage } = await ai.run('scan-receipt', {}, { image: { data: base64, mimeType: 'image/jpeg' } });
// data:  { merchant: 'Corner Cafe', items: [...], total: 18.4, currency: 'USD' }
// usage: { used: 1, limit: 3, remaining: 2, resetsAt: '2026-11-19T00:00:00.000Z', premium: false }
```

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/anhto611/mobile-ai-gateway)

I first built this pattern for the AI features of [Pig Money](https://apps.apple.com/app/id6756267838), my expense tracker app. This repo is a generic version that any app can use: it contains no Pig Money code, prompts or data.

## What it does

- **Keeps keys on the server.** Provider keys are Worker secrets. The app only knows your gateway URL.
- **One endpoint per feature.** `POST /v1/features/<name>`, defined in [`gateway.config.ts`](gateway.config.ts).
- **Structured output you can trust.** JSON replies are checked against the feature's schema. A reply that does not match counts as a failure.
- **Fallback between providers.** Models are tried in order. If one is down, slow, rate limited or returns bad JSON, the next one runs. Input errors (a broken image, for example) stop right away instead of trying every provider.
- **Daily limits per device**, with separate free and premium limits per feature. Failed AI calls are not counted against the user.
- **Premium checked with the store.** The app sends proof of purchase and the gateway verifies it with the App Store Server API or the Google Play Developer API. No user accounts needed.
- **Cost protection.** A per-IP rate limit and a global daily cap across all users.
- **Images.** Send JPEG, PNG or WebP as base64 for features that accept them.

It runs on the Workers free plan for small apps. Counters live in a SQLite-backed Durable Object.

## Quick start

You need a Cloudflare account and at least one provider key.

```bash
git clone https://github.com/anhto611/mobile-ai-gateway
cd mobile-ai-gateway
npm install
npx wrangler login

npx wrangler secret put GEMINI_API_KEY       # and/or ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY
npm run deploy
```

Wrangler prints your URL, for example `https://mobile-ai-gateway.<you>.workers.dev`. Try it:

```bash
curl https://mobile-ai-gateway.<you>.workers.dev/v1/features/summarize \
  -H 'Content-Type: application/json' \
  -H 'X-Device-Id: test-device-001' \
  -d '{"input": {"text": "Paste any article or long message here..."}}'
```

Models without a key are skipped, so a single Gemini key is enough to run all three example features.

## Defining features

Each entry in `features` becomes an endpoint. This is the shape (see the three working examples in [`gateway.config.ts`](gateway.config.ts)):

```ts
'scan-receipt': {
  description: 'Reads a receipt photo and returns the merchant, line items and total.',
  input: { image: 'required' },                       // and/or fields: { text: { type: 'string', required: true } }
  prompt: 'Read this receipt photo. ...',             // {{field}} placeholders, or a function (input) => string
  output: { type: 'json', schema: { type: 'object', required: ['total'], properties: { total: { type: 'number' } } } },
  models: [
    { provider: 'gemini', model: 'gemini-2.5-flash' },
    { provider: 'anthropic', model: 'claude-haiku-5-5' },
  ],
  limits: { free: 3, premium: 100 },                  // per device per UTC day; 0 = premium only; 'unlimited'
  temperature: 0.1,
  maxOutputTokens: 4096,
},
```

The schema is a small JSON Schema subset: `object`, `array`, `string` (with `enum`), `number`, `integer`, `boolean`, plus `required`, `nullable`, `minimum`, `maximum` and `maxItems`. It is added to the prompt and used to check the reply.

Unknown input fields are rejected, and every string field has a length limit (4,000 characters unless you set `maxLength`).

## Calling it from the app

Install the client (no dependencies, works in React Native, Expo, web and Node 18+):

```bash
npm install mobile-ai-gateway-client
```

```ts
import { createGateway, GatewayError } from 'mobile-ai-gateway-client';

const ai = createGateway({
  baseUrl: 'https://mobile-ai-gateway.<you>.workers.dev',
  deviceId: getDeviceId,                      // a stable id per install, e.g. a UUID kept in storage
  getPurchaseProof: async () => proofOrNull,  // see "Premium users" below
});

try {
  const { data, usage } = await ai.run<Summary>('summarize', { text: article });
} catch (err) {
  if (err instanceof GatewayError && err.code === 'quota_exceeded') showUpgrade(err.details.resetsAt);
}
```

A full screen is in [`examples/react-native.tsx`](examples/react-native.tsx). Any other platform (Swift, Kotlin, Flutter) can call the HTTP API directly.

## HTTP API

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Returns `{ "ok": true }` |
| `GET` | `/v1/features` | Lists features with their inputs, output schema and limits |
| `POST` | `/v1/features/:name` | Runs a feature |

Request headers:

| Header | Required | Value |
|---|---|---|
| `X-Device-Id` | yes | 8 to 128 characters: letters, digits, `.` `_` `:` `-` |
| `X-Purchase-Proof` | no | `ios:<transactionId>` or `android:<productId>:<purchaseToken>` |
| `X-App-Key` | only if `APP_KEY` is set | Your app key |

Request body: `{ "input": { ... }, "image": { "data": "<base64>", "mimeType": "image/jpeg" } }`. The image part is only for features that accept one, and must be under about 3.7 MB.

Success: `{ "ok": true, "data": ..., "usage": { used, limit, remaining, resetsAt, premium }, "model": { provider, model } }`

Errors: `{ "ok": false, "error": { "code": "...", "message": "..." } }`

| Code | HTTP | Meaning |
|---|---|---|
| `bad_request` | 400 / 413 | Missing or invalid input, image too large |
| `unauthorized` | 401 | Wrong or missing `X-App-Key` |
| `premium_required` | 403 | The feature has a free limit of 0 |
| `not_found` | 404 | No such feature |
| `quota_exceeded` | 429 | Daily limit reached. Includes `limit`, `used`, `resetsAt` |
| `rate_limited` | 429 | Too many requests from this IP. Sends `Retry-After` |
| `ai_failed` | 502 | Every model failed. The call was not counted |
| `busy` | 503 | The global daily cap was reached |
| `not_configured` | 500 | No API key set for any model of this feature |

## Premium users

Add your products to `purchases` in the config, then add the store keys as secrets.

**iOS (StoreKit 2).** Send `ios:<transactionId>` from the purchase or from `Transaction.currentEntitlements`. Create an In-App Purchase key in App Store Connect (Users and Access > Integrations > In-App Purchase), then:

```bash
npx wrangler secret put APPLE_IAP_KEY_ID
npx wrangler secret put APPLE_IAP_ISSUER_ID
npx wrangler secret put APPLE_IAP_PRIVATE_KEY < AuthKey_XXXXXXXX.p8
```

Lifetime products count unless refunded. Subscriptions count while active or in billing grace. The gateway asks Apple for the current subscription state, so an old transaction id still works after renewals. Production is tried first, then sandbox, so TestFlight purchases work too.

**Android.** Send `android:<productId>:<purchaseToken>`. Create a service account with access to your app's orders in Play Console, download its JSON key, then:

```bash
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT < service-account.json
```

Results are cached per device for 1 hour (premium) or 1 minute (not premium). If a store cannot be reached, the user is treated as free for that request and nothing is cached.

## Security notes

Be clear about what this protects:

- **Your keys are safe.** They never leave Cloudflare.
- **Device limits are a soft limit.** A determined user can send a new `X-Device-Id` each time. The per-IP rate limit and the global daily cap are what bound your bill, so set `globalDaily` to a number you are happy to pay for.
- **`APP_KEY` is not a secret.** Anything shipped in an app can be extracted. It only stops casual scripts from finding your URL and using it.
- **Prompt injection.** User text is placed into your prompt. Do not give a feature access to anything you would not show the user.

## Development

```bash
cp .dev.vars.example .dev.vars   # add your keys
npm run dev                      # local Worker on http://localhost:8787
npm test                         # unit tests, no network
npm run type-check
```

The Worker pins its placement to `gcp:us-central1` in `wrangler.toml` because Gemini rejects requests from some regions. Remove that block if you do not use Gemini.

## License

MIT
