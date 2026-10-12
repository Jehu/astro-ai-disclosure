// Minimal reader for the parts of a C2PA manifest we use.
//
// AI image sources from OpenAI (gpt-image / GPT-4o) and Google Generative AI
// arrive with a signed C2PA manifest (JUMBF box: PNG `caBX` chunk, JPEG APP11)
// instead of XMP. The manifest store is walked structurally (JUMBF boxes),
// and only the small `c2pa.actions` assertion is CBOR-decoded (cbor-x); the
// signature box is never touched. This does NOT validate the signature —
// use `c2patool <file>` for that.
//
// Actions are read from the ACTIVE manifest only — per the C2PA spec the
// last manifest of the JUMBF manifest store (verified against c2pa-rs
// `Store::insert_restored_claim`, which overwrites in store order, and
// c2patool's `active_manifest` on a real 11-manifest Google file); source
// types of other embedded manifests never leak in. Within the active
// manifest the last action that states a source type describes the pixels
// as delivered.
import { Decoder } from 'cbor-x';

export const IPTC_DIGITAL_SOURCE_TYPE_PREFIX = 'http://cv.iptc.org/newscodes/digitalsourcetype/';


/**
 * True for IPTC digital source types that denote AI involvement
 * (`trainedAlgorithmicMedia`, `compositeWithTrainedAlgorithmicMedia`, …).
 * `digitalCapture` and plain `composite` are not AI statements by themselves.
 */
export function isAiSourceType(value: string): boolean {
  const local = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('#')) + 1);
  return local.includes('AlgorithmicMedia');
}

export interface C2paInfo {
  /** IPTC digital source type of the delivered pixels, e.g. `…/trainedAlgorithmicMedia`. */
  digitalSourceType: string;
  /** Generating model or service, e.g. `GPT-4o` or `Google Generative AI`. */
  creator?: string;
  /** ISO timestamp of the `c2pa.created` action, when the manifest states one. */
  createdAt?: string;
}

/** A JUMBF box: 4-byte big-endian length (includes the header) + 4-byte type. */
interface Box {
  type: string;
  /** Offset of the box header. */
  start: number;
  /** Offset of the first payload byte. */
  body: number;
  /** Offset just past the box. */
  end: number;
}

/** A JUMBF content unit: a `jumb` superbox made of a `jumd` description plus content boxes. */
interface Unit extends Box {
  /** Raw bytes of the description box payload, used for label matching. */
  label: string;
}

const MAX_CBOR_BYTES = 2 * 1024 * 1024;

/**
 * Concatenated JUMBF byte streams of the image: one per PNG `caBX` chunk, or
 * the reassembled payload of all JPEG APP11 segments (`JP` + instance +
 * sequence header stripped). Empty when the image carries no JUMBF.
 */
function jumbfStreams(buffer: Uint8Array): Uint8Array[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const streams: Uint8Array[] = [];
  const isPng =
    buffer.length > 8 &&
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  if (isPng) {
    let off = 8;
    while (off + 12 <= buffer.length) {
      const length = view.getUint32(off);
      const type = String.fromCharCode(buffer[off + 4], buffer[off + 5], buffer[off + 6], buffer[off + 7]);
      if (length > buffer.length - off - 12) break; // malformed chunk table: stop
      if (type === 'caBX') streams.push(buffer.subarray(off + 8, off + 8 + length));
      if (type === 'IEND') break;
      off += 12 + length;
    }
    return streams;
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    const parts: Uint8Array[] = [];
    let off = 2;
    while (off + 4 <= buffer.length && buffer[off] === 0xff) {
      const marker = buffer[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      if (marker === 0xda) break; // start of scan: no further markers with metadata
      const length = view.getUint16(off + 2);
      if (length < 2 || off + 2 + length > buffer.length) break;
      // APP11 C2PA: "JP" + 2-byte instance + 4-byte sequence, then JUMBF bytes.
      // Continuation fragments may repeat the 8-byte JUMBF box header of the
      // first fragment (as Google's writer does); strip the duplicate.
      if (marker === 0xeb && length > 10 && buffer[off + 4] === 0x4a && buffer[off + 5] === 0x50) {
        const payload = buffer.subarray(off + 12, off + 2 + length);
        const header = parts[0]?.subarray(0, 8);
        const repeatsHeader =
          header !== undefined && payload.length >= 8 && payload[0] === header[0] && payload[1] === header[1] && payload.subarray(4, 8).every((byte, i) => byte === header[4 + i]);
        parts.push(repeatsHeader ? payload.subarray(8) : payload);
      }
      off += 2 + length;
    }
    if (parts.length) streams.push(concat(parts));
  }
  return streams;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Boxes between `start` and `until`, stopping at the first malformed length. */
function* boxes(b: Uint8Array, start: number, until: number): Generator<Box> {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = start;
  while (off + 8 <= until) {
    const length = view.getUint32(off);
    const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
    if (length < 8 || off + length > until) return;
    yield { type, start: off, body: off + 8, end: off + length };
    off += length;
  }
}

/**
 * All JUMBF content units reachable from `start` (depth-first, store order):
 * every `jumb` superbox whose first child is a `jumd` description box. The
 * description payload bytes double as the label — they contain the C2PA URN
 * or assertion name (`urn:c2pa:…`, `c2pa.assertions`, `c2pa.actions.v2`, …).
 */
function* units(b: Uint8Array, start: number, until: number): Generator<Unit> {
  for (const box of boxes(b, start, until)) {
    if (box.type !== 'jumb') continue;
    let contentStart = box.body;
    const first = boxes(b, box.body, box.end).next();
    if (!first.done && first.value.type === 'jumd') {
      const d = first.value;
      const labelBytes = b.subarray(d.body, d.end);
      contentStart = d.end;
      yield { ...box, body: contentStart, label: Buffer.from(labelBytes).toString('latin1') };
    }
    yield* units(b, contentStart, box.end);
  }
}

/** First `cbor` content box between `start` and `until`, or null. */
function findCbor(b: Uint8Array, start: number, until: number): Uint8Array | null {
  for (const box of boxes(b, start, until)) {
    if (box.type === 'cbor') return b.subarray(box.body, box.end);
    if (box.type === 'jumb') {
      const nested = findCbor(b, box.body, box.end);
      if (nested) return nested;
    }
  }
  return null;
}

/** True if the buffer carries a C2PA JUMBF store (signed content credential). */
export function hasC2paManifest(buffer: Uint8Array): boolean {
  for (const stream of jumbfStreams(buffer)) {
    if (Buffer.from(stream).toString('latin1').includes('c2pa')) return true;
  }
  return false;
}

function isoWhen(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return undefined;
}
function agentName(agent: unknown): string | undefined {
  if (typeof agent === 'string') return agent || undefined;
  if (agent !== null && typeof agent === 'object' && 'name' in agent) {
    const name = agent.name;
    if (typeof name === 'string') return name || undefined;
  }
  return undefined;
}

/**
 * The active manifest: the LAST manifest among the top-level children of the
 * JUMBF store (C2PA spec 2.3.7; c2pa-rs overwrites its provenance label in
 * store order, so the final one wins). Nested ingredient manifests inside
 * assertion stores are never considered.
 */
function activeManifest(stream: Uint8Array): Unit | null {
  for (const store of boxes(stream, 0, stream.length)) {
    if (store.type !== 'jumb') continue;
    let last: Unit | null = null;
    for (const child of boxes(stream, store.body, store.end)) {
      if (child.type !== 'jumb') continue;
      const description = boxes(stream, child.body, child.end).next();
      if (description.done || description.value.type !== 'jumd') continue;
      const label = Buffer.from(stream.subarray(description.value.body, description.value.end)).toString('latin1');
      if (label.includes('urn:c2pa')) last = { ...child, body: description.value.end, label };
    }
    if (last) return last;
  }
  return null;
}
/**
 * Parses the active C2PA manifest of an image buffer, or returns null when the
 * buffer carries none or the manifest states no digital source type. The
 * active manifest is the LAST manifest in the store's top-level list.
 *
 * The returned source type is whatever the manifest declares — including
 * non-AI types like `composite` or `digitalCapture`; qualifying it as an AI
 * statement is the caller's job (`isAiSourceType`).
 */
export function readC2paManifest(buffer: Uint8Array): C2paInfo | null {
  for (const stream of jumbfStreams(buffer)) {
    const info = readStream(stream);
    if (info) return info;
  }
  return null;
}

function readStream(stream: Uint8Array): C2paInfo | null {
  const manifest = activeManifest(stream);
  if (!manifest) return null;
  const assertions = first(stream, manifest.body, manifest.end, (label) => label.includes('c2pa.assertions'));
  if (!assertions) return null;
  const actions = first(stream, assertions.body, assertions.end, (label) => label.includes('c2pa.actions'));
  if (!actions) return null;
  const payload = findCbor(stream, actions.body, actions.end);
  if (!payload || payload.length === 0 || payload.length > MAX_CBOR_BYTES) return null;

  let decoded: unknown;
  try {
    decoded = new Decoder({ mapsAsObjects: true }).decode(Buffer.from(payload));
  } catch {
    return null;
  }
  const actionList = actionArrayOf(decoded);
  if (!actionList) return null;

  let digitalSourceType: string | undefined;
  for (const action of actionList) {
    const type = digitalSourceTypeOf(action);
    if (type?.startsWith(IPTC_DIGITAL_SOURCE_TYPE_PREFIX)) digitalSourceType = type;
  }
  if (!digitalSourceType) return null;

  const info: C2paInfo = { digitalSourceType };
  const created = actionList.find((a) => a.action === 'c2pa.created');
  if (created) {
    // OpenAI: `softwareAgent: { name: "GPT-4o" }`; Google: free-text description.
    const description =
      typeof created.description === 'string' ? created.description.match(/^Created by (.+?)\.?$/)?.[1] : undefined;
    info.creator = agentName(created.softwareAgent) ?? description;
    info.createdAt = isoWhen(created.when);
  }
  return info;
}

function first(
  b: Uint8Array,
  start: number,
  until: number,
  matches: (label: string) => boolean,
): Unit | null {
  for (const unit of units(b, start, until)) {
    if (matches(unit.label)) return unit;
  }
  return null;
}

function actionArrayOf(decoded: unknown): Record<string, unknown>[] | null {
  const container =
    decoded instanceof Map ? decoded.get('actions') : (decoded as Record<string, unknown> | null)?.actions;
  if (!Array.isArray(container)) return null;
  return container.filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null);
}

function digitalSourceTypeOf(action: Record<string, unknown>): string | undefined {
  const value = action.digitalSourceType;
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const name = (value as Record<string, unknown>).name ?? (value as Record<string, unknown>).value;
    if (typeof name === 'string') return name;
  }
  return undefined;
}
