# src/ — library core

Compiled to `dist/` (committed). Every public export changes consumer
APIs — check `test/` and the README before renaming.

## Files

- `xmp.ts` — XMP packet find/merge (`ensureDigitalSourceType`,
  `tagAiImage`, `readXmpCredentials`). Idempotent and byte-preserving;
  unknown XMP fields survive. `tagAiImage` options default
  `digitalSourceType` to `trainedAlgorithmicMedia`.
- `c2pa.ts` — minimal C2PA manifest reader (JUMBF walk + CBOR decode of
  the actions assertion only; signature never validated — `c2patool`
  does that). Active manifest = last in the store. `createdAt` falls
  back to the RFC 3161 signature timestamp (`sigTst2`) when the
  `c2pa.created` action has no `when`. `isAiSourceType` defines which
  IPTC types count as AI involvement.
- `credentials.ts` — build-time lookup behind `astro:assets` imports:
  XMP first, then C2PA. `null` = no AI credentials; callers must not
  render a badge then.
- `image-service.ts` — Sharp-based `LocalImageService` that re-emits the
  source's digital source type into derivatives; reuses an existing
  matching XMP packet instead of rewriting.
- `index.ts` — the Astro integration; registers the image service.
- `cli.ts` — `tag`/`check` commands. `tag` accepts only explicit files
  or a `--json` allowlist (never directories); flags `--source-type`
  (short name from `DIGITAL_SOURCE_TYPE` or full IPTC URI, unknown →
  exit 2), `--system`, `--rights`, `--description`. `check` may recurse,
  exits 1 on missing credentials.

## Rules

- New IPTC/C2PA knowledge belongs in `xmp.ts`/`c2pa.ts`; keep readers
  tolerant — real-world files vary (namespace prefixes, legacy packets).
- `DIGITAL_SOURCE_TYPE` comes from `aeo-image`; don't duplicate the enum
  locally.
- CLI errors follow the existing pattern: message + USAGE, exit 2 for
  usage errors, exit 1 for match/credential failures.

## Child DOX Index

No nested DOX files; this directory is flat.
