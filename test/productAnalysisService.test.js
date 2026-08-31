import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProductImageUrl } from '../src/services/productAnalysisService.js';

test('product image URLs normalize schema.org objects and arrays', () => {
  assert.equal(
    normalizeProductImageUrl({ contentUrl: 'https://cdn.example.com/app.png' }),
    'https://cdn.example.com/app.png'
  );
  assert.equal(
    normalizeProductImageUrl([{ url: 'https://cdn.example.com/first.png' }]),
    'https://cdn.example.com/first.png'
  );
});

test('product image URLs resolve relative website icons and reject unsafe protocols', () => {
  assert.equal(
    normalizeProductImageUrl('/assets/icon.png', 'https://example.com/product/page'),
    'https://example.com/assets/icon.png'
  );
  assert.equal(
    normalizeProductImageUrl('data:image/png;base64,abc', 'https://example.com'),
    ''
  );
});
