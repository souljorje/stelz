import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { suppliedProxyEndpoints } from "./proxy-acceptance-helpers.ts";

/** Live suites must never inherit a proxy URL from the shell or an everyday profile. */
export function dedicatedProxyInputs(file: string | undefined, usage: "acceptance" | "public") {
  if (!file || !isAbsolute(file)) throw Error("Set PROXY_TEST_ENV to an absolute dedicated test input file path.");
  let input: Record<string, string | undefined>;
  try { input = parseEnv(readFileSync(file, "utf8")); }
  catch { throw Error("Cannot read PROXY_TEST_ENV. Private inputs are hidden."); }
  if (input.PROXY_TEST_USAGE !== `dedicated-${usage}`) {
    throw Error(`PROXY_TEST_ENV must declare PROXY_TEST_USAGE=dedicated-${usage}. Do not use everyday proxies.`);
  }
  suppliedProxyEndpoints(input);
  if (usage === "public" && input.PROXY_TEST_SECOND_URL) throw Error("Public checks require one dedicated proxy route.");
  return input;
}
