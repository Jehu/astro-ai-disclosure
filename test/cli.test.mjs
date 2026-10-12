import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, mkdir, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const run = promisify(execFile);
const cli = new URL('../dist/cli.js', import.meta.url).pathname;
const fixturesDir = new URL('./fixtures', import.meta.url).pathname;
const fixturePath = (name) => path.join(fixturesDir, name);

async function tmp() {
  return mkdtemp(path.join(tmpdir(), 'ai-disclosure-cli-'));
}

/** Copy a fixture into a fresh temp dir; returns the new file path. */
async function fixtureCopy(name) {
  const dir = await tmp();
  const file = path.join(dir, name);
  await copyFile(fixturePath(name), file);
  return file;
}

test('tag marks an explicit file, is idempotent, and skips C2PA-signed files', async () => {
  const file = await fixtureCopy('plain.png');
  const first = await run('node', [cli, 'tag', file, '--system', 'Test Gen']);
  assert.match(first.stdout, /tagged/);
  const second = await run('node', [cli, 'tag', file]);
  assert.match(second.stdout, /already-tagged/);

  const signed = await fixtureCopy('c2pa-openai.png');
  const before = await readFile(signed);
  const result = await run('node', [cli, 'tag', signed]);
  assert.match(result.stdout, /skipped-c2pa/);
  assert.deepEqual(await readFile(signed), before, 'C2PA file must stay byte-identical');
});

test('tag refuses directories and never infers AI from filenames', async () => {
  const dir = await tmp();
  await copyFile(fixturePath('plain.jpg'), path.join(dir, 'photo.jpg'));
  await assert.rejects(run('node', [cli, 'tag', dir]), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /refusing to tag directory/);
    return true;
  });
  const after = await readFile(path.join(dir, 'photo.jpg'));
  assert.deepEqual(after, readFileSync(fixturePath('plain.jpg')), 'directory photo must stay byte-identical');
});

test('tag accepts an explicit JSON allowlist of files', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'plain.png');
  await copyFile(fixturePath('plain.png'), file);
  const allowlist = path.join(dir, 'allow.json');
  await writeFile(allowlist, JSON.stringify([file]));

  const result = await run('node', [cli, 'tag', '--json', allowlist]);
  assert.match(result.stdout, /tagged/);
  const check = await run('node', [cli, 'check', file]);
  assert.match(check.stdout, /ok \(xmp\)/);
});

test('tag rejects malformed, empty, or directory-containing JSON allowlists', async () => {
  const dir = await tmp();
  const notArray = path.join(dir, 'a.json');
  await writeFile(notArray, '"nope"');
  const empty = path.join(dir, 'b.json');
  await writeFile(empty, '[]');
  const dirEntry = path.join(dir, 'c.json');
  await writeFile(dirEntry, JSON.stringify([dir]));
  const sub = path.join(dir, 'subdir');
  await mkdir(sub);

  for (const [jsonPath, message] of [
    [notArray, /must be an array of file path strings/],
    [empty, /allowlist .* is empty/],
    [dirEntry, /refusing to tag directory/],
  ]) {
    await assert.rejects(run('node', [cli, 'tag', '--json', jsonPath]), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, message);
      return true;
    });
  }
  await assert.rejects(run('node', [cli, 'tag', sub]), /refusing to tag directory/);
});

test('tag rejects non-image explicit files', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'notes.txt');
  await writeFile(file, 'hello');
  await assert.rejects(run('node', [cli, 'tag', file]), (error) => {
    assert.equal(error.code, 2);
    assert.match(error.stderr, /not an image file/);
    return true;
  });
});

test('check walks explicit directories recursively and fails on missing credentials', async () => {
  await assert.rejects(run('node', [cli, 'check', fixturesDir]), (error) => {
    assert.equal(error.code, 1, 'plain fixtures have no credentials');
    assert.match(error.stdout, /ok \(c2pa\)/);
    assert.match(error.stdout, /ok \(xmp\)/);
    assert.match(error.stdout, /MISSING/);
    return true;
  });
});

test('check exits 1 when a single file has no AI credentials', async () => {
  const file = await fixtureCopy('plain.jpg');
  await assert.rejects(run('node', [cli, 'check', file]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /MISSING/);
    return true;
  });
});

test('unknown flags and missing flag values are rejected with exit 2', async () => {
  const file = await fixtureCopy('plain.png');
  for (const argv of [
    [cli, 'tag', file, '--verbose'],
    [cli, 'tag', file, '--system'],
    [cli, 'check', file, '--json'],
    [cli, 'frobnicate', file],
  ]) {
    await assert.rejects(run('node', argv), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Usage:|unknown flag|missing value/);
      return true;
    });
  }
});

test('zero matched files fails instead of succeeding', async () => {
  const dir = await tmp();
  await assert.rejects(run('node', [cli, 'check', dir]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /no image files matched/);
    return true;
  });
});
