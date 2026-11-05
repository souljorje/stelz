// One-off preparation script. Removed from the resulting change.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = process.cwd(), product = join(root, 'packages/stelz');
const adapterPath = 'packages/stelz/src/browser/camofox-adapter.ts';
const oldAdapter = readFileSync(join(root, adapterPath), 'utf8');
const scratch = mkdtempSync(join(tmpdir(), 'stelz-patch-conversion-'));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const write = (p: string, text: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); };
function change(p: string, before: string, after: string) {
  const s = read(p);
  if (s.split(before).length !== 2) throw Error(`Expected one anchor in ${p}: ${before.slice(0, 100)}`);
  write(p, s.replace(before, after));
}
async function run(args: string[]) {
  const p = Bun.spawn(args, { cwd: root, stdout: 'inherit', stderr: 'inherit' });
  if (await p.exited) throw Error(`Command failed: ${args.join(' ')}`);
}
function packageDir(name: string): string {
  for (const parent of [product, root]) {
    const candidate = join(parent, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  const req = createRequire(join(product, 'package.json'));
  return dirname(req.resolve(name + '/package.json'));
}

type Edit = { file: string; before: string; after: string };
try {
  // Read the existing, reviewed edits instead of recreating their behavior.
  const recorder = join(scratch, 'record.ts');
  writeFileSync(recorder, `import { join } from 'node:path';\nexport const edits: {file:string;before:string;after:string}[]=[];\nfunction patch(file:string,before:string,after:string) { edits.push({file,before,after}); }\n` + oldAdapter.slice(oldAdapter.indexOf('export function applyPatches')));
  const recorded = await import(pathToFileURL(recorder).href);
  recorded.applyPatches(scratch);
  const edits = recorded.edits as Edit[];
  if (edits.length !== 8) throw Error('Review the changed upstream patch set before converting it.');
  const camofox = packageDir('@askjo/camofox-browser'), launcher = packageDir('camoufox-js');
  for (const e of edits) {
    if (existsSync(e.file)) continue;
    const rel = relative(scratch, e.file);
    const source = rel.startsWith('node_modules/camoufox-js/') ? join(launcher, rel.slice('node_modules/camoufox-js/'.length)) : join(camofox, rel);
    mkdirSync(dirname(e.file), { recursive: true });
    writeFileSync(e.file, readFileSync(source));
  }
  const { applyPatches } = await import(pathToFileURL(join(root, adapterPath)).href);
  applyPatches(scratch);
  // Bun owns patch generation, reinstalling the packages, and lockfile changes.
  for (const [name, version, prefix] of [
    ['@askjo/camofox-browser', '1.18.1', ''],
    ['camoufox-js', '0.11.5', 'node_modules/camoufox-js/'],
  ]) {
    await run([process.execPath, 'patch', `${name}@${version}`]);
    const dir = packageDir(name!);
    const targets = new Set(edits.map(e => relative(scratch, e.file)).filter(p => prefix ? p.startsWith(prefix) : !p.startsWith('node_modules/')));
    for (const target of targets) writeFileSync(join(dir, prefix ? target.slice(prefix.length) : target), readFileSync(join(scratch, target)));
    await run([process.execPath, 'patch', '--commit', `${name}@${version}`]);
  }
  const manifest = JSON.parse(read('packages/stelz/package.json'));
  manifest.bundleDependencies = ['@askjo/camofox-browser', 'camoufox-js'];
  write('packages/stelz/package.json', JSON.stringify(manifest, null, 2) + '\n');

  // Setup verifies prepared code but never rewrites dependency source.
  const groups = new Map<string, string[]>();
  for (const e of edits) {
    const rel = relative(scratch, e.file);
    const items = groups.get(rel) || []; items.push(e.after); groups.set(rel, items);
  }
  const checks = [...groups].map(([file, markers]) => {
    const isLauncher = file.startsWith('node_modules/camoufox-js/');
    return `  requireMarkers(join(${isLauncher ? 'launcher' : 'upstream'}, ${JSON.stringify(isLauncher ? file.slice('node_modules/camoufox-js/'.length) : file)}), ${JSON.stringify(markers, null, 2)});`;
  }).join('\n');
  write(adapterPath, `import { readFileSync } from "node:fs";\nimport { join } from "node:path";\n\n// A read-only compatibility check, not a patch engine. Bun prepares these files.\nfunction requireMarkers(file: string, markers: readonly string[]) {\n  const text = readFileSync(file, "utf8");\n  for (const marker of markers) {\n    if (text.split(marker).length !== 2) {\n      throw Error(\`The installed Camofox dependencies are not prepared for Stelz: \${file}. Reinstall the release package, or run bun install in the source workspace. Setup did not patch this file.\`);\n    }\n  }\n}\n\nexport function assertPatchedDependencies(upstream: string, launcher: string) {\n  for (const [directory, name, version] of [[upstream, "@askjo/camofox-browser", "1.18.1"], [launcher, "camoufox-js", "0.11.5"]]) {\n    const manifest = JSON.parse(readFileSync(join(directory!, "package.json"), "utf8"));\n    if (manifest.name !== name || manifest.version !== version) throw Error(\`Unsupported bundled dependency: \${name}. Reinstall the tested Stelz release.\`);\n  }\n${checks}\n}\n`);
  change('packages/stelz/src/browser/setup.ts', 'import { applyPatches }', 'import { assertPatchedDependencies }');
  change('packages/stelz/src/browser/setup.ts', '  applyPatches(upstream);', '  assertPatchedDependencies(upstream, join(upstream, "node_modules/camoufox-js"));');

  // Existing setup fixtures now represent prepatched dependency packages.
  const fixtureFile = 'tests/integration/setup.test.ts';
  let fixture = read(fixtureFile);
  for (const [file, fileEdits] of groups) {
    const isLauncher = file.startsWith('node_modules/camoufox-js/');
    const target = isLauncher ? file.slice('node_modules/camoufox-js/'.length) : file;
    const prefix = `file(join(${isLauncher ? 'camoufox' : 'upstream'}, ${JSON.stringify(target)}), `;
    const start = fixture.indexOf(prefix);
    if (start < 0) throw Error('Missing setup fixture: ' + target);
    const literalStart = start + prefix.length;
    const literal = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)/s.exec(fixture.slice(literalStart))?.[0];
    if (!literal || literal.includes('${')) throw Error('Unexpected fixture literal: ' + target);
    let value: string = Function('return (' + literal + ')')();
    for (const e of edits.filter(e => relative(scratch, e.file) === file)) {
      if (value.split(e.before).length !== 2) throw Error('Fixture patch is not unique: ' + target);
      value = value.replace(e.before, e.after);
    }
    fixture = fixture.slice(0, literalStart) + JSON.stringify(value) + fixture.slice(literalStart + literal.length);
  }
  fixture += `\n\ntest("unpatched dependency files are rejected without rewriting sources or replacing the runtime", async () => {\n  for (const item of [\n    { path: "server.js", marker: "typeIntoLocator(locator, text)" },\n    { path: "lib/camoufox-executable.js", marker: "// stelz: read macOS resources without changing the installed app bundle." },\n    { path: "plugins/persistence/index.js", marker: "if (process.env.STELZ_STORAGE_MODE === 'native') return;" },\n    { path: "../camoufox-js/dist/utils.js", marker: "process.platform === \\\"darwin\\\"" },\n  ]) {\n    const f = fixture(); legacy(f);\n    const source = item.path.startsWith("../") ? join(f.project, "node_modules/camoufox-js/dist/utils.js") : join(f.upstream, item.path);\n    const original = readFileSync(source, "utf8");\n    expect(original).toContain(item.marker);\n    const unpatched = original.replace(item.marker, "/* missing patch */");\n    writeFileSync(source, unpatched);\n    const result = await finish(launch(f));\n    expect(result.code).not.toBe(0);\n    expect(result.stderr).toContain("not prepared for Stelz");\n    expect(readFileSync(source, "utf8")).toBe(unpatched);\n    oldRuntime(f);\n  }\n});\n`;
  write(fixtureFile, fixture);

  const verifier = readFileSync(join(root, 'scripts/.bundle-verifier-template.txt'), 'utf8');
  write('scripts/verify-bundled-dependencies.ts', verifier);
  change('scripts/build.ts', 'import { checkMarkdownLinks } from "./markdown-links.ts";', 'import { checkMarkdownLinks } from "./markdown-links.ts";\nimport { verifyBundledDependencies } from "./verify-bundled-dependencies.ts";');
  change('scripts/build.ts', 'const dist = join(product, "dist");', 'const dist = join(product, "dist");\nverifyBundledDependencies(product);');
  for (const path of ['scripts/verify-release.ts', 'tests/qa/package.ts']) {
    let code = read(path);
    const relativeVerifier = path.startsWith('scripts/') ? './verify-bundled-dependencies.ts' : '../../scripts/verify-bundled-dependencies.ts';
    code = `import { verifyBundledDependencies, verifyBundledArchive } from ${JSON.stringify(relativeVerifier)};\n` + code;
    code = code.replace('^(src|test|node_modules|', '^(src|test|');
    code = code.replace('^(?:dist\\/|docs\\/|examples\\/|skills\\/|', '^(?:node_modules\\/|dist\\/|docs\\/|examples\\/|skills\\/|');
    code = code.replace('"install", "--global", "--prefix", prefix, archive', '"install", "--ignore-scripts", "--global", "--prefix", prefix, archive');
    const install = 'await run([npm, "install", "--ignore-scripts", "--global", "--prefix", prefix, archive]);';
    if (code.split(install).length !== 2) throw Error('Missing isolated install: ' + path);
    code = code.replace(install, `verifyBundledArchive(packed[0]!.files.map(file => file.path));\n${install}\nverifyBundledDependencies(join(prefix, "lib/node_modules/stelz"), join(root, "packages/stelz"));`);
    write(path, code);
  }
  write('docs/camofox-patches.md', readFileSync(join(root, 'scripts/.patch-doc-template.txt'), 'utf8'));
  const distribution = 'docs/distribution.md';
  write(distribution, read(distribution) + '\n## Prepared browser dependencies\n\nThe release bundles the patched Camofox and camoufox-js packages. Consumers do not apply patches or run dependency install scripts to obtain the fixes. Run `stelz setup` explicitly after installation.\n\nSource builds require `bun install --frozen-lockfile` at the workspace root. See [Camofox patches](camofox-patches.md) for the patch workflow and verification. Stop profiles before upgrading, then run setup and restart them explicitly. Bundling does not provide live-upgrade safety.\n');
  for (const p of ['docs/README.md', 'docs/tests.md']) {
    let s = read(p);
    s = s.replace('Setup copies the published Camofox package into the service directory.', 'Setup copies the prepared Camofox package bundled with Stelz into the service directory.');
    s = s.replace('Setup copies dependencies, applies patches, and validates', 'Setup copies prepared dependencies and validates');
    write(p, s);
  }
  await run([process.execPath, 'install', '--lockfile-only', '--ignore-scripts']);
  console.log('Converted the same eight edits to Bun patches and bundled dependencies.');
} finally { rmSync(scratch, { recursive: true, force: true }); }
