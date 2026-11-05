import { readFileSync } from "node:fs";
import { join } from "node:path";

// A read-only compatibility check, not a patch engine. Bun prepares these files.
function requireMarkers(file: string, markers: readonly string[]) {
  const text = readFileSync(file, "utf8");
  for (const marker of markers) {
    if (text.split(marker).length !== 2) {
      throw Error(`The installed Camofox dependencies are not prepared for Stelz: ${file}. Reinstall the release package, or run bun install in the source workspace. Setup did not patch this file.`);
    }
  }
}

export function assertPatchedDependencies(upstream: string, launcher: string) {
  for (const [directory, name, version] of [[upstream, "@askjo/camofox-browser", "1.18.1"], [launcher, "camoufox-js", "0.11.5"]]) {
    const manifest = JSON.parse(readFileSync(join(directory!, "package.json"), "utf8"));
    if (manifest.name !== name || manifest.version !== version) throw Error(`Unsupported bundled dependency: ${name}. Reinstall the tested Stelz release.`);
  }
  requireMarkers(join(upstream, "server.js"), [
  "await (await import('./plugins/local-profile/index.js')).typeIntoLocator(locator, text);",
  "os: hostOS,\n        window: [1200, 800],\n        screen: { minWidth: 1280, minHeight: 900, maxWidth: 1920, maxHeight: 1200 },\n        humanize: true,",
  "proxy: launchProxy,\n        block_webrtc: !!launchProxy,\n        geoip: !!launchProxy,",
  "candidateBrowser = await (await import('./plugins/local-profile/index.js')).launchProfileBrowser(firefox, options, { viewport: null, ...contextIdentityOptions({ hasProxy: !!proxyPool, directIdentity: CONFIG.directIdentity }) });",
  "const context = await (await import('./plugins/local-profile/index.js')).claimProfileContext(b, contextOptions);"
]);
  requireMarkers(join(upstream, "lib/camoufox-executable.js"), [
  "// stelz: read macOS resources without changing the installed app bundle."
]);
  requireMarkers(join(launcher, "dist/utils.js"), [
  "propFile = process.platform === \"darwin\" && filePath.includes(\".app/Contents/MacOS/\") ? path.join(path.dirname(filePath), \"../Resources/properties.json\") : path.join(path.dirname(filePath), \"properties.json\");"
]);
  requireMarkers(join(upstream, "plugins/persistence/index.js"), [
  "export async function register(app, ctx, pluginConfig = {}) {\n  if (process.env.STELZ_STORAGE_MODE === 'native') return; // Native Firefox profile owns storage."
]);
}
