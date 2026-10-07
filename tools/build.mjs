import {cp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
if (path.dirname(out) !== root || path.basename(out) !== 'dist') throw new Error('Unsafe build destination');
await rm(out, {recursive:true, force:true});
await mkdir(path.join(out, 'vendor', 'three'), {recursive:true});
await cp(path.join(root, 'src'), path.join(out, 'src'), {recursive:true});
await cp(path.join(root, 'node_modules/three/build'), path.join(out, 'vendor/three/build'), {recursive:true});
await cp(path.join(root, 'node_modules/three/examples/jsm'), path.join(out, 'vendor/three/examples/jsm'), {recursive:true});
await cp(path.join(root, 'node_modules/three/LICENSE'), path.join(out, 'vendor/three/LICENSE'));
for (const entry of ['index.html', 'battle.html']) {
  const html = (await readFile(path.join(root, entry), 'utf8')).replaceAll('./node_modules/three/', './vendor/three/');
  await writeFile(path.join(out, entry), html);
}
await writeFile(path.join(out, '.nojekyll'), '');
let commit = process.env.GITHUB_SHA;
if (!commit) { try { commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:root, encoding:'utf8'}).trim(); } catch { commit = 'local'; } }
await writeFile(path.join(out, 'build.json'), JSON.stringify({version:'0.2.0', commit}, null, 2));
await writeFile(path.join(out, 'src/build-info.js'), `export const BUILD_INFO = Object.freeze(${JSON.stringify({version:'0.2.0', commit})});\n`);
console.log('Built self-contained static site in dist/ (relative URLs support GitHub Pages project paths).');
