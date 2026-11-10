import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitFingerprint, initializedFingerprint, readFingerprintJournal, stageFingerprint, writeInitialized,
  type FingerprintOwner } from "../../src/browser/fingerprint-transaction.ts";

const engine = "a".repeat(64);
const pin = (width = 1440) => ({ version: 2, engineSha256: engine, config: {
  "navigator.userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0",
  "navigator.platform": "MacIntel", "screen.width": width,
} });
const owner = (attemptId = "attempt-a"): FingerprintOwner => ({ profileId: "profile-a", attemptId,
  browserInstanceId: `browser-${attemptId}`, configurationHash: "b".repeat(64), serverPid: process.pid });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "stelz-fingerprint-transaction-"));
  reservation(directory, owner());
  return { directory, close: () => rmSync(directory, { recursive: true, force: true }) };
}
function reservation(directory: string, current: FingerprintOwner) {
  writeFileSync(join(directory, "running.json"), JSON.stringify({ instanceId: current.attemptId,
    configurationHash: current.configurationHash, serverPid: current.serverPid }));
}

test("a crash before commit reuses the staged candidate without resampling", () => {
  const f = fixture();
  try {
    const first = stageFingerprint(f.directory, owner(), pin(), engine);
    assert.equal(existsSync(join(f.directory, "fingerprint.json")), false);
    reservation(f.directory, owner("attempt-b"));
    const recovered = stageFingerprint(f.directory, owner("attempt-b"), pin(1920), engine);
    assert.equal(recovered.id, first.id);
    assert.equal(recovered.candidate, first.candidate);
    assert.throws(() => commitFingerprint(f.directory, owner(), first.sha256), /reservation changed/);
    commitFingerprint(f.directory, recovered.owner, recovered.sha256);
    assert.equal(readFileSync(join(f.directory, "fingerprint.json"), "utf8"), first.candidate);
  } finally { f.close(); }
});

test("a stale service cannot stage or commit after its reservation changes", () => {
  const f = fixture();
  try {
    reservation(f.directory, owner("attempt-b"));
    assert.throws(() => stageFingerprint(f.directory, owner(), pin(), engine), /reservation changed/);
    assert.equal(readFingerprintJournal(f.directory), undefined);
    const staged = stageFingerprint(f.directory, owner("attempt-b"), pin(), engine);
    reservation(f.directory, owner("attempt-c"));
    assert.throws(() => commitFingerprint(f.directory, staged.owner, staged.sha256), /reservation changed/);
    assert.equal(existsSync(join(f.directory, "fingerprint.json")), false);
    assert.equal(readFingerprintJournal(f.directory)!.candidate, staged.candidate);
  } finally { f.close(); }
});

test("a crash after the exclusive link reconciles only the journal-owned inode", () => {
  const f = fixture();
  try {
    const first = stageFingerprint(f.directory, owner(), pin(), engine);
    const staged = join(f.directory, first.publication!.name), target = join(f.directory, "fingerprint.json");
    linkSync(staged, target);
    assert.equal(statSync(target).nlink, 2);
    reservation(f.directory, owner("attempt-b"));
    const recovered = stageFingerprint(f.directory, owner("attempt-b"), pin(1920), engine);
    assert.equal(statSync(target).nlink, 1);
    assert.equal(existsSync(staged), false);
    assert.equal(recovered.candidate, first.candidate);
    commitFingerprint(f.directory, recovered.owner, recovered.sha256);
    assert.equal(readFileSync(target, "utf8"), first.candidate);
  } finally { f.close(); }
});

test("a crash after link cleanup and before the marker retains the committed candidate", () => {
  const f = fixture();
  try {
    const first = stageFingerprint(f.directory, owner(), pin(), engine);
    commitFingerprint(f.directory, first.owner, first.sha256);
    reservation(f.directory, first.owner);
    assert.equal(initializedFingerprint(f.directory, first.owner, first.sha256), false);
    reservation(f.directory, owner("attempt-b"));
    const recovered = stageFingerprint(f.directory, owner("attempt-b"), pin(1920), engine);
    reservation(f.directory, recovered.owner);
    assert.equal(recovered.candidate, first.candidate);
    commitFingerprint(f.directory, recovered.owner, recovered.sha256);
    writeInitialized(f.directory, { instanceId: recovered.owner.attemptId, browserInstanceId: recovered.owner.browserInstanceId,
      configurationHash: recovered.owner.configurationHash, fingerprintSha256: recovered.sha256 });
    assert.equal(initializedFingerprint(f.directory, recovered.owner, recovered.sha256), true);
    assert.equal(initializedFingerprint(f.directory, first.owner, first.sha256), false);
  } finally { f.close(); }
});

test("existing valid pin bytes remain unchanged and invalid pins cause no journal", () => {
  const valid = fixture(), invalid = fixture();
  try {
    const bytes = JSON.stringify(pin(), null, 4) + "\n";
    writeFileSync(join(valid.directory, "fingerprint.json"), bytes);
    const staged = stageFingerprint(valid.directory, owner(), pin(1920), engine);
    commitFingerprint(valid.directory, staged.owner, staged.sha256);
    assert.equal(readFileSync(join(valid.directory, "fingerprint.json"), "utf8"), bytes);
    const corrupt = JSON.stringify({ ...pin(), version: 1 });
    writeFileSync(join(invalid.directory, "fingerprint.json"), corrupt);
    assert.throws(() => stageFingerprint(invalid.directory, owner(), pin(), engine), /pin\.version/);
    assert.equal(readFileSync(join(invalid.directory, "fingerprint.json"), "utf8"), corrupt);
    assert.equal(readFingerprintJournal(invalid.directory), undefined);
  } finally { valid.close(); invalid.close(); }
});

test("unrelated links and symlinks are not accepted as owned publication artifacts", () => {
  const hardlinked = fixture(), symlinked = fixture();
  try {
    const staged = stageFingerprint(hardlinked.directory, owner(), pin(), engine);
    const unrelated = join(hardlinked.directory, "other"), target = join(hardlinked.directory, "fingerprint.json");
    writeFileSync(target, staged.candidate);
    linkSync(target, unrelated);
    reservation(hardlinked.directory, owner("attempt-b"));
    assert.throws(() => stageFingerprint(hardlinked.directory, owner("attempt-b"), pin(), engine), /ownership/);
    assert.equal(existsSync(unrelated), true);
    const outside = join(symlinked.directory, "outside");
    writeFileSync(outside, JSON.stringify(pin()));
    symlinkSync(outside, join(symlinked.directory, "fingerprint.json"));
    assert.throws(() => stageFingerprint(symlinked.directory, owner(), pin(), engine), /Unsafe/);
    assert.equal(readFileSync(outside, "utf8"), JSON.stringify(pin()));
  } finally { hardlinked.close(); symlinked.close(); }
});
