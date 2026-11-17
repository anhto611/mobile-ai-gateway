import { defineConfig } from './src/types';

/**
 * Your features live here. Each one becomes POST /v1/features/<name>.
 * Edit, delete or add features, then run `npm run deploy`.
 *
 * Models are tried in order: if the first fails or returns output that does not match
 * the schema, the next one runs. Models whose API key is not set are skipped, so you
 * only need a key for one provider to start.
 */
export default defineConfig({
  limits: {
    perMinutePerIp: 30,
    globalDaily: 5000,
  },

  // Uncomment to unlock premium limits for users who bought in your app.
  // purchases: {
  //   apple: { bundleId: 'com.example.app', lifetimeProducts: ['premium_lifetime'], subscriptionProducts: ['premium_monthly', 'premium_yearly'] },
  //   google: { packageName: 'com.example.app', lifetimeProducts: ['premium_lifetime'], subscriptionProducts: ['premium'] },
  // },

  // Only needed if a web app calls the gateway from the browser.
  // cors: { allowOrigins: ['https://example.com'] },

  features: {
    'parse-expense': {
      description: 'Turns a sentence like "lunch 12.50 with Sam yesterday" into a structured expense.',
      input: {
        fields: {
          text: { type: 'string', required: true, maxLength: 500 },
          today: { type: 'string', required: true, maxLength: 10 },
          currency: { type: 'string', maxLength: 3 },
        },
      },
      prompt: [
        'Extract one expense from the text below.',
        'Today is {{today}}. Use this date when the text gives no date, and resolve words like "yesterday" from it.',
        'Default currency: {{currency}}. Use it when the text does not name a currency.',
        'If the text contains no expense, return amount 0 and category "other".',
        '',
        'Text: """{{text}}"""',
      ].join('\n'),
      output: {
        type: 'json',
        schema: {
          type: 'object',
          required: ['amount', 'currency', 'category', 'note', 'date'],
          properties: {
            amount: { type: 'number', minimum: 0 },
            currency: { type: 'string', description: 'ISO 4217 code, e.g. USD' },
            category: { type: 'string', enum: ['food', 'transport', 'shopping', 'bills', 'health', 'entertainment', 'travel', 'other'] },
            note: { type: 'string', description: 'Short description, max 60 characters' },
            date: { type: 'string', description: 'YYYY-MM-DD' },
          },
        },
      },
      models: [
        { provider: 'groq', model: 'openai/gpt-oss-120b' },
        { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
        { provider: 'anthropic', model: 'claude-haiku-5-5' },
      ],
      limits: { free: 50, premium: 'unlimited' },
      temperature: 0.1,
      maxOutputTokens: 2048,
    },

    'scan-receipt': {
      description: 'Reads a receipt photo and returns the merchant, line items and total.',
      input: { image: 'required' },
      prompt: [
        'Read this receipt photo.',
        'Return the merchant name, each line item with its price, and the total the customer paid.',
        'Use null for anything you cannot read. Do not guess numbers.',
      ].join('\n'),
      output: {
        type: 'json',
        schema: {
          type: 'object',
          required: ['merchant', 'items', 'total', 'currency'],
          properties: {
            merchant: { type: 'string', nullable: true },
            date: { type: 'string', nullable: true, description: 'YYYY-MM-DD' },
            currency: { type: 'string', nullable: true },
            items: {
              type: 'array',
              maxItems: 100,
              items: {
                type: 'object',
                required: ['name', 'price'],
                properties: {
                  name: { type: 'string' },
                  quantity: { type: 'number', nullable: true },
                  price: { type: 'number' },
                },
              },
            },
            total: { type: 'number', nullable: true },
          },
        },
      },
      models: [
        { provider: 'gemini', model: 'gemini-2.5-flash' },
        { provider: 'anthropic', model: 'claude-haiku-5-5' },
      ],
      limits: { free: 3, premium: 100 },
      temperature: 0.1,
      maxOutputTokens: 4096,
    },

    ask: {
      description: 'Answers a short question in plain text, using optional context the app sends.',
      input: {
        fields: {
          question: { type: 'string', required: true, maxLength: 1000 },
          context: { type: 'string', maxLength: 8000 },
        },
      },
      prompt: [
        'You are a helpful assistant inside a mobile app. Answer in the language of the question.',
        'Keep the answer under 150 words. If the context does not contain the answer, say so.',
        '',
        'Context:',
        '{{context}}',
        '',
        'Question: {{question}}',
      ].join('\n'),
      output: { type: 'text' },
      models: [
        { provider: 'anthropic', model: 'claude-haiku-5-5' },
        { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      ],
      limits: { free: 10, premium: 200 },
      maxOutputTokens: 1024,
    },
  },
});
