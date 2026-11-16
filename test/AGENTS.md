# test/ — suites and fixtures

Node test runner against `dist/` — run `npm run build` first. Fixtures
are binary ground truth; never regenerate them from the code under test.

## Files

- `disclosure.test.mjs` — XMP merge/idempotence/byte-preservation across
  formats, declared-intent matching.
- `cli.test.mjs` — CLI end to end via `node dist/cli.js`: explicit-file
  safety, `--json` allowlist validation, `--source-type` write + reject,
  exit codes.
- `c2pa-timestamp.test.mjs` — RFC 3161 `createdAt` fallback and
  `isoGeneralizedTime` parsing.
- `fixtures/` — synthetic images with known XMP (`xmp-legacy.jpg`,
  `xmp-varprefix.xml`), plain untagged files, and real C2PA manifests
  (OpenAI, Google, Google composite, timestamped). See `fixtures/README.md`.

## Rules

- New tests use temp-dir copies of fixtures (`mkdtemp`), never mutate
  fixtures in place.
- Assert observable behaviour (exit codes, XMP values, byte equality),
  not implementation details.
- A C2PA fixture byte-identical before/after a command is a hard
  invariant, keep asserting it.

## Child DOX Index

- `fixtures/README.md` documents fixtures; no nested AGENTS.md needed.
