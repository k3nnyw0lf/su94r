// Builds the package for the Chrome Web Store and Microsoft Edge Add-ons: the extension without
// its fixed key (each store gives its own ID), without the folder-install helpers (Windows
// PowerShell scripts, release tools, build.json), zipped with the files at the top.
//
//   node tools/store.mjs <out folder>        → <out>/su94r-mini-store-<version>.zip
//
// The zip is made with Windows' own tar.exe (Git Bash's tar writes a plain tar even for .zip).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || '.');
const SKIP = new Set(['build.json', 'tools', '.git', 'node_modules', 'pin-helper', 'setup-this-pc.ps1']);

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const { key: _key, ...store } = manifest;
if (store.description.length > 132) throw new Error(`description is ${store.description.length} characters; the stores allow 132`);
if (store.name.length > 75) throw new Error(`name is ${store.name.length} characters; the stores allow 75`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'su94r-store-'));
const copy = (dir) => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(d.name)) continue;
    const from = path.join(dir, d.name);
    const to = path.join(stage, path.relative(ROOT, from));
    if (d.isDirectory()) { fs.mkdirSync(to, { recursive: true }); copy(from); } else fs.copyFileSync(from, to);
  }
};
copy(ROOT);
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(store, null, 2) + '\n');

fs.mkdirSync(OUT, { recursive: true });
const zip = path.join(OUT, `su94r-mini-store-${store.version}.zip`);
fs.rmSync(zip, { force: true });
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'zip';
if (process.platform === 'win32') execFileSync(tar, ['-a', '-c', '-f', zip, '*'], { cwd: stage, shell: false });
else execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: stage });
const count = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, d) => n + (d.isDirectory() ? count(path.join(dir, d.name)) : 1), 0);
console.log(`${zip}: ${count(stage)} files, version ${store.version}, no key`);
console.log(`unpacked copy for testing: ${stage}`);
