import { existsSync } from "node:fs";
import { CONFIG_FILE, HOME_DIR, STATE } from "../profiles/config.ts";
import { ensureProfile, updateScripts, ProfileCatalogError, ProfileConfigurationError } from "../profiles/profile-configuration.ts";
import { runProfileTransfer, transferUsage } from "./profile-transfer.ts";

const usage = "stelz profile create ID [--direct | --proxy-url URL | --proxy-env NAME] [--expected-ip IP | --expected-ip-env NAME] [--json]";
const configUsage = "stelz profile config ID --allow-scripts | --no-allow-scripts [--json]";
function invalid(use = usage): never { throw new ProfileCatalogError(400, `Use: ${use}`); }
// Only a person turns scripts on, here or in the UI. MCP has no such command.
function configOptions(args: string[]) {
  const flags = args.slice(2).filter(flag => flag !== "--json");
  if (args[0] !== "config" || !args[1] || args[1].startsWith("-") || args.length - 2 - flags.length > 1 ||
      flags.length !== 1 || !["--allow-scripts", "--no-allow-scripts"].includes(flags[0]!)) invalid(configUsage);
  return { id: args[1], allow: flags[0] === "--allow-scripts" };
}
function options(args: string[]) {
  if (args[0] !== "create" || !args[1] || args[1].startsWith("-")) invalid();
  const input: Parameters<typeof ensureProfile>[0] = { id: args[1] };
  const seen = new Set<string>();
  for (let index = 2; index < args.length; index++) {
    const flag = args[index]!;
    const key = ({ "--json": "json", "--direct": "direct", "--proxy-url": "proxyUrl", "--proxy-env": "proxyUrl",
      "--expected-ip": "expectedIp", "--expected-ip-env": "expectedIp" } as Record<string, string>)[flag];
    if (!key || seen.has(key)) invalid();
    seen.add(key);
    if (key === "json") continue;
    if (key === "direct") { input.direct = true; continue; }
    let value = args[++index];
    if (value === undefined || value.startsWith("--")) invalid();
    if (flag.endsWith("-env")) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) invalid();
      const referenced = process.env[value];
      if (!referenced) throw new ProfileCatalogError(400, "The requested environment variable is missing or empty. Supply it before creating this profile.");
      value = referenced;
    }
    input[key as "proxyUrl" | "expectedIp"] = value;
  }
  return input;
}

export async function runProfile(args: string[]) {
  if (args[0] === "import" || args[0] === "export") return runProfileTransfer(args);
  if (args[0] === "fingerprint") return (await import("./profile-fingerprint.ts")).runProfileFingerprint(args.slice(1));
  const json = args.includes("--json"), configure = args[0] === "config";
  try {
    if (args.length === 1 && args[0] === "--help" || args.length === 2 && ["create", "config"].includes(args[0]!) && args[1] === "--help") {
      const { fingerprintUsage } = await import("./profile-fingerprint.ts");
      console.log(args[0] === "--help" ? [usage, configUsage, transferUsage, fingerprintUsage].join("\n") : args[0] === "config" ? configUsage : usage); return;
    }
    const input = configure ? configOptions(args) : options(args);
    if (!existsSync(CONFIG_FILE) || !existsSync(STATE)) {
      const error = { code: "not_initialized", message: "Run stelz setup first, using the same STELZ_HOME." };
      console.error(json ? JSON.stringify({ ok: false, error }) : error.message);
      process.exitCode = 1; return;
    }
    if ("allow" in input) {
      const { profile: p } = await updateScripts(input.id, { allow: input.allow });
      const allowed = p.allowScripts === true;
      console.log(json ? JSON.stringify({ ok: true, home: HOME_DIR, profile: { id: p.id, allowScripts: allowed } })
        : `Scripts are ${allowed ? "allowed" : "off"} for profile ${p.id}.`);
      return;
    }
    const { profile: p, created } = await ensureProfile(input);
    const result = { ok: true, created, home: HOME_DIR, profile: {
      id: p.id, port: p.port, storage: "native", proxyConfigured: p.proxyEnv !== undefined,
      ...(p.proxyEnv ? { proxyEnv: p.proxyEnv } : {}), ...(p.expectedIPEnv ? { expectedIPEnv: p.expectedIPEnv } : {}),
    } };
    console.log(json ? JSON.stringify(result) : `${created ? "Created" : "Reused"} profile ${p.id}.`);
  } catch (cause) {
    const known = cause instanceof ProfileCatalogError || cause instanceof ProfileConfigurationError;
    const error = { code: known ? cause.status === 400 ? "invalid_input" : cause.status === 404 ? "not_found" : "conflict" : "profile_unavailable",
      message: known ? cause.message : `Cannot ${configure ? "change" : "create or reuse"} the profile. Run stelz doctor and inspect the service files.` };
    console.error(json ? JSON.stringify({ ok: false, error }) : error.message);
    process.exitCode = 1;
  }
}
