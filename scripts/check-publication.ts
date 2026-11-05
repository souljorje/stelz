import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseArguments, inspectReleaseCandidate } from "./release-candidate.ts";

export const MANUAL_WAIVER = { version: "0.2.1", approval: "release-owner-approved" } as const;
type Acceptance = {
  version: string; sha256: string; candidateRunId: string; candidateSourceCommit: string;
  platform: string; arch: string; result: string;
  checks: { integration: boolean; native: boolean; proxy: boolean; transfer: boolean; manual: boolean; ui: boolean };
  manualWaiver?: string;
};
export function validatePublication(candidate: { sha256: string; manifest: { version: string } }, evidence: Acceptance,
  input: { version?: string; sha256?: string; run?: string; tag?: string }) {
  if (!input.version || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(input.version)
    || !input.sha256 || !/^[a-f\d]{64}$/.test(input.sha256) || !input.run || !/^\d+$/.test(input.run)
    || !["latest", "next"].includes(input.tag || "")) throw Error("Supply a valid release version, SHA-256, candidate run, and npm tag.");
  if (candidate.sha256 !== input.sha256 || candidate.manifest.version !== input.version
    || evidence.sha256 !== input.sha256 || evidence.version !== input.version || evidence.candidateRunId !== input.run)
    throw Error("The requested release does not match the tested candidate.");
  const manualAccepted = evidence.checks?.manual === true || evidence.version === MANUAL_WAIVER.version
    && evidence.manualWaiver === MANUAL_WAIVER.approval;
  if (evidence.result !== "passed" || evidence.platform !== "darwin" || evidence.arch !== "arm64"
    || !/^[a-f\d]{40}$/.test(evidence.candidateSourceCommit)
    || !["integration", "native", "proxy", "transfer", "ui"].every(check => evidence.checks?.[check as keyof Acceptance["checks"]] === true)
    || !manualAccepted)
    throw Error("Complete macOS browser, native-profile, proxy, profile-transfer, and UI acceptance for this archive. Human takeover requires a pass or the approved 0.2.1 waiver.");
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, ".."), input = releaseArguments(process.argv.slice(2));
  if (!input.archive) throw Error("Use --archive FILE.");
  const candidate = inspectReleaseCandidate(input.archive), version = process.env.RELEASE_VERSION;
  if (!version || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(version)) throw Error("RELEASE_VERSION is invalid.");
  const evidence = JSON.parse(readFileSync(join(root, "release", `acceptance-${version}.json`), "utf8")) as Acceptance;
  validatePublication(candidate, evidence, { version, sha256: process.env.RELEASE_SHA256,
    run: process.env.RELEASE_CANDIDATE_RUN, tag: process.env.RELEASE_DIST_TAG });
  if (!process.env.GH_TOKEN) throw Error("The publishing job requires its read-only GitHub token.");
  const response = await fetch(`https://api.github.com/repos/souljorje/stelz/actions/runs/${evidence.candidateRunId}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "stelz-release" },
  });
  if (!response.ok) throw Error("Cannot verify the candidate workflow run.");
  const run = await response.json() as { conclusion: string; head_sha: string; path: string; repository: { private: boolean } };
  if (run.conclusion !== "success" || run.head_sha !== evidence.candidateSourceCommit
    || run.path !== ".github/workflows/prepare-release.yml" || run.repository.private)
    throw Error("The candidate must come from a successful public release-preparation workflow.");
  const diff = Bun.spawnSync(["git", "diff", "--exit-code", evidence.candidateSourceCommit, "HEAD", "--", ".", ":!release/"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (diff.exitCode) throw Error("Release source changed after the candidate was built. Prepare and test a new candidate.");
  console.log(JSON.stringify({ result: "passed", version, sha256: candidate.sha256, candidateRunId: evidence.candidateRunId }));
}
