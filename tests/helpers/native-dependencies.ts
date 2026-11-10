import { join } from "node:path";

/** Execute target-native addons through the installed package and its staged runtime. No browser. */
export async function nativeSmoke(node: string, installed: string, stagedServer: string, options: { cwd: string; env: Record<string, string> }) {
  const probe = `
    import { createRequire } from "node:module";
    import { realpathSync } from "node:fs";
    const own = createRequire(process.argv[1]), staged = createRequire(process.argv[2]);
    const server = createRequire(own.resolve("@askjo/camofox-browser/package.json"));
    const launcher = createRequire(server.resolve("camoufox/package.json"));
    const stagedLauncher = createRequire(staged.resolve("camoufox/package.json"));
    const manifest = own("./package.json");
    const checks = [];
    function resolved(require, name) {
      if (realpathSync(require.resolve(name)) !== realpathSync(own.resolve(name)))
        throw Error("Native addon resolution escaped the installed package: " + name);
      if (require(name + "/package.json").version !== manifest.dependencies[name])
        throw Error("Unexpected native addon version: " + name);
    }
    for (const [scope, require] of [["installed", own], ["camofox", server], ["runtime", staged]]) {
      resolved(require, "better-sqlite3");
      const Sqlite = require("better-sqlite3"), db = new Sqlite(":memory:");
      try { if (db.prepare("select 1 as ok").get().ok !== 1) throw Error("SQLite execution failed."); }
      finally { db.close(); }
      checks.push(scope + ":sqlite-query");
    }
    for (const [scope, require] of [["installed", own], ["launcher", launcher], ["runtime", staged], ["runtime-launcher", stagedLauncher]]) {
      resolved(require, "impit");
      const client = new (require("impit").Impit)();
      if (typeof client.fetch !== "function") throw Error("Impit construction failed.");
      checks.push(scope + ":impit-constructor");
    }
    console.log(JSON.stringify({ sqlite: own("better-sqlite3/package.json").version,
      impit: own("impit/package.json").version, node: process.version, checks }));
  `;
  const child = Bun.spawn([node, "--input-type=module", "-e", probe, join(installed, "package.json"), join(stagedServer, "package.json")], {
    ...options, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code) throw Error(`Installed native-addon execution failed: ${err || out}`);
  return JSON.parse(out) as { sqlite: string; impit: string; node: string; checks: string[] };
}
