// Build-time credential lookup for the visible disclosure (badge + popover).
//
// Reads the source file behind an `astro:assets` image import and returns
// what it declares about AI generation: our/IPTC XMP first, then a C2PA
// manifest. null means "no AI credentials" — callers must not show a badge.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImageMetadata } from 'astro';
import { isAiSourceType, readC2paManifest } from './c2pa.js';
import { readXmpCredentials } from './xmp.js';

export interface AiCredentials {
  digitalSourceType: string;
  /** Where the disclosure was found. */
  provenance: 'xmp' | 'c2pa';
  creator?: string;
  /** ISO timestamp; absent when the source states none (e.g. Google C2PA). */
  createdAt?: string;
  description?: string;
  rights?: string;
}

/** Credentials from raw image bytes. */
export async function readAiCredentialsFromBuffer(buffer: Uint8Array): Promise<AiCredentials | null> {
  const xmp = await readXmpCredentials(buffer);
  if (xmp) return { ...xmp, provenance: 'xmp' };
  const c2pa = readC2paManifest(buffer);
  if (c2pa && isAiSourceType(c2pa.digitalSourceType)) return { ...c2pa, provenance: 'c2pa' };
  return null;
}

const cache = new Map<string, AiCredentials | null>();

/**
 * Credentials of the source file behind an image import.
 *
 * `astro:assets` only exposes the emitted URL (`/_astro/…` in builds,
 * `/@fs/…` in dev), not the source path, so the caller maps imports to files
 * with `import.meta.glob` — see `createCredentialReader()`.
 */
export async function readAiCredentialsFromFile(absolutePath: string): Promise<AiCredentials | null> {
  if (cache.has(absolutePath)) return cache.get(absolutePath) ?? null;
  const result = await readAiCredentialsFromBuffer(await readFile(absolutePath));
  cache.set(absolutePath, result);
  return result;
}

/**
 * Build a reader for the image imports of a project.
 *
 * ```ts
 * const read = createCredentialReader(
 *   import.meta.glob<ImageMetadata>('/src/assets/**\/*.{jpg,jpeg,png,webp,avif}', { eager: true, import: 'default' }),
 * );
 * const credentials = await read(importedImage);
 * ```
 *
 * The glob must be evaluated in project code: Vite resolves it at build time
 * relative to the project root, which a package cannot do on its own.
 */
export function createCredentialReader(
  modules: Record<string, ImageMetadata>,
  projectRoot: string = process.cwd(),
): (image: ImageMetadata) => Promise<AiCredentials | null> {
  const fileOf = new Map<ImageMetadata, string>();
  for (const [relative, image] of Object.entries(modules)) {
    fileOf.set(image, path.join(projectRoot, relative.replace(/^\//, '')));
  }
  return async (image) => {
    const file = fileOf.get(image);
    return file ? readAiCredentialsFromFile(file) : null;
  };
}

/**
 * Fails when a component's declared intent and the images disagree:
 * `aiGenerated` with an image lacking credentials (untagged AI image, or a
 * real photo about to be labelled AI), or `aiGenerated: false` with an image
 * that carries them (AI image about to ship without disclosure).
 */
export function assertAiDisclosure(
  entries: Array<{ label: string; credentials: AiCredentials | null }>,
  aiGenerated: boolean,
  component = 'component',
): void {
  for (const { label, credentials } of entries) {
    if (aiGenerated && !credentials) {
      throw new Error(
        `[${component}] ${label} is declared AI-generated but carries no AI credentials ` +
          `(no IPTC DigitalSourceType XMP, no C2PA manifest). Tag it with ` +
          `\`npx astro-ai-disclosure tag <file>\` or pass aiGenerated={false} for real photographs.`,
      );
    }
    if (!aiGenerated && credentials) {
      throw new Error(`[${component}] ${label} carries AI credentials but is marked aiGenerated={false}.`);
    }
  }
}

/** Human-readable date for the popover; undefined for missing or invalid input. */
export function formatCreatedAt(iso: string | undefined, locale = 'de-DE'): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}
