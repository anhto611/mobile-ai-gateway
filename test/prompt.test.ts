import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/http';
import { renderPrompt, validateImage, validateInput } from '../src/prompt';
import type { FeatureConfig } from '../src/types';

const feature: FeatureConfig = {
  description: 'test',
  input: { fields: { text: { type: 'string', required: true, maxLength: 10 }, n: { type: 'number' } }, image: 'optional' },
  prompt: 'Say {{ text }} {{n}} times{{missing}}.',
  output: { type: 'text' },
  models: [{ provider: 'gemini', model: 'm' }],
  limits: { free: 1, premium: 'unlimited' },
};

describe('validateInput', () => {
  it('keeps declared fields', () => expect(validateInput(feature, { text: 'hi', n: 2 })).toEqual({ text: 'hi', n: 2 }));
  it('requires required fields', () => expect(() => validateInput(feature, {})).toThrow(HttpError));
  it('rejects unknown fields', () => expect(() => validateInput(feature, { text: 'a', extra: 1 })).toThrow(/Unknown input field/));
  it('checks types', () => expect(() => validateInput(feature, { text: 'a', n: '2' })).toThrow(/must be a number/));
  it('checks length', () => expect(() => validateInput(feature, { text: 'x'.repeat(11) })).toThrow(/longer than 10/));
});

describe('renderPrompt', () => {
  it('fills placeholders and blanks missing ones', () => {
    expect(renderPrompt(feature, { text: 'hi', n: 3 })).toBe('Say hi 3 times.');
  });
  it('supports prompt functions', () => {
    expect(renderPrompt({ ...feature, prompt: (i) => `X${i.text}` }, { text: 'y' })).toBe('Xy');
  });
});

describe('validateImage', () => {
  it('accepts base64 and strips a data URL prefix', () => {
    expect(validateImage(feature, { data: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' })).toEqual({
      data: 'aGVsbG8=',
      mimeType: 'image/png',
    });
  });
  it('rejects unsupported types', () => {
    expect(() => validateImage(feature, { data: 'aGVsbG8=', mimeType: 'image/gif' })).toThrow(/Image type/);
  });
  it('rejects images on text-only features', () => {
    expect(() => validateImage({ ...feature, input: {} }, { data: 'aGVsbG8=', mimeType: 'image/png' })).toThrow(/does not accept/);
  });
  it('requires an image when configured', () => {
    expect(() => validateImage({ ...feature, input: { image: 'required' } }, undefined)).toThrow(/needs an image/);
  });
});
