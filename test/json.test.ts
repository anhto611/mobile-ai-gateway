import { describe, expect, it } from 'vitest';
import { extractJson, validate } from '../src/json';
import type { JsonSchema } from '../src/types';

describe('extractJson', () => {
  it('parses plain JSON', () => expect(extractJson('{"a":1}')).toEqual({ a: 1 }));
  it('strips code fences', () => expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 }));
  it('finds JSON after prose', () => expect(extractJson('Sure! Here it is: {"a":[1,2]} Hope it helps')).toEqual({ a: [1, 2] }));
  it('parses arrays', () => expect(extractJson('[{"a":1}]')).toEqual([{ a: 1 }]));
  it('throws when there is no JSON', () => expect(() => extractJson('no idea')).toThrow());
});

describe('validate', () => {
  const schema: JsonSchema = {
    type: 'object',
    required: ['amount', 'category'],
    properties: {
      amount: { type: 'number', minimum: 0 },
      category: { type: 'string', enum: ['food', 'other'] },
      note: { type: 'string', nullable: true },
      items: { type: 'array', maxItems: 2, items: { type: 'integer' } },
    },
  };

  it('accepts a valid value', () => {
    expect(validate({ amount: 5, category: 'food', note: null, items: [1, 2] }, schema)).toEqual([]);
  });

  it('reports each problem with its path', () => {
    const errors = validate({ amount: -1, category: 'cars', items: [1.5, 2, 3] }, schema);
    expect(errors).toContain('$.amount must be >= 0');
    expect(errors).toContain('$.category must be one of food, other');
    expect(errors).toContain('$.items must have at most 2 items');
  });

  it('requires required fields', () => {
    expect(validate({ amount: 1 }, schema)).toEqual(['$.category is required']);
  });

  it('rejects null unless nullable', () => {
    expect(validate({ amount: null, category: 'food' }, schema)).toEqual(['$.amount must not be null']);
  });
});
