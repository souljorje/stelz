import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function patch(file: string, before: string, after: string) {
  const text = readFileSync(file, "utf8");
  const oldCount = text.split(before).length - 1;
  const newCount = text.split(after).length - 1;
  if (newCount === 1 && !text.replace(after, "").includes(before)) return;
  if (oldCount !== 1 || newCount !== 0) throw Error(`The pinned compatibility patch does not match ${file}.`);
  writeFileSync(file, text.replace(before, after));
}

export function applyPatches(upstream: string) {
  patch(join(upstream, "server.js"),
    "await locator.fill(text, { timeout: 10000 });",
    "await (await import('./plugins/local-profile/index.js')).typeIntoLocator(locator, text);");
  patch(join(upstream, "lib/camoufox-executable.js"),
    "if (!existsSync(executableProperties)) ensureSymlink(realpathSync(resourceProperties), executableProperties);",
    "// stelz: read macOS resources without changing the installed app bundle.");
  patch(join(upstream, "node_modules/camoufox-js/dist/utils.js"),
    'propFile = path.join(path.dirname(filePath), "properties.json");',
    'propFile = process.platform === "darwin" && filePath.includes(".app/Contents/MacOS/") ? path.join(path.dirname(filePath), "../Resources/properties.json") : path.join(path.dirname(filePath), "properties.json");');
  patch(join(upstream, "server.js"), "os: hostOS,\n        humanize: true,",
    "os: hostOS,\n        window: [1200, 800],\n        screen: { minWidth: 1280, minHeight: 900, maxWidth: 1920, maxHeight: 1200 },\n        humanize: true,");
  patch(join(upstream, "server.js"), "proxy: launchProxy,\n        geoip: !!launchProxy,",
    "proxy: launchProxy,\n        block_webrtc: !!launchProxy,\n        geoip: !!launchProxy,");
  // contextIdentityOptions and directIdentity are upstream Camofox identifiers.
  patch(join(upstream, "server.js"), "candidateBrowser = await firefox.launch(options);",
    "candidateBrowser = await (await import('./plugins/local-profile/index.js')).launchProfileBrowser(firefox, options, { viewport: null, ...contextIdentityOptions({ hasProxy: !!proxyPool, directIdentity: CONFIG.directIdentity }) });");
  patch(join(upstream, "server.js"), "const context = await b.newContext(contextOptions);",
    "const context = await (await import('./plugins/local-profile/index.js')).claimProfileContext(b, contextOptions);");
  patch(join(upstream, "plugins/persistence/index.js"), "export async function register(app, ctx, pluginConfig = {}) {",
    "export async function register(app, ctx, pluginConfig = {}) {\n  if (process.env.STELZ_STORAGE_MODE === 'native') return; // Native Firefox profile owns storage.");
}
