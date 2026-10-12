#!/usr/bin/env node
// CLI: write or verify the AI disclosure in source images.
//
//   astro-ai-disclosure tag <file>... [--json allowlist.json] [--system "…"] [--rights "…"] [--description "…"]
//   astro-ai-disclosure check <file|dir>...
//
// Safety: `tag` NEVER walks directories — it only touches explicitly named
// image files (or files listed in an explicit JSON allowlist array), so a
// directory of real photos can never be auto-marked as AI-generated.
// `check` is read-only and may recurse into explicitly named directories.
// `tag` is idempotent and byte-preserving; C2PA-signed files are skipped.
// `check` exits 1 when a file carries no AI credentials (XMP or C2PA).

import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { readAiCredentialsFromBuffer } from './credentials.js';
import { tagAiImage } from './xmp.js';

const IMAGE_RE = /\.(jpe?g|png|webp|avif)$/i;

const USAGE = [
  'Usage:',
  '  astro-ai-disclosure tag <file>... [--json allowlist.json] [--system "…"] [--rights "…"] [--description "…"]',
  '  astro-ai-disclosure check <file|dir>...',
  '',
  'tag only touches explicitly named image files (or paths listed in the JSON',
  'array given via --json); directories are rejected. check is read-only and',
  'walks directories recursively for .jpg/.jpeg/.png/.webp/.avif.',
].join('\n');

/** Read-only recursive walk for `check`; explicit files pass through unchanged. */
async function collectForCheck(targets: string[]): Promise<string[]> {
  const files: string[] = [];
  const walk = async (entry: string) => {
    const info = await stat(entry);
    if (info.isDirectory()) {
      for (const child of await readdir(entry)) await walk(path.join(entry, child));
    } else if (IMAGE_RE.test(entry)) {
      files.push(entry);
    }
  };
  for (const target of targets) await walk(target);
  return files.sort();
}

/** Explicit targets for `tag`: existing image files only, never directories. */
async function collectForTag(targets: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const target of targets) {
    const info = await stat(target);
    if (info.isDirectory()) {
      throw new Error(
        `refusing to tag directory "${target}": tag explicit image files, or pass --json with an explicit allowlist`,
      );
    }
    if (!IMAGE_RE.test(target)) throw new Error(`not an image file: "${target}"`);
    files.push(target);
  }
  return files;
}

/** Parse a JSON allowlist (an array of image file paths) for `tag --json`. */
async function readAllowlist(jsonPath: string): Promise<string[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(jsonPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read --json allowlist "${jsonPath}": ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error(`--json allowlist "${jsonPath}" must be an array of file path strings`);
  }
  if (parsed.length === 0) throw new Error(`--json allowlist "${jsonPath}" is empty`);
  return collectForTag(parsed as string[]);
}

interface Args {
  command: string;
  targets: string[];
  options: Record<string, string>;
}

const KNOWN_FLAGS: Record<string, true> = { system: true, rights: true, description: true, json: true };

function parseArgs(argv: string[]): Args {
  const [command, ...rest] = argv;
  const targets: string[] = [];
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (!KNOWN_FLAGS[key]) throw new Error(`unknown flag: --${key}`);
      const value = rest[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`);
      options[key] = value;
    } else {
      targets.push(arg);
    }
  }
  return { command: command ?? '', targets, options };
}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  const { command, targets, options } = args;
  const valid = command === 'tag' || command === 'check';
  if (!valid || (targets.length === 0 && !options.json)) {
    console.error(USAGE);
    process.exit(2);
  }
  if (command === 'check' && options.json !== undefined) {
    console.error(`--json is only valid with tag\n\n${USAGE}`);
    process.exit(2);
  }

  let files: string[];
  if (command === 'tag') {
    try {
      const allowed = options.json ? await readAllowlist(options.json) : [];
      files = [...new Set([...(await collectForTag(targets)), ...allowed])].sort();
    } catch (error) {
      console.error((error as Error).message);
      process.exit(2);
    }
  } else {
    files = await collectForCheck(targets);
  }
  if (files.length === 0) {
    console.error(`no image files matched (command: ${command})`);
    process.exit(1);
  }

  const counts: Record<string, number> = {};
  let failed = false;

  for (const file of files) {
    const buffer = await readFile(file);
    if (command === 'tag') {
      const { result, buffer: output } = tagAiImage(buffer, {
        system: options.system,
        rights: options.rights,
        description: options.description,
      });
      if (result === 'tagged') await writeFile(file, output);
      counts[result] = (counts[result] ?? 0) + 1;
      console.log(`${result.padEnd(14)} ${file}`);
    } else {
      const credentials = await readAiCredentialsFromBuffer(buffer);
      const result = credentials ? `ok (${credentials.provenance})` : 'MISSING';
      if (!credentials) failed = true;
      counts[result] = (counts[result] ?? 0) + 1;
      console.log(`${result.padEnd(14)} ${file}`);
    }
  }
  console.log(
    Object.entries(counts)
      .map(([key, n]) => `${key}: ${n}`)
      .join('   '),
  );
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
