import { existsSync } from "node:fs";
import { CONFIG_FILE, HOME_DIR, STATE } from "../profiles/config.ts";
import { ensureProfile, ProfileCatalogError, ProfileConfigurationError } from "../profiles/profile-configuration.ts";
import { hasProxy } from "../profiles/network-compat.ts";

const usage = "stelz profile create ID [--direct | --proxy-url URL | --proxy-env NAME] [--expected-ip IP | --expected-ip-env NAME] [--json]";
function invalid(): never { throw new ProfileCatalogError(400, `Use: ${usage}`); }
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
  const json = args.includes("--json");
  try {
    if (args.length === 1 && args[0] === "--help" || args.length === 2 && args[0] === "create" && args[1] === "--help") {
      console.log(usage); return;
    }
    const input = options(args);
    if (!existsSync(CONFIG_FILE) || !existsSync(STATE)) {
      const error = { code: "not_initialized", message: "Run stelz init first, using the same STELZ_HOME." };
      console.error(json ? JSON.stringify({ ok: false, error }) : error.message);
      process.exitCode = 1; return;
    }
    const { profile: p, created } = await ensureProfile(input);
    const result = { ok: true, created, home: HOME_DIR, profile: {
      id: p.id, port: p.port, storage: p.storage ?? "checkpoint", proxyConfigured: hasProxy(p),
      ...(p.proxyEnv ? { proxyEnv: p.proxyEnv } : {}), ...(p.expectedIPEnv ? { expectedIPEnv: p.expectedIPEnv } : {}),
    } };
    console.log(json ? JSON.stringify(result) : `${created ? "Created" : "Reused"} profile ${p.id}.`);
  } catch (cause) {
    const known = cause instanceof ProfileCatalogError || cause instanceof ProfileConfigurationError;
    const error = { code: known ? cause.status === 400 ? "invalid_input" : "conflict" : "profile_unavailable",
      message: known ? cause.message : "Cannot create or reuse the profile. Run stelz doctor and inspect the service files." };
    console.error(json ? JSON.stringify({ ok: false, error }) : error.message);
    process.exitCode = 1;
  }
}
