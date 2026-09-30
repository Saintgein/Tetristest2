// ==========================================================================
//  tests/pwa.test.js
//  PWA specification compliance tests (manifest, icons, service worker).
// ==========================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

test('manifest.webmanifest: exists and matches PWA specification', () => {
  const manifestPath = path.join(ROOT, 'manifest.webmanifest');
  assert.ok(fs.existsSync(manifestPath), 'manifest.webmanifest must exist in root');

  const content = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(content);

  assert.equal(manifest.name, 'NES Tetris');
  assert.equal(manifest.short_name, 'Tetris');
  assert.equal(
    manifest.description,
    'Authentic zero-allocation NES Tetris with keyboard, touch, and gamepad support.'
  );
  assert.equal(manifest.start_url, './index.html');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.orientation, 'any');
  assert.equal(manifest.background_color, '#000000');
  assert.equal(manifest.theme_color, '#000000');

  assert.ok(Array.isArray(manifest.icons), 'icons must be an array');
  assert.equal(manifest.icons.length, 2);

  const icon192 = manifest.icons.find((i) => i.sizes === '192x192');
  assert.ok(icon192, 'icon 192x192 must exist in manifest');
  assert.equal(icon192.src, 'icons/icon-192.png');
  assert.equal(icon192.type, 'image/png');
  assert.equal(icon192.purpose, 'any maskable');

  const icon512 = manifest.icons.find((i) => i.sizes === '512x512');
  assert.ok(icon512, 'icon 512x512 must exist in manifest');
  assert.equal(icon512.src, 'icons/icon-512.png');
  assert.equal(icon512.type, 'image/png');
  assert.equal(icon512.purpose, 'any maskable');
});

test('icons: generated icons exist and are valid PNG files with correct dimensions', () => {
  const icon192Path = path.join(ROOT, 'icons', 'icon-192.png');
  const icon512Path = path.join(ROOT, 'icons', 'icon-512.png');

  assert.ok(fs.existsSync(icon192Path), 'icon-192.png must exist');
  assert.ok(fs.existsSync(icon512Path), 'icon-512.png must exist');

  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // Check 192x192
  const buf192 = fs.readFileSync(icon192Path);
  assert.ok(buf192.length > 100, 'icon-192.png must not be empty');
  assert.deepEqual(buf192.subarray(0, 8), pngSignature, 'icon-192.png must have valid PNG signature');
  const w192 = buf192.readUInt32BE(16);
  const h192 = buf192.readUInt32BE(20);
  assert.equal(w192, 192, 'icon-192.png width must be 192');
  assert.equal(h192, 192, 'icon-192.png height must be 192');

  // Check 512x512
  const buf512 = fs.readFileSync(icon512Path);
  assert.ok(buf512.length > 100, 'icon-512.png must not be empty');
  assert.deepEqual(buf512.subarray(0, 8), pngSignature, 'icon-512.png must have valid PNG signature');
  const w512 = buf512.readUInt32BE(16);
  const h512 = buf512.readUInt32BE(20);
  assert.equal(w512, 512, 'icon-512.png width must be 512');
  assert.equal(h512, 512, 'icon-512.png height must be 512');
});

test('sw.js: offline service worker exists and caches all required static assets', () => {
  const swPath = path.join(ROOT, 'sw.js');
  assert.ok(fs.existsSync(swPath), 'sw.js must exist in root');

  const swContent = fs.readFileSync(swPath, 'utf8');

  // Check lifecycle event listeners
  assert.ok(swContent.includes("addEventListener('install'"), 'sw.js must handle install');
  assert.ok(swContent.includes("addEventListener('activate'"), 'sw.js must handle activate');
  assert.ok(swContent.includes("addEventListener('fetch'"), 'sw.js must handle fetch');
  assert.ok(swContent.includes('skipWaiting()'), 'sw.js must call skipWaiting()');
  assert.ok(swContent.includes('clients.claim()'), 'sw.js must call clients.claim()');

  // Check static assets to cache
  const requiredAssets = [
    './',
    './index.html',
    './style.css',
    './manifest.webmanifest',
    './src/main.js',
    './src/game.js',
    './src/input.js',
    './src/audio.js',
    './src/ui.js',
    './icons/icon-192.png',
    './icons/icon-512.png',
  ];

  for (const asset of requiredAssets) {
    assert.ok(swContent.includes(asset), `sw.js must cache asset ${asset}`);
  }
});

test('index.html: links manifest and includes Apple mobile web app tags', () => {
  const htmlPath = path.join(ROOT, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert.ok(html.includes('rel="manifest"'), 'index.html must link webmanifest');
  assert.ok(html.includes('href="manifest.webmanifest"'), 'index.html must reference manifest.webmanifest');
  assert.ok(html.includes('name="apple-mobile-web-app-capable"'), 'index.html must include apple-mobile-web-app-capable');
  assert.ok(html.includes('name="apple-mobile-web-app-status-bar-style"'), 'index.html must include apple-mobile-web-app-status-bar-style');
  assert.ok(html.includes('rel="apple-touch-icon"'), 'index.html must include apple-touch-icon');
  assert.ok(html.includes('name="theme-color"'), 'index.html must include theme-color');
});

test('src/main.js: registers service worker with protocol guard', () => {
  const mainPath = path.join(ROOT, 'src', 'main.js');
  const main = fs.readFileSync(mainPath, 'utf8');

  assert.ok(main.includes('serviceWorker'), 'main.js must reference serviceWorker');
  assert.ok(main.includes('location.protocol'), 'main.js must guard registration by protocol');
  assert.ok(main.includes('./sw.js'), 'main.js must register ./sw.js');
});
