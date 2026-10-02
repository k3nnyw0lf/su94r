#!/usr/bin/env node
/**
 * Rasterises public/logo.svg into the PWA icons the manifest declares.
 *
 * The manifest referenced /icons/icon-192.png, icon-512.png and
 * icon-maskable.png long before any of them existed, so installing the PWA
 * produced a broken home-screen tile. This generates them.
 *
 * `sharp` is intentionally NOT a project dependency — icons change about once a
 * year and it is a heavy native module. Install it ad hoc:
 *
 *     npm i --no-save sharp && node scripts/build-icons.mjs
 *
 * Maskable note: Android applies its own mask (circle, squircle, …) and expects
 * the artwork to bleed to every edge, with meaningful content confined to the
 * central 80%. The rounded corners in logo.svg would be double-masked, so the
 * maskable variant squares them off. The trace already sits inside the safe
 * zone, so nothing needs rescaling.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const sharp = (await import('sharp')).default;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'public', 'logo.svg');
const OUT = join(ROOT, 'public', 'icons');

const render = (svg, size, file) =>
  sharp(Buffer.from(svg), { density: 512 })
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(join(OUT, file))
    .then(info => process.stdout.write(`  ${file.padEnd(20)} ${size}x${size}  ${(info.size / 1024).toFixed(1)} KB\n`));

const logo = await readFile(SRC, 'utf8');

// Square off the corners and let the background reach every edge.
const maskable = logo
  .replace(/<rect width="512" height="512" rx="112"/, '<rect width="512" height="512"')
  .replace('aria-label="su94r"', 'aria-label="su94r maskable"');

await mkdir(OUT, { recursive: true });

process.stdout.write('Building PWA icons from public/logo.svg\n');
await render(logo, 192, 'icon-192.png');
await render(logo, 512, 'icon-512.png');
await render(maskable, 512, 'icon-maskable.png');

// Apple ignores the manifest and looks for this specific file.
await render(logo, 180, 'apple-touch-icon.png');

await writeFile(join(OUT, '.gitattributes'), '*.png binary\n');
process.stdout.write('Done.\n');
