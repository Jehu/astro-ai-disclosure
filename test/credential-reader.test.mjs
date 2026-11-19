import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createCredentialReader } from '../dist/credentials.js';

// Project root = test/, so glob keys resolve to the binary fixtures.
const root = fileURLToPath(new URL('.', import.meta.url));
const meta = (src) => ({ src, width: 4, height: 3, format: 'jpg' });
const modules = {
  '/fixtures/c2pa-google.jpg': meta('/_astro/ai.hash.jpg'),
  '/fixtures/plain.jpg': meta('/_astro/photo.hash.jpg'),
};
const read = createCredentialReader(modules, root);

test('reader matches a different object with the same src (content collections)', async () => {
  const fromCollection = { ...modules['/fixtures/c2pa-google.jpg'] };
  assert.notEqual(fromCollection, modules['/fixtures/c2pa-google.jpg']);
  assert.equal((await read(fromCollection))?.provenance, 'c2pa');
});

test('reader keeps real photos and unknown images without credentials', async () => {
  assert.equal(await read({ ...modules['/fixtures/plain.jpg'] }), null);
  assert.equal(await read(meta('/_astro/unknown.hash.jpg')), null);
});
