# DOX framework
- DOX is highly performant AGENTS.md hierarchy installed here
- Agent must follow DOX instructions across any edits
Do not rely on memory. Re-read the applicable DOX chain in the current session before editing.
Every meaningful change requires a DOX pass before the task is done.
- AGENTS.md creation, deletion, move, rename, or index contents
Update parent docs when parent-level structure, ownership, workflow, or child index changes. Update child docs when parent changes alter local rules. Remove stale or contradictory text immediately. Small edits that do not change behavior or contracts may leave docs unchanged, but the DOX pass still must happen.
- Root AGENTS.md is the DOX rail: project-wide instructions, global preferences, durable workflow rules, and the top-level Child DOX Index
- Child AGENTS.md files own domain-specific instructions and their own Child DOX Index
- Child DOX Index
1. Re-check changed paths against the DOX chain
3. Refresh every affected Child DOX Index

## Project rail

`@jehu/astro-ai-disclosure` — Astro integration for AI-image disclosure.
Keeps IPTC XMP through Astro's image optimisation, carries C2PA source
types into derivatives, renders a visible badge. TypeScript, ESM-only,
single dependency: `aeo-image` (plus `cbor-x` for C2PA reading).

Durable rules:

- Never touch source images at build time; the service re-emits metadata
  into derivatives only. `tag` (CLI) never walks directories.
- C2PA-signed files are never byte-modified; the CLI skips them.
- `check` reports AI credentials only — a `digitalCapture` tag is not
  disclosure (`isAiSourceType` decides).
- `src/` is the source of truth; `dist/` is generated (`npm run build`)
  and committed for GitHub-pin consumption — never hand-edit.
- Tests run against `dist/`, so build before `npm test`.
- Release flow: feature branch → PR to `main` → consumers pin
  `github:Jehu/astro-ai-disclosure#<commit sha>`.
- No Airbender/issue tracker in this repo; work is tracked via GitHub PRs.

## Child DOX Index

- `src/AGENTS.md` — library core: XMP, C2PA reader, image service, integration, CLI
- `test/AGENTS.md` — test suites, fixtures contract, runner notes
- `components/AGENTS.md` — the visible badge component shipped in the package
