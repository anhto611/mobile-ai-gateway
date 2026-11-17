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
    summarize: {
      description: 'Summarizes an article, note or message into a title, a short summary and tags.',
      input: {
        fields: {
          text: { type: 'string', required: true, maxLength: 12000 },
          language: { type: 'string', maxLength: 30 },
        },
      },
      prompt: [
        'Summarize the text below for someone reading on a phone.',
        'Write the title, summary and tags in {{language}}. If no language is given, use the language of the text.',
        'The summary is 2 to 3 sentences. Tags are 1 to 5 short lowercase topics.',
        '',
        'Text: """{{text}}"""',
      ].join('\n'),
      output: {
        type: 'json',
        schema: {
          type: 'object',
          required: ['title', 'summary', 'tags'],
          properties: {
            title: { type: 'string', description: 'Max 80 characters' },
            summary: { type: 'string' },
            tags: { type: 'array', maxItems: 5, items: { type: 'string' } },
          },
        },
      },
      models: [
        { provider: 'gemini', model: 'gemini-3.5-flash-lite' },
        { provider: 'groq', model: 'openai/gpt-oss-120b' },
        { provider: 'anthropic', model: 'claude-haiku-5-5' },
      ],
      limits: { free: 20, premium: 'unlimited' },
      temperature: 0.3,
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
