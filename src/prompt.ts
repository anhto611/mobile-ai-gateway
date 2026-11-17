import { HttpError } from './http';
import type { FeatureConfig, FeatureInput } from './types';

const DEFAULT_MAX_LENGTH = 4000;

export function validateInput(feature: FeatureConfig, raw: unknown): FeatureInput {
  const fields = feature.input?.fields ?? {};
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new HttpError(400, 'bad_request', '`input` must be an object');
  }
  const given = (raw ?? {}) as Record<string, unknown>;
  const out: FeatureInput = {};
  for (const key of Object.keys(given)) {
    if (!(key in fields)) throw new HttpError(400, 'bad_request', `Unknown input field "${key}"`);
  }
  for (const [key, field] of Object.entries(fields)) {
    const value = given[key];
    if (value === undefined || value === null || value === '') {
      if (field.required) throw new HttpError(400, 'bad_request', `Input field "${key}" is required`);
      continue;
    }
    if (typeof value !== field.type) {
      throw new HttpError(400, 'bad_request', `Input field "${key}" must be a ${field.type}`);
    }
    if (typeof value === 'string' && value.length > (field.maxLength ?? DEFAULT_MAX_LENGTH)) {
      throw new HttpError(400, 'bad_request', `Input field "${key}" is longer than ${field.maxLength ?? DEFAULT_MAX_LENGTH} characters`);
    }
    out[key] = value as string | number | boolean;
  }
  return out;
}

export function renderPrompt(feature: FeatureConfig, input: FeatureInput): string {
  if (typeof feature.prompt === 'function') return feature.prompt(input);
  return feature.prompt.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const value = input[key];
    return value === undefined ? '' : String(value);
  });
}

export interface ImageInput {
  data: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** About 3.75 MB of image data once decoded. Most providers reject larger inline images. */
export const MAX_IMAGE_BASE64_LENGTH = 5_000_000;

export function validateImage(feature: FeatureConfig, raw: unknown): ImageInput | undefined {
  const mode = feature.input?.image ?? 'none';
  if (raw === undefined || raw === null) {
    if (mode === 'required') throw new HttpError(400, 'bad_request', 'This feature needs an image');
    return undefined;
  }
  if (mode === 'none') throw new HttpError(400, 'bad_request', 'This feature does not accept images');
  const img = raw as Record<string, unknown>;
  if (typeof img.data !== 'string' || typeof img.mimeType !== 'string') {
    throw new HttpError(400, 'bad_request', '`image` must be { data: base64 string, mimeType }');
  }
  if (!IMAGE_TYPES.includes(img.mimeType)) {
    throw new HttpError(400, 'bad_request', `Image type must be one of ${IMAGE_TYPES.join(', ')}`);
  }
  const data = img.data.replace(/^data:[^;]+;base64,/, '');
  if (data.length > MAX_IMAGE_BASE64_LENGTH) {
    throw new HttpError(413 as number, 'bad_request', 'Image is too large. Resize it to about 1600px on the long side before sending.');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new HttpError(400, 'bad_request', 'Image data is not valid base64');
  return { data, mimeType: img.mimeType as ImageInput['mimeType'] };
}
