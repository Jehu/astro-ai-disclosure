// AI disclosure in XMP, written at the packet level so that every existing
// (also unknown-to-us) field survives tagging byte-for-byte.
//
// The canonical signal is the IPTC field `Iptc4xmpExt:DigitalSourceType`,
// which Google Images and other tools read. Older packets written by the
// sanft-schoen `_ai_metadata.py` script carry a custom `sus:AIGenerated` flag
// instead of (or in addition to) it; those are recognised for reading.
//
// Fields are matched by XML namespace URI (any prefix), entities are decoded,
// and packets are located structurally (JPEG APP1, PNG iTXt, WebP XMP chunk) —
// no whole-file scans.

import { inflateSync, deflateSync } from 'node:zlib';
import { readMetadata, writeMetadata, DIGITAL_SOURCE_TYPE } from 'aeo-image';
import sharp from 'sharp';
import { hasC2paManifest, isAiSourceType } from './c2pa.js';

export const TRAINED_ALGORITHMIC_MEDIA: string = DIGITAL_SOURCE_TYPE.trainedAlgorithmicMedia;

export const IPTC_EXT_NS = 'http://iptc.org/std/Iptc4xmpExt/2008-02-29/';
const XAP_NS = 'http://ns.adobe.com/xap/1.0/';
const DC_NS = 'http://purl.org/dc/elements/1.1/';
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
/** Namespace of the legacy sanft-schoen `sus:` fields. */
const SUS_NS_HOST = 'sanft-schoen.de';

export interface XmpCredentials {
  digitalSourceType: string;
  creator?: string;
  createdAt?: string;
  description?: string;
  rights?: string;
}

/** Where an XMP packet lives inside the image container. */
interface XmpLocation {
  /** Packet text, UTF-8 decoded. */
  text: string;
  /** Container kind, decides how a replacement packet is spliced back. */
  kind: 'jpeg' | 'png' | 'webp';
  /** Absolute offsets of the packet bytes inside the container. */
  start: number;
  end: number;
  /** Offset of the container length field that must be updated: JPEG APP1
   * segment length (2 bytes BE), PNG chunk length (4 bytes BE), WebP XMP
   * chunk size (4 bytes LE). */
  lengthAt: number;
  /** PNG only: absolute offsets of the iTXt chunk header and CRC field. */
  pngChunkStart?: number;
  pngCrcAt?: number;
  /** WebP only: offset of the RIFF size field. */
  riffSizeAt?: number;
  /** PNG only: the XMP chunk payload is zlib-compressed (zTXt, as written by sharp). */
  pngCompressed?: boolean;
}

const XMP_SIG = 'http://ns.adobe.com/xap/1.0/\0';
const PNG_XMP_KEYWORD = 'XML:com.adobe.xmp';
const UTF8 = new TextDecoder();

// --- container access (JPEG APP1, PNG iTXt, WebP XMP chunk) ---------------

/** Locates the image's XMP packet structurally, or returns null. */
export function findXmpPacket(buffer: Uint8Array): XmpLocation | null {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let off = 2;
    while (off + 4 <= buffer.length && buffer[off] === 0xff) {
      const marker = buffer[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      if (marker === 0xda) break;
      const length = view.getUint16(off + 2);
      if (length < 2 || off + 2 + length > buffer.length) break;
      const payload = off + 4;
      if (marker === 0xe1 && payload + XMP_SIG.length <= off + 2 + length && bufferAt(buffer, payload).startsWith(XMP_SIG)) {
        const start = payload + XMP_SIG.length;
        return { text: UTF8.decode(buffer.subarray(start, off + 2 + length)), kind: 'jpeg', start, end: off + 2 + length, lengthAt: off + 2 };
      }
      off += 2 + length;
    }
    return null;
  }
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    let off = 8;
    while (off + 12 <= buffer.length) {
      const length = view.getUint32(off);
      const type = String.fromCharCode(buffer[off + 4], buffer[off + 5], buffer[off + 6], buffer[off + 7]);
      if (length > buffer.length - off - 12) break;
      const dataStart = off + 8;
      const dataEnd = off + 8 + length;
      const isXmpChunk =
        (type === 'iTXt' || type === 'zTXt') &&
        bufferAt(buffer, dataStart).startsWith(PNG_XMP_KEYWORD) &&
        buffer[dataStart + PNG_XMP_KEYWORD.length] === 0;
      if (isXmpChunk) {
        let p: number;
        if (type === 'zTXt') {
          // keyword NUL, compression method (0 = zlib), compressed data
          p = dataStart + PNG_XMP_KEYWORD.length + 2;
          if (p < dataEnd && buffer[p - 1] === 0) {
            try {
              return {
                text: inflateSync(buffer.subarray(p, dataEnd)).toString('utf-8'),
                kind: 'png',
                start: p,
                end: dataEnd,
                lengthAt: off,
                pngChunkStart: off,
                pngCrcAt: dataEnd,
                pngCompressed: true,
              };
            } catch {
              // malformed compressed data: fall through to other chunks
            }
          }
        } else {
          // keyword NUL, compression flag (must be 0), compression method, language NUL, translated keyword NUL
          p = dataStart + PNG_XMP_KEYWORD.length + 3;
          p = buffer.indexOf(0, p) + 1;
          p = buffer.indexOf(0, p) + 1;
          if (p > 0 && p < dataEnd && buffer[dataStart + PNG_XMP_KEYWORD.length + 1] === 0) {
            return {
              text: UTF8.decode(buffer.subarray(p, dataEnd)),
              kind: 'png',
              start: p,
              end: dataEnd,
              lengthAt: off,
              pngChunkStart: off,
              pngCrcAt: dataEnd,
            };
          }
        }
      }
      if (type === 'IEND') break;
      off += 12 + length;
    }
    return null;
  }
  if (buffer.length > 12 && bufferAt(buffer, 0).startsWith('RIFF') && bufferAt(buffer, 8).startsWith('WEBP')) {
    let off = 12;
    while (off + 8 <= buffer.length) {
      const size = view.getUint32(off + 4, true);
      const start = off + 8;
      if (size > buffer.length - start) break;
      if (bufferAt(buffer, off).startsWith('XMP ') && size > 0) {
        return { text: UTF8.decode(buffer.subarray(start, start + size)), kind: 'webp', start, end: start + size, lengthAt: off + 4, riffSizeAt: 4 };
      }
      off = start + size + (size % 2); // RIFF chunks are padded to even offsets
    }
  }
  return null;
}

/** Latin1 view for comparing container bytes against ASCII signatures. */
function bufferAt(buffer: Uint8Array, offset: number): string {
  return Buffer.from(buffer.buffer, buffer.byteOffset + offset, Math.min(64, buffer.length - offset)).toString('latin1');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Replaces the packet at `loc` with `nextText`, updating only the container
 * length/CRC fields that cover it. Everything else is copied verbatim.
 */
export function writeXmpPacket(buffer: Uint8Array, loc: XmpLocation, nextText: string): Uint8Array {
  const next = Buffer.from(nextText, 'utf-8');
  const delta = next.length - (loc.end - loc.start);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (loc.kind === 'png') {
    const chunkStart = loc.pngChunkStart!;
    // Compressed packets (zTXt, written by sharp) are re-deflated; the
    // compressed length replaces the plain-text delta.
    const payload = loc.pngCompressed ? deflateSync(nextText) : next;
    const chunkLength = view.getUint32(loc.lengthAt) + payload.length - (loc.end - loc.start);
    const chunk = new Uint8Array(12 + chunkLength);
    new DataView(chunk.buffer).setUint32(0, chunkLength);
    chunk.set(buffer.subarray(chunkStart + 4, chunkStart + 8), 4); // chunk type (iTXt/zTXt)
    const prefixLength = loc.start - chunkStart - 8;
    chunk.set(buffer.subarray(chunkStart + 8, loc.start), 8);
    chunk.set(payload, 8 + prefixLength);
    new DataView(chunk.buffer).setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
    const oldChunkBytes = loc.pngCrcAt! + 4 - chunkStart; // header + data + CRC
    const out = new Uint8Array(buffer.length + 12 + chunkLength - oldChunkBytes);
    out.set(buffer.subarray(0, chunkStart), 0);
    out.set(chunk, chunkStart);
    out.set(buffer.subarray(loc.pngCrcAt! + 4), chunkStart + chunk.length);
    return out;
  }
  if (loc.kind === 'jpeg') {
    // <marker><length><XMP signature><packet>… — only the packet bytes and
    // the segment length change; the signature is copied verbatim.
    const segLength = view.getUint16(loc.lengthAt) + delta;
    const out = new Uint8Array(buffer.length + delta);
    out.set(buffer.subarray(0, loc.lengthAt), 0);
    out[loc.lengthAt] = segLength >> 8;
    out[loc.lengthAt + 1] = segLength & 0xff;
    out.set(buffer.subarray(loc.lengthAt + 2, loc.start), loc.lengthAt + 2);
    out.set(next, loc.start);
    out.set(buffer.subarray(loc.end), loc.start + next.length);
    return out;
  }
  // WebP: XMP chunk data; odd sizes are padded with a trailing zero byte.
  const pad = next.length % 2;
  const out = new Uint8Array(buffer.length + delta + pad);
  out.set(buffer.subarray(0, loc.lengthAt), 0);
  new DataView(out.buffer).setUint32(loc.lengthAt, next.length, true);
  out.set(next, loc.lengthAt + 4);
  if (pad) out[loc.lengthAt + 4 + next.length] = 0;
  out.set(buffer.subarray(loc.end), loc.lengthAt + 4 + next.length + pad);
  new DataView(out.buffer).setUint32(loc.riffSizeAt!, out.length - 8, true);
  return out;
}

// --- packet parsing (namespace-aware, entity-decoding) --------------------

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the five predefined XML entities plus numeric character references. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/** prefix → namespace URI declarations of the packet. */
function declaredNamespaces(packet: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of packet.matchAll(/xmlns:([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) map.set(m[1], m[2]);
  return map;
}

/** Every prefix bound to `nsUri` in the packet. */
function prefixesFor(packet: string, nsUri: string): string[] {
  return [...declaredNamespaces(packet)].filter(([, uri]) => uri === nsUri).map(([prefix]) => prefix);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Simple element text `<p:local>value</p:local>` (or attribute on rdf:Description) for any prefix of `nsUri`. */
function field(packet: string, nsUri: string, local: string): string | undefined {
  for (const prefix of prefixesFor(packet, nsUri)) {
    const p = escapeRegExp(prefix);
    const element = packet.match(new RegExp(`<${p}:${local}(?:\\s[^>]*)?>([^<]*)</${p}:${local}>`));
    if (element) return decodeEntities(element[1]);
    const attribute = packet.match(new RegExp(`(?:^|\\s)${p}:${local}="([^"]*)"`));
    if (attribute) return decodeEntities(attribute[1]);
  }
  return undefined;
}

/** `x-default` item of a language-alternative element (`<rdf:Alt><rdf:li>`). */
function altField(packet: string, nsUri: string, local: string): string | undefined {
  for (const prefix of prefixesFor(packet, nsUri)) {
    const p = escapeRegExp(prefix);
    const element = packet.match(new RegExp(`<${p}:${local}(?:\\s[^>]*)?>\\s*<rdf:Alt>\\s*<rdf:li[^>]*>([^<]*)</rdf:li>`));
    if (element) return decodeEntities(element[1]);
  }
  return undefined;
}

/**
 * The packet's `DigitalSourceType`, whatever prefix carries the IPTC
 * namespace. Undefined when the packet states none.
 */
export function packetDigitalSourceType(packet: string): string | undefined {
  return field(packet, IPTC_EXT_NS, 'DigitalSourceType');
}

/**
 * AI credentials from the image's XMP, or null when it declares none.
 * Accepts the IPTC field and the legacy `sus:AIGenerated` flag; only AI
 * source types qualify (a `digitalCapture` photo declares nothing).
 */
export async function readXmpCredentials(buffer: Uint8Array): Promise<XmpCredentials | null> {
  let packet: string | null = findXmpPacket(buffer)?.text ?? null;
  if (packet === null) {
    // Containers we do not splice (e.g. compressed PNG zTXt) — sharp decodes.
    try {
      const raw = await sharp(buffer).metadata();
      packet = raw.xmp ? UTF8.decode(raw.xmp) : null;
    } catch {
      return null;
    }
  }
  if (packet === null) return null;

  const digitalSourceType =
    packetDigitalSourceType(packet) ??
    (packet.includes(`<sus:AIGenerated>True</sus:AIGenerated>`) ? TRAINED_ALGORITHMIC_MEDIA : undefined);
  if (!digitalSourceType || !isAiSourceType(digitalSourceType)) return null;
  return {
    digitalSourceType,
    creator: field(packet, IPTC_EXT_NS, 'AISystemUsed') ?? field(packet, XAP_NS, 'CreatorTool'),
    createdAt: field(packet, `https://${SUS_NS_HOST}/ns/ai/1.0/`, 'GenerationDate'),
    description: altField(packet, DC_NS, 'description'),
    rights: altField(packet, DC_NS, 'rights'),
  };
}

// --- packet editing (preserves every existing field) ----------------------

export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Sets `<…:local>value</…:local>` in the packet under the IPTC extension
 * namespace: replaces the existing element/attribute value, inserts into the
 * `rdf:Description` that already declares the namespace, or appends a new
 * description. Every other byte of the packet is preserved.
 */
function setIptcField(packet: string, local: string, escapedValue: string): string {
  const prefixes = prefixesFor(packet, IPTC_EXT_NS);
  for (const prefix of prefixes) {
    const p = escapeRegExp(prefix);
    const element = new RegExp(`(<${p}:${local}(?:\\s[^>]*)?>)[^<]*(</${p}:${local}>)`);
    if (element.test(packet)) return packet.replace(element, `$1${escapedValue}$2`);
    const attribute = new RegExp(`((?:^|\\s)${p}:${local}=")[^"]*(")`);
    if (attribute.test(packet)) return packet.replace(attribute, `$1${escapedValue}$2`);
  }
  const elementTag = (prefix: string) => `<${prefix}:${local}>${escapedValue}</${prefix}:${local}>`;
  if (prefixes.length > 0) {
    const prefix = escapeRegExp(prefixes[0]);
    // Insert after the start tag of the description that declares the namespace.
    const description = packet.match(new RegExp(`<rdf:Description[^>]*xmlns:${prefix}=`, 's'));
    if (description?.index !== undefined) {
      const at = packet.indexOf('>', description.index) + 1;
      return packet.slice(0, at) + elementTag(prefixes[0]) + packet.slice(at);
    }
  }
  const description = `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="${IPTC_EXT_NS}">${elementTag('Iptc4xmpExt')}</rdf:Description>`;
  const beforeRdfEnd = packet.lastIndexOf('</rdf:RDF>');
  return beforeRdfEnd === -1 ? packet : packet.slice(0, beforeRdfEnd) + description + packet.slice(beforeRdfEnd);
}

/**
 * Ensures the packet states `value` as its IPTC `DigitalSourceType`,
 * preserving all other fields. Returns the packet unchanged when it already
 * carries that value.
 */
export function ensureDigitalSourceType(packet: string, value: string): string {
  if (packetDigitalSourceType(packet) === value) return packet;
  return setIptcField(packet, 'DigitalSourceType', escapeXml(value));
}

export interface TagOptions {
  /** Generating system, e.g. `Google Gemini Nano Banana Pro`. Written to `Iptc4xmpExt:AISystemUsed`. */
  system?: string;
  description?: string;
  rights?: string;
  /** IPTC digital source type; defaults to `trainedAlgorithmicMedia`. */
  digitalSourceType?: string;
}

export type TagResult = 'tagged' | 'already-tagged' | 'skipped-c2pa';

/**
 * Write the AI disclosure into the image's XMP. Idempotent and
 * pixel-preserving; existing XMP fields — including ones this library never
 * reads — are kept and merged, because the packet is edited in place instead
 * of being re-serialised from a model.
 *
 * Files with a C2PA manifest are never rewritten: any byte change breaks the
 * signed hash. Their source type reaches the derivatives through the image
 * service instead.
 */
export function tagAiImage(buffer: Uint8Array, options: TagOptions = {}): { result: TagResult; buffer: Uint8Array } {
  if (hasC2paManifest(buffer)) return { result: 'skipped-c2pa', buffer };
  const digitalSourceType = options.digitalSourceType ?? TRAINED_ALGORITHMIC_MEDIA;

  const loc = findXmpPacket(buffer);
  if (loc) {
    if (packetDigitalSourceType(loc.text) === digitalSourceType) return { result: 'already-tagged', buffer };
    let packet = ensureDigitalSourceType(loc.text, digitalSourceType);
    if (options.system && !field(packet, IPTC_EXT_NS, 'AISystemUsed') && !field(packet, XAP_NS, 'CreatorTool')) {
      packet = setIptcField(packet, 'AISystemUsed', escapeXml(options.system));
    }
    return { result: 'tagged', buffer: writeXmpPacket(buffer, loc, packet) };
  }

  // No packet yet: nothing to preserve, let aeo-image build one from scratch.
  const existing = readMetadata(buffer);
  const output = writeMetadata(buffer, {
    ...existing,
    digitalSourceType,
    description: existing.description ?? options.description,
    rights: existing.rights ?? options.rights,
    ai: { ...existing.ai, system: existing.ai?.system ?? options.system },
  });
  return { result: 'tagged', buffer: output };
}
