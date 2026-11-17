# mobile-ai-gateway-client

Typed client for [mobile-ai-gateway](https://github.com/anhto611/mobile-ai-gateway). No dependencies. Works in React Native, Expo, web and Node 18+.

```ts
import { createGateway, GatewayError } from 'mobile-ai-gateway-client';

const ai = createGateway({ baseUrl: 'https://your-gateway.workers.dev', deviceId: 'install-uuid' });
const { data, usage } = await ai.run<{ title: string; summary: string }>('summarize', { text: article });
```

`run` throws a `GatewayError` with a `code` (`quota_exceeded`, `rate_limited`, `ai_failed`, `network_error`, `timeout` and others), the HTTP `status`, any `details` from the server, and a `retryable` flag.

See the main README for setup and the full API.
