import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { ROOT, settings } from "./config.ts";
const instructions = `You operate only the browser profile explicitly assigned by the orchestrator. Acquire it through profile_acquire and retain its leaseToken. Never launch Camoufox yourself or use another browser endpoint. Use fresh snapshots to choose clicks and typing. Do not write task-specific JavaScript/Python automation. Stop and call profile_pause for sign-in or authentication challenges; tell the orchestrator what the human must do in the same window. After human completion call profile_resume, take a new snapshot, and continue. Verify the requested outcome. Release with stopBrowser=true when done unless asked to leave the window open. Do not modify real files in optional Google Drive tests. MCP profile leases are operational separation, not a security boundary against other agents.`;
const files = new Map<string, string>();
function writeConfig(root: string, id?: string) {
  const folder = join(root, ".codex");
  const target = join(folder, "config.toml");
  files.set(target, `[mcp_servers.stelz_camofox]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify([join(ROOT, "src/mcp.ts"), ...(id ? ["--profile", id] : [])])}\ncwd = ${JSON.stringify(ROOT)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 180\nrequired = true\n`);
}
writeConfig(ROOT);
files.set(join(ROOT, ".codex/agents/browser_worker.toml"), `name = "browser_worker"\ndescription = "Operate one assigned persistent Camoufox profile through MCP"\ndeveloper_instructions = ${JSON.stringify(instructions)}\n\n[features]\nshell_tool = false\n`);
for (const p of settings().profiles) {
  const folder = join(ROOT, "sessions", p.id); writeConfig(folder, p.id);
  files.set(join(folder, "AGENTS.md"), `Use only the assigned profile ${p.id}. ${instructions}\n`);
}
for (const [path, text] of files) if (existsSync(path) && readFileSync(path, "utf8") !== text) throw Error(`Refusing to overwrite modified ${path}`);
for (const [path, text] of files) if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
console.log("Project-local MCP configurations created. Open the project in Codex desktop and reload MCP; global configuration was not changed.");
