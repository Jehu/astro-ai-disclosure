# @jehu/astro-ai-disclosure

AI image disclosure for Astro: keep XMP through image optimisation, carry the
source type of C2PA images into derivatives, and show a credentials badge.

This is metadata disclosure, not a legal-compliance certification or a C2PA
signature verifier. A `DigitalSourceType` declaration describes the source;
it does not prove who generated the image.

## Install

Requires Node 22.12+, Astro 7 and Sharp 0.35.5+.

```bash
npm install github:Jehu/astro-ai-disclosure
```

Git installs build TypeScript via `prepare`. The package also has an exports
map for registry distribution; no GitHub Packages token is needed for the
public Git repository. Pin the Git commit in applications for reproducibility.

## Astro integration

```js
import aiDisclosure from '@jehu/astro-ai-disclosure';
import { defineConfig } from 'astro/config';

export default defineConfig({
  integrations: [aiDisclosure()],
});
```

The integration registers its local Sharp image service. It preserves source
EXIF/XMP/IPTC/ICC and writes the C2PA source type into derivative XMP. Optional
Sharp defaults go through `aiDisclosure({ sharp: { limitInputPixels: false } })`.
It refuses to replace a custom image service silently. Remote image services
are not supported; use the metadata API without the integration instead.

After changing the service, clear Astro's cached images before testing:

```bash
rm -rf node_modules/.astro/assets
npm run build
```

## Credentials in project components

Astro image imports expose a URL, not their source path. Keep the source glob
in your project, then pass it to the package:

```ts
// src/lib/ai-credentials.ts
import type { ImageMetadata } from 'astro';
import { createCredentialReader } from '@jehu/astro-ai-disclosure/credentials';

export const readAiCredentials = createCredentialReader(
  import.meta.glob<ImageMetadata>('/src/assets/images/**/*.{jpg,jpeg,png,webp,avif}', {
    eager: true,
    import: 'default',
  }),
);
```

Exclude backup directories explicitly if they live under the glob. Eager image
imports can cause unused originals to appear in the build output.

The reader returns `{ digitalSourceType, provenance, creator?, createdAt?,
description?, rights? }` or `null`. `provenance` is `xmp` or `c2pa`, **not** an
assertion that a signature was validated. Missing creation dates are left
absent, never substituted with signing or build time.

For a component with a declared AI/non-AI intent:

```ts
import { assertAiDisclosure } from '@jehu/astro-ai-disclosure/credentials';

assertAiDisclosure(
  slides.map((slide) => ({ label: slide.src.src, credentials: slide.credentials })),
  aiGenerated,
  'BeforeAfter',
);
```

This throws if an AI-declared image has no credentials or a real-photo-declared
image carries AI credentials. Render badges from credentials, not from the
intent flag.

## Visible badge

```astro
---
import AiBadge from '@jehu/astro-ai-disclosure/components/AiBadge.astro';
import { readAiCredentials } from '@/lib/ai-credentials';
import photo from '@/assets/images/example.jpg';
const credentials = await readAiCredentials(photo);
---

<div class="image-frame">
  <!-- Render your Image/Picture here. -->
  <AiBadge
    credentials={credentials}
    locale="de-DE"
    labels={{
      open: 'Inhaltsnachweise anzeigen',
      title: 'Inhaltsnachweise',
      close: 'Schließen',
      intro: 'KI-generierte Illustration, kein Foto einer echten Patientin.',
      createdWith: 'Erstellt mit',
      createdOn: 'Erstellt am',
      footer: 'Maschinenlesbare Herkunftsangabe im Bild eingebettet.',
    }}
  />
</div>

<style>
  .image-frame {
    position: relative;
    --ai-badge-font: system-ui, sans-serif;
    --ai-badge-title-font: serif;
    --ai-badge-text: #1f2320;
    --ai-badge-radius: 0.5rem;
    --ai-badge-offset: 0.5rem;
  }
</style>
```

The component renders nothing for `null`. Copy is supplied by the project,
so any i18n library works. A small bundled script handles opening, closing,
Escape and focus return; no Alpine/React runtime is needed. Only one badge's
popover is open at a time.

## Source tagging CLI

Tag only images you know are generated. A directory is deliberately **not**
accepted by `tag`; it could contain real photos.

```bash
npx astro-ai-disclosure tag image.png --system "Google Gemini" --description "AI illustration"
npx astro-ai-disclosure tag --json ai-images.json --system "Google Gemini"
npx astro-ai-disclosure check image.png
npx astro-ai-disclosure check src/assets/ai
```

`ai-images.json` is an explicit JSON array of image file paths. The CLI accepts
JPEG, PNG, WebP and AVIF. `tag` skips signed C2PA files; any byte change could
invalidate their signature. `check` is read-only, recursively inspects an
explicit directory, and exits nonzero for missing disclosure or no matched
images. Unknown options fail instead of being ignored.

## C2PA sources

Resizing changes the bytes signed by the original generator. Copying the
original manifest to a resized image would not preserve a valid signature.
The service therefore leaves source files untouched and re-emits only the
manifest's source-type declaration as IPTC XMP in derivatives. It does not
sign derivatives or claim a cryptographic provenance chain.

Verified against OpenAI GPT-4o/gpt-image and Google Generative AI manifests.
OpenAI commonly states a model and creation date; Google may state only the
service name. A source without those fields still carries the source type.
Use `c2patool <source>` to validate signatures separately.

## Development

```bash
npm ci
npm test
npm pack --dry-run
```

Tests include small synthetic images containing real manifest bytes. Their
signatures are intentionally invalid because the pixels are synthetic; they
exercise parsing and transformations, not cryptographic trust.
