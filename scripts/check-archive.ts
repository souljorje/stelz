import { $ } from "bun";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const root = resolve(import.meta.dir, "..");
const { values } = parseArgs({ args: process.argv.slice(2), options: {
  archive: { type: "string" }, "out-dir": { type: "string" },
  "from-publish-plan": { type: "string" }, "pack-only": { type: "boolean" },
} });
if (values.archive && (values["out-dir"] || values["from-publish-plan"] || values["pack-only"]))
  throw Error("Use --archive FILE alone to check an existing archive.");
if (values["pack-only"] && !values["from-publish-plan"])
  throw Error("Use --pack-only with --from-publish-plan FILE. Release installation jobs check the resulting archive.");

let archive = values.archive && resolve(values.archive);
if (!archive) {
  const output = values["out-dir"] ? resolve(values["out-dir"]) : mkdtempSync(join(tmpdir(), "stelz-archive-"));
  mkdirSync(output, { recursive: true });
  const stage = (await $`${process.execPath} run prepare:package`.cwd(root).text()).trim();
  try {
    if (values["from-publish-plan"]) {
      await $`${join(root, "node_modules/.bin/changeset")} pack --from-publish-plan ${resolve(values["from-publish-plan"])} --out-dir ${output}`
        .cwd(stage).env({ ...process.env, npm_config_ignore_scripts: "true" });
      const packages = join(output, "packages"), files = readdirSync(packages).filter(name => name.endsWith(".tgz"));
      if (files.length !== 1) throw Error("The release must contain exactly one stelz archive.");
      archive = join(packages, files[0]!);
    } else {
      const packed = JSON.parse(await $`npm pack --json --ignore-scripts --pack-destination ${output}`.cwd(stage).text());
      archive = join(output, packed[0].filename);
    }
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (!values["pack-only"]) {
  await $`${process.execPath} run lint:package ${archive}`.cwd(root);
  await $`${process.execPath} run test:install --archive ${archive} --both`.cwd(root);
}
console.log("Archive: " + archive);
