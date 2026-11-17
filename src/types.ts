/** Supported AI providers. Each one reads its API key from a Worker secret. */
export type ProviderName = 'gemini' | 'anthropic' | 'openai' | 'groq';

export interface ModelRef {
  provider: ProviderName;
  model: string;
}

/** A small JSON Schema subset, enough to describe and check structured AI output. */
export type JsonSchema =
  | { type: 'object'; properties: Record<string, JsonSchema>; required?: string[]; description?: string; nullable?: boolean }
  | { type: 'array'; items: JsonSchema; maxItems?: number; description?: string; nullable?: boolean }
  | { type: 'string'; enum?: string[]; description?: string; nullable?: boolean }
  | { type: 'number' | 'integer'; minimum?: number; maximum?: number; description?: string; nullable?: boolean }
  | { type: 'boolean'; description?: string; nullable?: boolean };

export interface InputField {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  /** For strings. Defaults to 4000 characters. */
  maxLength?: number;
}

export type FeatureInput = Record<string, string | number | boolean | undefined>;

export interface FeatureConfig {
  /** Shown by GET /v1/features. */
  description: string;
  /** Fields the app sends in `input`, plus whether an image is accepted. */
  input?: {
    fields?: Record<string, InputField>;
    image?: 'none' | 'optional' | 'required';
  };
  /**
   * The prompt. A string can use {{field}} placeholders (values are inserted as-is),
   * or pass a function for full control.
   */
  prompt: string | ((input: FeatureInput) => string);
  /** JSON output is checked against the schema; text output is returned as-is. */
  output: { type: 'json'; schema: JsonSchema } | { type: 'text' };
  /** Tried in order. The first model that returns a valid result wins. */
  models: ModelRef[];
  /** Calls per device per UTC day. */
  limits: { free: number; premium: number | 'unlimited' };
  temperature?: number;
  maxOutputTokens?: number;
}

export interface PurchaseProducts {
  /** One-time purchases that unlock premium forever (unless refunded). */
  lifetimeProducts?: string[];
  /** Auto-renewable subscriptions that unlock premium while active. */
  subscriptionProducts?: string[];
}

export interface GatewayConfig {
  features: Record<string, FeatureConfig>;
  limits: {
    /** Requests per IP address per minute, across all features. */
    perMinutePerIp: number;
    /** Total AI calls per UTC day across all devices. Protects your provider bill. */
    globalDaily: number;
  };
  /** Turn on store-verified premium. Leave out to treat everyone as free. */
  purchases?: {
    apple?: PurchaseProducts & { bundleId: string };
    google?: PurchaseProducts & { packageName: string };
  };
  /** Origins allowed to call the gateway from a browser. Mobile apps do not need this. */
  cors?: { allowOrigins: string[] };
}

export interface Env {
  QUOTA: DurableObjectNamespace;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GROQ_API_KEY?: string;
  /** Optional shared key. When set, every request must send it in X-App-Key. */
  APP_KEY?: string;
  APPLE_IAP_KEY_ID?: string;
  APPLE_IAP_ISSUER_ID?: string;
  APPLE_IAP_PRIVATE_KEY?: string;
  /** Full service-account JSON key with access to Play Console orders. */
  GOOGLE_SERVICE_ACCOUNT?: string;
}

export function defineConfig(config: GatewayConfig): GatewayConfig {
  return config;
}
