# components/ — visible badge

Shipped in the package; imported by consuming Astro projects.

## Files

- `AiBadge.astro` — "AI" badge + content-credentials popover for one
  image. Renders nothing when `credentials` is null (a real photo can
  never be labelled AI by accident). Self-contained: inline toggle
  script, no runtime dependency. All copy via `labels` prop (i18n stays
  in the consuming project); styling reads `--ai-badge-*` custom
  properties with neutral fallbacks. Place inside a
  `position: relative` wrapper around the image.

## Rules

- Types come from `@jehu/astro-ai-disclosure/credentials`; keep the
  import surface stable.
- No framework dependencies (no Alpine/React); vanilla only.

## Child DOX Index

No nested DOX files; this directory is flat.
