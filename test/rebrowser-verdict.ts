import type { Assessment } from "./public-site-verdicts.ts";

type Detection = { type: string; rating?: unknown; note?: unknown; debug?: unknown };
type Probe = { skip: string } | { hook: RegExp } | { automatic: true };

// Verified against the deployed HTML and index.js?4 on 2026-11-03, not the README's probe list.
// https://bot-detector.rebrowser.net/index.js?4
// https://github.com/rebrowser/rebrowser-bot-detector/blob/main/index.js
const PROBES: Record<string, Probe> = {
  dummyFn: { skip: "Main-world access diagnostic. It does not test for automation." },
  sourceUrlLeak: { hook: /^Call document\.getElementById\(['"]detections-json['"]\) to test sourceUrl leak\./ },
  mainWorldExecution: { hook: /^Call document\.getElementsByClassName\(['"]div['"]\) to trigger this test\./ },
  runtimeEnableLeak: { skip: "Targets Chromium CDP Runtime.enable and V8 stack serialization, not Firefox automation." },
  exposeFunctionLeak: { hook: /^No window\.exposedFn\. Use page\.exposeFunction to trigger this test\./ },
  navigatorWebdriver: { automatic: true },
  viewport: { automatic: true },
  useragent: { skip: "Requires Chromium navigator.userAgentData and Chrome release information. Firefox does not provide them." },
  pwInitScripts: { automatic: true },
  platformMismatch: { automatic: true },
  mobileEmulation: { automatic: true },
  documentInterception: { skip: "The deployed probe runs only in Chromium-based browsers." },
  bypassCsp: { automatic: true },
  popupBlocking: { automatic: true },
  ipcFloodingProtection: { skip: "Uses Chrome's 200-history-updates-per-10-seconds threshold. Firefox rate limits differ." },
  storagePartitioning: { skip: "The deployed probe requires Chromium 148 or newer. It does not test Firefox storage partitioning." },
  cdpBindingGlobals: { skip: "Targets CDP Runtime.addBinding globals. Firefox automation does not use this Chromium mechanism." },
  headless: { skip: "Targets HeadlessChrome and Chrome headless-shell. A green result does not verify Firefox headless behavior." },
  nativeTampering: { automatic: true },
  workerConsistency: { automatic: true },
};

function plain(value: unknown): string {
  return typeof value === "string" ? value.replace(/<\/?(?:div|p|br)\b[^>]*>/gi, " ").replace(/<[^>]*>/g, "")
    .replace(/&(lt|gt|amp|quot|apos|nbsp|#39);/g, (_, name: string) => ({
      lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " ", "#39": "'",
    })[name]!)
    .replace(/\s+/g, " ").trim() : "";
}

function scalar(source: string): string | undefined {
  if (source.startsWith('"')) {
    try { const value: unknown = JSON.parse(source); return typeof value === "string" ? value : undefined; }
    catch { return; }
  }
  if (source.startsWith("'") && source.endsWith("'")) return source.slice(1, -1).replace(/''/g, "'");
  return source;
}

// Read only the detector's JSON textarea. Do not search arbitrary text or example code for JSON.
function nativeJSON(snapshot: string): unknown {
  const lines = snapshot.split(/\r?\n/);
  const headings: { level: number; name: string }[] = [];
  const candidates: string[] = [];
  let excludedIndent: number | undefined;
  let json = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    const indent = /^\s*/.exec(line)![0].length;
    if (excludedIndent !== undefined) {
      if (indent > excludedIndent) continue;
      excludedIndent = undefined;
    }
    const entry = /^\s*- ([a-z][\w-]*)(.*)$/.exec(line);
    if (!entry) continue;
    const [, role, rest = ""] = entry;
    const name = /^\s*("(?:\\.|[^"\\])*")/.exec(rest)?.[1];
    const label = name ? scalar(name) ?? "" : "";
    const example = /^(?:examples?|samples?|help|how to|learn more|documentation)(?:\b|$)/i;
    if (/^(?:code|pre|tooltip|contentinfo)$/.test(role!) || (role !== "heading" && example.test(label)) || /\[hidden(?:=true)?\]/.test(rest)) {
      excludedIndent = indent;
      if (role === "heading" || role === "contentinfo") json = false;
      continue;
    }
    if (role === "heading") {
      const level = Number(/\[level=(\d+)\]/.exec(rest)?.[1] ?? 1);
      while (headings.length && headings.at(-1)!.level >= level) headings.pop();
      headings.push({ level, name: label });
      json = label === "JSON" && !headings.some(heading => example.test(heading.name)) && headings.some(heading => heading.level === 1 &&
        heading.name.replace(/^[\p{S}\p{P}\uFE0F\s]+/u, "") === "rebrowser-bot-detector");
      continue;
    }
    const value = /^\s*(?:"(?:\\.|[^"\\])*"\s*)?(?:\[[^\]]*\]\s*)*:\s*(.*)$/.exec(rest)?.[1];
    if (value === undefined) continue;
    const textarea = json && role === "textbox" && (!label || label === "JSON");
    if (textarea && /\[busy(?:=true)?\]/.test(rest)) throw new Error("The native JSON result area is busy.");
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = [];
      while (index + 1 < lines.length && (!lines[index + 1]!.trim() || /^\s*/.exec(lines[index + 1]!)![0].length > indent)) {
        block.push(lines[++index]!);
      }
      if (textarea) candidates.push(block.map(part => part.trim()).join("\n"));
    } else if (textarea) {
      const decoded = scalar(value);
      if (decoded === undefined) throw new Error("The native JSON result area has an invalid scalar.");
      candidates.push(decoded);
    }
  }
  if (candidates.length !== 1) throw new Error("One native Rebrowser JSON result area is required.");
  return JSON.parse(candidates[0]!);
}

function native(detection: Detection): string {
  const color = new Map<unknown, string>([[-1, "🟢"], [0, "⚪️"], [0.5, "🟡"], [1, "🔴"]]).get(detection.rating) ?? "unknown";
  const note = plain(detection.note);
  return `native ${color} rating=${JSON.stringify(detection.rating) ?? "missing"}${note ? `: ${note}` : ""}` +
    (detection.debug === undefined ? "" : `; debug=${JSON.stringify(detection.debug)}`);
}

export function assessRebrowser(snapshot: string): Assessment {
  let parsed: unknown;
  try { parsed = nativeJSON(snapshot); }
  catch {
    return { verdict: "INCONCLUSIVE", reason: "The native Rebrowser JSON result area is missing, busy, or invalid.", details: {} };
  }
  if (!Array.isArray(parsed)) {
    return { verdict: "INCONCLUSIVE", reason: "The native Rebrowser JSON result is not a detection array.", details: {} };
  }
  const observed = new Map<string, Detection[]>();
  const details: Record<string, string> = Object.create(null);
  const warnings: string[] = [];
  let incomplete = false;
  let failed = 0;
  let clear = 0;
  let advisory = 0;
  let skipped = 0;
  let unverified = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object" || typeof item.type !== "string" || !item.type.trim()) {
      incomplete = true;
      details["invalid result"] = "UNVERIFIED: The detection array contains an invalid entry.";
      continue;
    }
    observed.set(item.type, [...(observed.get(item.type) ?? []), item as Detection]);
  }
  for (const name of new Set([...Object.keys(PROBES), ...observed.keys()])) {
    const policy = Object.hasOwn(PROBES, name) ? PROBES[name] : undefined;
    const results = observed.get(name) ?? [];
    const statuses = results.length ? results.map(native).join(" | ") : "native result missing";
    const skip = policy && ("skip" in policy ? policy.skip : "hook" in policy &&
      (!results.length || results.every(result => policy.hook.test(plain(result.note))))
      ? "The hook-dependent probe was not triggered. Its result is unverified." : undefined);
    for (const result of results) {
      if (result.rating === 0.5) warnings.push(`${name}: ${plain(result.note) || "Native advisory warning."}${skip ? ` Skipped: ${skip}` : ""}`);
    }
    if (skip) {
      skipped++;
      details[name] = `SKIPPED; ${statuses}; ${skip}`;
      continue;
    }
    if (!policy || results.length !== 1 || ![-1, 0.5, 1].includes(results[0]?.rating as number)) {
      incomplete = true;
      unverified++;
      details[name] = `UNVERIFIED; ${statuses}; ${!policy ? "Probe applicability is unknown." :
        !results.length ? "The applicable automatic check is missing." : results.length > 1 ? "Duplicate probe results are ambiguous." :
        "The applicable check is pending, incomplete, or has an unknown rating."}`;
      // A duplicate clear result must not hide an applicable native detection.
      if (policy && results.some(result => result.rating === 1)) failed++;
      continue;
    }
    const rating = results[0]!.rating;
    if (rating === 1) failed++;
    else if (rating === 0.5) advisory++;
    else clear++;
    details[name] = `${rating === 1 ? "FAIL" : rating === 0.5 ? "WARNING" : "PASS"}; ${statuses}` +
      (name === "platformMismatch" ? "; Firefox UA/platform comparison applies. Chromium client hints and color checks are not verified." : "");
  }
  const scored = clear + advisory + failed;
  const coverage = `${scored} applicable checks completed (${clear} clear, ${advisory} advisory, ${failed} detection).`;
  const partial = skipped || unverified ? ` Partial coverage: ${skipped} probes skipped, ${unverified} probes unverified. See per-probe reasons.` : "";
  details.coverage = coverage + partial;
  return {
    verdict: failed ? "FAIL" : incomplete || !scored ? "INCONCLUSIVE" : "PASS",
    reason: (failed ? "An applicable Rebrowser check reports native detection. " :
      incomplete || !scored ? "Applicable Rebrowser results are missing, pending, or unknown. " :
      "All applicable completed Rebrowser checks report no native detection. ") + coverage + partial,
    details,
    ...(warnings.length ? { warnings } : {}),
  };
}
