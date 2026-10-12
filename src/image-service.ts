// Astro image service that keeps metadata through optimisation and carries
// the AI disclosure of C2PA sources into every derivative.
//
// Astro's default Sharp service calls `.toBuffer()` without `.keepMetadata()`,
// so EXIF/XMP/IPTC/ICC are stripped and the AI disclosure is lost. There is
// no upstream config flag (withastro/roadmap#1251). This service reimplements
// `transform()` on top of the default service's URL/option handling.
//
// C2PA: Sharp drops the signed JUMBF box on every re-encode, and the
// credential's hash would not match resized bytes anyway. Sources with a
// manifest get its `digitalSourceType` re-emitted as plain XMP instead, so the
// disclosure stays machine-readable. An existing XMP packet is carried over
// whole (with the source type merged in) instead of being replaced by a bare
// one. Source files are never modified.

import type { ImageOutputFormat, LocalImageService } from 'astro';
import sharpService, { type SharpImageServiceConfig } from 'astro/assets/services/sharp';
import sharp from 'sharp';
import type { ResizeOptions } from 'sharp';
import { readC2paManifest } from './c2pa.js';
import { escapeXml, findXmpPacket, ensureDigitalSourceType, packetDigitalSourceType } from './xmp.js';

/** The fields of Astro's `LocalImageTransform` (`{ src; [key]: any }`) this service reads. */
interface TransformFields {
  format?: ImageOutputFormat;
  width?: number;
  height?: number;
  fit?: ResizeOptions['fit'];
  position?: ResizeOptions['position'];
  quality?: number;
}

function readTransform(options: Record<string, unknown>): TransformFields {
  const num = (value: unknown) => (typeof value === 'number' ? value : undefined);
  const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
  return {
    format: str(options.format),
    width: num(options.width),
    height: num(options.height),
    // Pass-through: Astro validated these upstream, sharp re-validates.
    fit: str(options.fit) as ResizeOptions['fit'],
    position: options.position as ResizeOptions['position'],
    quality: num(options.quality),
  };
}

const IPTC_EXT_NS = 'http://iptc.org/std/Iptc4xmpExt/2008-02-29/';

/** Minimal XMP packet carrying only the IPTC digital source type. */
function iptcXmp(digitalSourceType: string): string {
  return (
    '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="astro-ai-disclosure/1.0">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    `<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="${IPTC_EXT_NS}">` +
    `<Iptc4xmpExt:DigitalSourceType>${escapeXml(digitalSourceType)}</Iptc4xmpExt:DigitalSourceType>` +
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
  );
}

/**
 * The XMP to write for a C2PA source: its existing packet with the manifest's
 * source type merged in, or a fresh minimal packet when it has none. A packet
 * that already states a source type is passed through unchanged.
 */
function xmpForManifest(input: Uint8Array, digitalSourceType: string): string {
  const existing = findXmpPacket(input);
  if (!existing) return iptcXmp(digitalSourceType);
  if (packetDigitalSourceType(existing.text)) return existing.text;
  return ensureDigitalSourceType(existing.text, digitalSourceType);
}

const service: LocalImageService<SharpImageServiceConfig> = {
  ...sharpService,
  async transform(inputBuffer, transformOptions, config) {
    const t = readTransform(transformOptions);
    // SVG passthrough — sharp cannot preserve SVG-as-SVG; mirror the default service.
    if (t.format === 'svg') {
      return { data: inputBuffer, format: 'svg' };
    }

    const cfg = config.service.config ?? {};

    let pipeline = sharp(inputBuffer, { limitInputPixels: cfg.limitInputPixels }).keepMetadata();

    // Sources with XMP keep their packet via keepMetadata(). C2PA-only
    // sources have no XMP, so withXmp() overwrites nothing.
    const manifest = readC2paManifest(inputBuffer);
    if (manifest) {
      pipeline = pipeline.withXmp(xmpForManifest(inputBuffer, manifest.digitalSourceType));
    }

    if (t.width || t.height) {
      pipeline = pipeline.resize({
        width: t.width ? Math.round(t.width) : undefined,
        height: t.height ? Math.round(t.height) : undefined,
        kernel: cfg.kernel,
        fit: t.fit,
        position: t.position,
        withoutEnlargement: true,
      });
    }

    const format = t.format ?? 'webp';
    const quality = t.quality;
    switch (format) {
      case 'jpeg':
      case 'jpg':
        pipeline = pipeline.jpeg({ ...cfg.jpeg, ...(quality && { quality }) });
        break;
      case 'png':
        pipeline = pipeline.png({ ...cfg.png, ...(quality && { quality }) });
        break;
      case 'webp':
        pipeline = pipeline.webp({ ...cfg.webp, ...(quality && { quality }) });
        break;
      case 'avif':
        pipeline = pipeline.avif({ ...cfg.avif, ...(quality && { quality }) });
        break;
    }

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    // sharp reports the encoder name ('jpeg' | 'png' | 'webp' | 'avif'), all
    // valid ImageOutputFormat values; its Buffer is a Uint8Array, returned as-is.
    const outputFormat: ImageOutputFormat = info.format;
    return { data, format: outputFormat };
  },
};

export default service;
