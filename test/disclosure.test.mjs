import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import {
  readC2paManifest,
  readAiCredentialsFromBuffer,
  tagAiImage,
  assertAiDisclosure,
  TRAINED_ALGORITHMIC_MEDIA,
} from '../dist/index.js';
import { isAiSourceType } from '../dist/c2pa.js';
import { findXmpPacket } from '../dist/xmp.js';
import service from '../dist/image-service.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const COMPOSITE = 'http://cv.iptc.org/newscodes/digitalsourcetype/composite';

test('C2PA manifests yield source type, creator and date per generator', () => {
  const openai = readC2paManifest(fixture('c2pa-openai.png'));
  assert.equal(openai?.digitalSourceType, TRAINED_ALGORITHMIC_MEDIA);
  assert.equal(openai?.creator, 'GPT-4o');
  assert.equal(Date.parse(openai?.createdAt ?? ''), Date.parse('2026-04-19T00:00:00Z'));
  // Google states the creator only in a free-text description and no date.
  const google = readC2paManifest(fixture('c2pa-google.jpg'));
  assert.equal(google?.digitalSourceType, TRAINED_ALGORITHMIC_MEDIA);
  // Image-to-image: the last action's type (composite) describes the delivered
  // pixels. The reader is neutral; AI qualification happens in credentials.
  const composite = readC2paManifest(fixture('c2pa-composite.png'));
  assert.equal(composite?.digitalSourceType, COMPOSITE);
  assert.equal(readC2paManifest(fixture('plain.jpg')), null);
});

test('only AI source types qualify; digitalCapture and plain composites do not', () => {
  assert.ok(isAiSourceType(TRAINED_ALGORITHMIC_MEDIA));
  assert.ok(
    isAiSourceType('http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia'),
  );
  assert.equal(isAiSourceType('http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture'), false);
  assert.equal(isAiSourceType(COMPOSITE), false);
});

test('credentials prefer XMP, fall back to C2PA, and are null for plain photos', async () => {
  const legacy = await readAiCredentialsFromBuffer(fixture('xmp-legacy.jpg'));
  assert.equal(legacy?.provenance, 'xmp');
  assert.equal(legacy?.creator, 'Google Gemini Nano Banana Pro');
  assert.equal(legacy?.createdAt, '2026-04-17T18:08:39Z');
  assert.equal((await readAiCredentialsFromBuffer(fixture('c2pa-openai.png')))?.provenance, 'c2pa');
  assert.equal(await readAiCredentialsFromBuffer(fixture('plain.jpg')), null);
  assert.equal(await readAiCredentialsFromBuffer(fixture('plain.png')), null);
});

test('XMP fields are matched by namespace, not by prefix; entities and unicode decode', async () => {
  // The packet uses the prefix `foo` for the IPTC extension namespace.
  const png = await sharp(fixture('plain.png'))
    .withXmp(
      readFileSync(new URL('./fixtures/xmp-varprefix.xml', import.meta.url), 'utf8').replace(
        '<sus:',
        '<foo:DigitalSourceType xmlns:foo="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">' +
          TRAINED_ALGORITHMIC_MEDIA +
          '</foo:DigitalSourceType><sus:',
      ),
    )
    .png()
    .toBuffer();
  const credentials = await readAiCredentialsFromBuffer(new Uint8Array(png));
  assert.equal(credentials?.provenance, 'xmp');
  assert.equal(credentials?.createdAt, '2026-01-02T03:04:05Z');
  assert.equal(credentials?.description, 'Ein & Test — ok');
});

test('an XMP digitalCapture photo declares no AI credentials', async () => {
  const packet =
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">` +
    `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/">` +
    `<Iptc4xmpExt:DigitalSourceType>http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture</Iptc4xmpExt:DigitalSourceType>` +
    `</rdf:Description></rdf:RDF></x:xmpmeta>`;
  const png = await sharp(fixture('plain.png')).withXmp(packet).png().toBuffer();
  assert.equal(await readAiCredentialsFromBuffer(new Uint8Array(png)), null);
});

test('tagging is idempotent, keeps pixels, and never touches C2PA-signed files', async () => {
  for (const name of ['plain.jpg', 'plain.png']) {
    const input = fixture(name);
    const first = tagAiImage(input, { system: 'Test Generator' });
    assert.equal(first.result, 'tagged');
    const credentials = await readAiCredentialsFromBuffer(first.buffer);
    assert.equal(credentials?.digitalSourceType, TRAINED_ALGORITHMIC_MEDIA);
    assert.equal(credentials?.creator, 'Test Generator');
    const second = tagAiImage(first.buffer);
    assert.equal(second.result, 'already-tagged');
    assert.equal(second.buffer, first.buffer);
    const [before, after] = await Promise.all([sharp(input).raw().toBuffer(), sharp(first.buffer).raw().toBuffer()]);
    assert.ok(before.equals(after), `${name}: pixels changed`);
  }
  const signed = fixture('c2pa-openai.png');
  const skipped = tagAiImage(signed);
  assert.equal(skipped.result, 'skipped-c2pa');
  assert.equal(skipped.buffer, signed);
});

test('tagging leaves a legacy packet that already carries the IPTC field untouched', async () => {
  const input = fixture('xmp-legacy.jpg');
  const { result, buffer } = tagAiImage(input);
  assert.equal(result, 'already-tagged');
  assert.equal(buffer, input);
  assert.equal((await readAiCredentialsFromBuffer(buffer))?.description, 'AI-generated illustration (akne-slide-1)');
});

test('tagging preserves every existing (unknown) XMP field in every container', async () => {
  const packet = readFileSync(new URL('./fixtures/xmp-varprefix.xml', import.meta.url), 'utf8');
  for (const [name, container] of [
    ['png', await sharp(fixture('plain.png')).withXmp(packet).png().toBuffer()],
    ['jpeg', await sharp(fixture('plain.jpg')).withXmp(packet).jpeg().toBuffer()],
    ['webp', await sharp(fixture('plain.png')).withXmp(packet).webp().toBuffer()],
  ]) {
    const { result, buffer } = tagAiImage(new Uint8Array(container), { system: 'Boundary Test' });
    assert.equal(result, 'tagged', name);
    const text = findXmpPacket(buffer)?.text ?? '';
    assert.ok(text.includes('<sus:GenerationDate>2026-01-02T03:04:05Z</sus:GenerationDate>'), `${name}: unknown field lost`);
    assert.ok(/<foo:DigitalSourceType>[^<]*trainedAlgorithmicMedia/.test(text), `${name}: source type missing`);
    assert.equal((await readAiCredentialsFromBuffer(buffer))?.description, 'Ein & Test — ok', `${name}: entity content changed`);
    assert.equal(tagAiImage(buffer).result, 'already-tagged', name);
    const pixelsEqual =
      Buffer.compare(await sharp(container).raw().toBuffer(), await sharp(buffer).raw().toBuffer()) === 0;
    assert.ok(pixelsEqual, `${name}: pixels changed`);
  }
});

const transform = (buffer, format) =>
  service.transform(new Uint8Array(buffer), { src: 'x', format, width: 32 }, { service: { entrypoint: '', config: {} } });

const read = async (data) => (await readAiCredentialsFromBuffer(data))?.digitalSourceType ?? null;
test('derivatives carry the declared source type; AI disclosure only for AI types', async () => {
  for (const format of ['webp', 'avif', 'jpeg', 'png']) {
    assert.equal(await read((await transform(fixture('c2pa-openai.png'), format)).data), TRAINED_ALGORITHMIC_MEDIA, `c2pa → ${format}`);
    assert.equal(await read((await transform(fixture('xmp-legacy.jpg'), format)).data), TRAINED_ALGORITHMIC_MEDIA, `xmp → ${format}`);
    assert.equal(await read((await transform(fixture('plain.jpg'), format)).data), null, `plain → ${format}`);
    // Composite sources keep their declared marker in every derivative…
    const derivative = (await transform(fixture('c2pa-composite.png'), format)).data;
    // sharp decodes XMP for every output format, including AVIF.
    const derivativeXmp = (await sharp(derivative).metadata()).xmp?.toString('utf-8') ?? '';
    assert.match(derivativeXmp, /DigitalSourceType>[^<]*\/composite</, `composite → ${format}`);
    // …but it never becomes an AI credential, whatever the credentials layer returns.
    const compositeCreds = await readAiCredentialsFromBuffer(derivative);
    assert.ok(compositeCreds === null || !isAiSourceType(compositeCreds.digitalSourceType), `composite creds → ${format}`);
  }
});

test('a C2PA source with existing XMP keeps the whole packet through optimisation', async () => {
  // Synthetic dual source: an XMP-carrying PNG with the caBX chunk of the OpenAI fixture.
  const png = await sharp(fixture('plain.png')).withXmp(readFileSync(new URL('./fixtures/xmp-varprefix.xml', import.meta.url), 'utf8')).png().toBuffer();
  const openai = fixture('c2pa-openai.png');
  const view = new DataView(openai.buffer, openai.byteOffset, openai.byteLength);
  let caBX = null;
  let off = 8;
  while (off + 12 <= openai.length) {
    const length = view.getUint32(off);
    const type = openai.toString('latin1', off + 4, off + 8);
    if (type === 'caBX') {
      caBX = openai.subarray(off, off + 12 + length);
      break;
    }
    off += 12 + length;
  }
  const ihdrEnd = 8 + 12 + view.getUint32(8);
  const dual = Buffer.concat([png.subarray(0, ihdrEnd), caBX, png.subarray(ihdrEnd)]);
  const derivative = await transform(dual, 'webp');
  const text = findXmpPacket(derivative.data)?.text ?? '';
  assert.ok(text.includes('<sus:GenerationDate>2026-01-02T03:04:05Z</sus:GenerationDate>'), 'existing XMP replaced');
  assert.ok(/DigitalSourceType>[^<]*trainedAlgorithmicMedia/.test(text), 'source type not merged in');
});

test('declared intent must match the images', async () => {
  const ai = await readAiCredentialsFromBuffer(fixture('c2pa-openai.png'));
  assert.doesNotThrow(() => assertAiDisclosure([{ label: 'a', credentials: ai }], true));
  assert.doesNotThrow(() => assertAiDisclosure([{ label: 'p', credentials: null }], false));
  assert.throws(() => assertAiDisclosure([{ label: 'photo.jpg', credentials: null }], true), /photo\.jpg is declared AI-generated/);
  assert.throws(() => assertAiDisclosure([{ label: 'ai.png', credentials: ai }], false), /ai\.png carries AI credentials/);
});
