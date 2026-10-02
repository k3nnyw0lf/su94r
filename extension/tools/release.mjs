// Prepares a release of the extension folder (and, optionally, the old copy that hands its
// data over), then writes build.json, which the self-updater checks before reloading.
//
//   node tools/release.mjs                                  write build.json for this folder
//   node tools/release.mjs --legacy <folder> --code-only    step 1: refresh the old copy's code
//   node tools/release.mjs --legacy <folder>                step 2: its manifest (and build.json)
//
// The old copy gets the same code with a manifest that has no key (so it keeps its old ID
// and its data) and allows only su94r Mini to ask it for that data. A version change in its
// manifest is what makes a running old copy reload, and copies older than 2.2 reload at
// once, without checking the other files. On other computers a synced folder copies files
// in any order, so run step 1, wait until the folder has synced everywhere (a few minutes),
// then run step 2.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['build.json', 'tools', '.git', 'node_modules']);
const NEW_ID = 'gcdoahfflgpabebcbhohaklfmpnnggpi';

function files(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    if (SKIP.has(d.name)) return [];
    const full = path.join(dir, d.name);
    return d.isDirectory() ? files(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function writeBuild(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const list = files(dir).sort();
  const build = { version: manifest.version, files: Object.fromEntries(list.map((f) => [f, sha(path.join(dir, f))])) };
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify(build, null, 1) + '\n');
  return build;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const legacyAt = process.argv.indexOf('--legacy');
if (legacyAt > 0) {
  const target = path.resolve(process.argv[legacyAt + 1]);
  const oldManifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
  if (oldManifest.key) throw new Error(`${target} has a key: that is not the old copy`);
  // Code first, manifest last.
  for (const f of files(ROOT)) {
    if (f === 'manifest.json') continue;
    const dest = path.join(target, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), dest);
  }
  if (process.argv.includes('--code-only')) {
    console.log(`old copy ${target}: code refreshed; run again without --code-only once it has synced`);
    process.exit(0);
  }
  const { key, short_name: _short, ...rest } = manifest;
  const legacy = {
    ...rest,
    name: 'Libre Mini Graph (now su94r Mini)',
    description: 'The old copy of su94r Mini. Load the su94r-mini folder; it brings this copy\'s data over and this one stops.',
    externally_connectable: { ids: [NEW_ID] },
  };
  legacy.action = { ...legacy.action, default_title: 'Libre Mini Graph (now su94r Mini)' };
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(legacy, null, 2) + '\n');
  // build.json last: until it matches the new manifest, an updating copy waits.
  const lb = writeBuild(target);
  console.log(`old copy ${target}: ${Object.keys(lb.files).length} files, version ${legacy.version}`);
}
const b = writeBuild(ROOT);
console.log(`su94r Mini ${ROOT}: ${Object.keys(b.files).length} files, version ${b.version}`);
