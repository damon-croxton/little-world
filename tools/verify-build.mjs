import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Follow the modules the entry point actually imports. This catches missing
// vendored assets and accidental root-relative paths on GitHub Pages projects.
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const checked = new Set();
const assertLocal = reference => {
  assert.ok(!/^(?:\/|https?:|file:)/i.test(reference), `Nonportable built asset: ${reference}`);
};
function resolveModule(reference, importer, map) {
  const key = Object.keys(map).sort((a, b) => b.length - a.length).find(key => key === reference || (key.endsWith('/') && reference.startsWith(key)));
  const mapped = key ? map[key] + reference.slice(key.length) : reference;
  assertLocal(mapped);
  assert.ok(mapped.startsWith('.'), `Unmapped module: ${reference}`);
  const result = path.resolve(key ? root : path.dirname(importer), mapped);
  assert.ok(result.startsWith(root), `Asset escaped build directory: ${reference}`);
  return result;
}
async function inspectModule(filename, map, seen) {
  if (seen.has(filename)) return;
  seen.add(filename);
  checked.add(filename);
  const source = await readFile(filename, 'utf8');
  const imports = /(?:\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?|\bimport\s*\()\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(imports)) await inspectModule(resolveModule(match[1], filename, map), map, seen);
}
for (const entry of ['index.html', 'battle.html']) {
  const html = await readFile(path.join(root, entry), 'utf8');
  const map = JSON.parse(html.match(/<script\s+type="importmap">([\s\S]*?)<\/script>/)?.[1] || '{}').imports || {};
  const seen = new Set();
  for (const match of html.matchAll(/<(script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
    const reference = match[2];
    if (reference.startsWith('data:')) continue;
    assertLocal(reference);
    const filename = path.resolve(root, reference);
    assert.ok(filename.startsWith(root), `Asset escaped build directory: ${reference}`);
    assert.ok((await stat(filename)).isFile(), `Missing asset: ${reference}`);
    if (match[1] === 'script') await inspectModule(filename, map, seen);
  }
}
const marker = JSON.parse(await readFile(path.join(root, 'build.json'), 'utf8'));
assert.ok(marker.version && marker.commit, 'Build version/commit marker is missing');
console.log(`Verified self-contained Pages asset graph: ${checked.size} modules; version ${marker.version}; commit ${marker.commit}.`);
