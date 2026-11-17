import type { JsonSchema } from './types';

/** Pulls the first JSON value out of a model reply, tolerating ``` fences and leading text. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the outermost {...} or [...] block.
  }
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error('No JSON found in model output');
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(close);
  if (end <= start) throw new Error('No JSON found in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Returns a list of problems, empty when the value matches the schema. */
export function validate(value: unknown, schema: JsonSchema, path = '$'): string[] {
  if (value === null) return schema.nullable ? [] : [`${path} must not be null`];
  switch (schema.type) {
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) return [`${path} must be an object`];
      const obj = value as Record<string, unknown>;
      const errors: string[] = [];
      for (const key of schema.required ?? []) {
        if (!(key in obj) || obj[key] === undefined) errors.push(`${path}.${key} is required`);
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (obj[key] !== undefined) errors.push(...validate(obj[key], sub, `${path}.${key}`));
      }
      return errors;
    }
    case 'array': {
      if (!Array.isArray(value)) return [`${path} must be an array`];
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return [`${path} must have at most ${schema.maxItems} items`];
      }
      return value.flatMap((item, i) => validate(item, schema.items, `${path}[${i}]`));
    }
    case 'string':
      if (typeof value !== 'string') return [`${path} must be a string`];
      if (schema.enum && !schema.enum.includes(value)) return [`${path} must be one of ${schema.enum.join(', ')}`];
      return [];
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path} must be a number`];
      if (schema.type === 'integer' && !Number.isInteger(value)) return [`${path} must be an integer`];
      if (schema.minimum !== undefined && value < schema.minimum) return [`${path} must be >= ${schema.minimum}`];
      if (schema.maximum !== undefined && value > schema.maximum) return [`${path} must be <= ${schema.maximum}`];
      return [];
    }
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path} must be a boolean`];
  }
}

/** Text appended to the prompt so every provider knows the exact shape to return. */
export function schemaInstruction(schema: JsonSchema): string {
  return [
    '',
    'Reply with JSON only, no prose and no code fences.',
    'The JSON must match this JSON Schema:',
    JSON.stringify(schema),
  ].join('\n');
}
