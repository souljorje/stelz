import { expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationHash, type Profile } from "../../src/profiles/config.ts";
import { lock, processStart } from "../../src/runtime/runtime.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { UPSTREAM_VERSION } from "../../src/versions.ts";
import { createMockPackage } from "../helpers/mock-package.ts";

const bun = Bun.which("bun")!,
  stamp = processStart(process.pid)!;
const dead = 2147483647;
type Fixture = { home: string; idDir: string; profile: Profile } & ReturnType<typeof createMockPackage>;
function fixture(port = 19471): Fixture {
  const home = mkdtempSync(join(tmpdir(), "stelz-lifecycle-")),
    idDir = join(home, "profiles", "test");
  const profile: Profile = { id: "test", port };
  const packageFixture = createMockPackage(home);
  mkdirSync(idDir, { recursive: true });
  mkdirSync(join(home, "runtime"));
  const plugin = join(home, `runtime/camofox-${UPSTREAM_VERSION}/plugins/local-profile`);
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "index.js"), packageFixture.plugin);
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: [profile] }));
  writeFileSync(join(home, "runtime/versions.json"), "{}");
  writeFileSync(join(idDir, "access-key"), "test-key");
  return { home, idDir, profile, ...packageFixture };
}
function record(f: Fixture, overrides: Record<string, unknown> = {}) {
  const value = {
    version: 2,
    pid: process.pid,
    supervisorStart: stamp,
    serverPid: process.pid,
    serverStart: stamp,
    serverState: "started",
    instanceId: "test-instance",
    configurationHash: configurationHash(f.profile),
    port: f.profile.port,
    ...overrides,
  };
  writeFileSync(join(f.idDir, "running.json"), JSON.stringify(value));
  return value;
}
async function run(f: Fixture, ...args: string[]) {
  const child = Bun.spawn([bun, "--no-env-file", f.cli, ...args], {
    env: { ...process.env, STELZ_HOME: f.home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
async function runScript(f: Fixture, script: string) {
  const child = Bun.spawn([bun, "--no-env-file", "-e", script], {
    env: { ...process.env, STELZ_HOME: f.home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}
function dispose(f: Fixture) {
  rmSync(f.home, { recursive: true, force: true });
}
function ownedRecord(pid: number) {
  const start = processStart(pid);
  expect(start).toBeTruthy();
  return start!;
}

test("startup rejects a stale installed plugin before a proxied browser can launch", async () => {
    const f = fixture();
    try {
      const profile = { ...f.profile, proxyEnv: "UPGRADE_PROXY" };
      writeFileSync(join(f.home, "profiles.json"), JSON.stringify({ profiles: [profile] }));
      writeFileSync(join(f.home, "secrets.env"), "UPGRADE_PROXY=http://upgrade-user:upgrade-password@proxy.test:8080\n");
      writeFileSync(join(f.home, `runtime/camofox-${UPSTREAM_VERSION}/plugins/local-profile/index.js`),
        "export const proxied = process.env.STELZ_MODE === 'proxy';\n");
      const result = await run(f, "start", "test");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("installed browser plugin does not match");
      expect(result.stderr).toContain("stelz setup");
      expect(result.stderr).not.toContain("upgrade-password");
      expect(existsSync(join(f.idDir, "running.json"))).toBe(false);
    } finally { dispose(f); }
});

test("the supervisor rechecks installed plugin compatibility before spawning its server", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.home, `runtime/camofox-${UPSTREAM_VERSION}/plugins/local-profile/index.js`), "old plugin\n");
    const result = await runScript(f, `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const config = await import(${JSON.stringify(join(f.packageRoot, "src/profiles/config.ts"))});
      writeFileSync(join(config.dir('test'), 'running.json'), JSON.stringify({ version: 2, pid: 0, instanceId: 'reserved',
        serverState: 'not-started', configurationHash: config.configurationHash(config.profile('test')) }));
      process.argv = [process.execPath, 'supervisor', 'test', 'reserved'];
      try { await import(${JSON.stringify(join(f.packageRoot, "src/runtime/supervisor.ts"))}); }
      catch (error) { console.log(error.message); }
    `);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("installed browser plugin does not match");
    const reserved = JSON.parse(readFileSync(join(f.idDir, "running.json"), "utf8"));
    expect(reserved).toMatchObject({ pid: 0, instanceId: "reserved", serverState: "not-started" });
    expect(reserved).not.toHaveProperty("serverPid");
  } finally { dispose(f); }
});

test("an orphan is reported and blocks its own startup, setup, and recovery without contacting it", async () => {
  let calls = 0;
  const service = Bun.serve({
    port: 0,
    fetch() {
      calls++;
      return Response.json({ phase: "ready" });
    },
  });
  const f = fixture(service.port!);
  try {
    record(f, { pid: dead, supervisorStart: "dead" });
    const result = await run(f, "status", "test");
    expect(result.code).toBe(0);
    const status = JSON.parse(result.stdout);
    expect(status.phase).toBe("orphaned");
    expect(status.serverPid).toBe(process.pid);
    expect(status.ownership).toEqual({ supervisor: "missing", server: "owned" });
    const safety = await runScript(
      f,
      `import { running } from ${JSON.stringify(f.runtime)}; console.log(Boolean(running('test')));`,
    );
    expect(safety.stdout.trim()).toBe("true");
    expect((await run(f, "start", "test")).stderr).toContain("needs inspection");
    expect((await run(f, "setup")).stderr).toContain("orphaned");
    expect((await run(f, "recover", "test")).stderr).toContain("recorded process is live");
    expect((await run(f, "recheck", "test")).code).toBe(1);
    expect(calls).toBe(0);
  } finally {
    service.stop(true);
    dispose(f);
  }
});

test("reused and unverified PIDs are never controlled or signalled", async () => {
  let calls = 0;
  const service = Bun.serve({
    port: 0,
    fetch() {
      calls++;
      return Response.json({ phase: "ready" });
    },
  });
  const f = fixture(service.port!);
  try {
    record(f, { serverStart: `${stamp}-different` });
    expect(JSON.parse((await run(f, "status", "test")).stdout).ownership.server).toBe("different");
    expect((await run(f, "stop", "test")).stderr).toContain("cannot be verified");
    expect((await run(f, "recheck", "test")).code).toBe(1);
    expect(calls).toBe(0);
    record(f, { supervisorStart: undefined, serverStart: undefined });
    expect(JSON.parse((await run(f, "status", "test")).stdout).phase).toBe("ownership_unknown");
    expect((await run(f, "recover", "test")).stderr).toContain("ownership is unknown");
    expect((await run(f, "stop", "test")).code).toBe(1);
    expect(calls).toBe(0);
  } finally {
    service.stop(true);
    dispose(f);
  }
});

test("a changed configuration port cannot redirect control to another service", async () => {
  let intendedCalls = 0;
  let unrelatedCalls = 0;
  const intended = Bun.serve({
    port: 0,
    fetch() {
      intendedCalls++;
      return Response.json({ checked: true, profileId: "test", phase: "ready" });
    },
  });
  const unrelated = Bun.serve({
    port: 0,
    fetch() {
      unrelatedCalls++;
      return Response.json({ checked: true });
    },
  });
  const f = fixture(intended.port!);
  const client = new Client({ name: "port-test", version: "1" });
  try {
    record(f);
    writeFileSync(
      join(f.home, "profiles.json"),
      JSON.stringify({ profiles: [{ ...f.profile, port: unrelated.port }] }),
    );
    const result = await run(f, "recheck", "test");
    expect(result.code).toBe(0);
    expect(intendedCalls).toBe(1);
    expect(unrelatedCalls).toBe(0);
    const contractDir = join(f.home, "runtime/camofox-1.18.1/mcp/lib");
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, "tool-contracts.mjs"), `
      export const TOOL_DEFS = ["camofox_snapshot", "camofox_evaluate", "camofox_import_cookies"]
        .map(name => ({ name, description: name, inputSchema: { type: "object" } }));
    `);
    await client.connect(new StdioClientTransport({
      command: bun,
      args: ["--no-env-file", f.cli, "mcp", "--profile", "test"],
      env: { ...process.env, STELZ_HOME: f.home } as Record<string, string>,
    }));
    const listed = (await client.listTools()).tools.map(tool => tool.name);
    expect(listed).toContain("camofox_snapshot");
    expect(listed).toContain("profile_recheck");
    expect(listed).not.toContain("camofox_evaluate");
    expect(listed).not.toContain("camofox_import_cookies");
    expect((await client.callTool({ name: "profile_acquire", arguments: {} })).isError).not.toBe(true);
    expect((await client.callTool({ name: "profile_recheck", arguments: {} })).isError).not.toBe(true);
    expect((await client.callTool({ name: "profile_release", arguments: {} })).isError).not.toBe(true);
    expect(intendedCalls).toBe(4);
    expect(unrelatedCalls).toBe(0);
    expect((await run(f, "mcp", "--profile", "test", "--identity", "test")).code).toBe(1);
    expect(intendedCalls).toBe(4);
    expect(unrelatedCalls).toBe(0);
    expect((await run(f, "mcp", "--profile", "test", "--identity", "test")).stderr).toContain("stelz mcp --profile ID");
  } finally {
    await client.close();
    intended.stop(true);
    unrelated.stop(true);
    dispose(f);
  }
});

test("recovery archives only safe records and keeps profile data", async () => {
  const f = fixture();
  try {
    const data = join(f.idDir, "browser-data");
    mkdirSync(data);
    writeFileSync(join(data, "profile"), "keep");
    writeFileSync(join(f.idDir, "fingerprint.json"), "fingerprint");
    record(f, { pid: dead, supervisorStart: "old", serverPid: dead, serverStart: "old" });
    const results = await Promise.all([
      run(f, "recover", "test"),
      run(f, "recover", "test"),
      run(f, "recover", "test"),
    ]);
    expect(results.every((r) => r.code === 0)).toBe(true);
    const archives = readdirSync(f.idDir).filter((name) => name.startsWith("running.recovered-"));
    expect(archives).toHaveLength(1);
    expect(readFileSync(join(data, "profile"), "utf8")).toBe("keep");
    expect(readFileSync(join(f.idDir, "fingerprint.json"), "utf8")).toBe("fingerprint");
    expect(existsSync(join(f.idDir, "running.json"))).toBe(false);
    writeFileSync(
      join(f.idDir, "running.json"),
      JSON.stringify({ pid: dead, instanceId: "invalid", configurationHash: "" }),
    );
    expect((await run(f, "recover", "test")).stderr).toContain("invalid process record");
    expect(existsSync(join(f.idDir, "running.json"))).toBe(true);
    writeFileSync(join(f.idDir, "running.json"), "null");
    expect((await run(f, "recover", "test")).stderr).toContain("invalid process record");
  } finally {
    dispose(f);
  }
});

test("concurrent stale-lock recovery serializes across processes", async () => {
  const f = fixture(),
    lockFile = join(f.home, "profiles", "admission.lock"),
    events = join(f.home, "events");
  try {
    writeFileSync(lockFile, JSON.stringify({ pid: dead, token: "stale" }));
    const script = `import { lock } from ${JSON.stringify(f.runtime)}; import { appendFileSync } from 'node:fs';
      await lock(${JSON.stringify(lockFile)}, async () => { appendFileSync(${JSON.stringify(events)}, 'enter '+process.pid+'\\n'); await Bun.sleep(80); appendFileSync(${JSON.stringify(events)}, 'exit '+process.pid+'\\n'); });`;
    const results = await Promise.all(Array.from({ length: 6 }, () => runScript(f, script)));
    expect(results.map((r) => r.stderr)).toEqual(Array(6).fill(""));
    const lines = readFileSync(events, "utf8").trim().split("\n");
    expect(lines).toHaveLength(12);
    for (let i = 0; i < lines.length; i += 2) {
      expect(lines[i]).toStartWith("enter ");
      expect(lines[i + 1]).toBe(lines[i]!.replace("enter ", "exit "));
    }
    expect(existsSync(lockFile)).toBe(true);
  } finally {
    dispose(f);
  }
});

test("lock refuses symbolic and multiply linked files without modifying them", async () => {
  const f = fixture();
  const target = join(f.home, "target");
  try {
    writeFileSync(target, "untouched");
    const symbolic = join(f.home, "symbolic.lock");
    symlinkSync(target, symbolic);
    await expect(lock(symbolic, async () => {})).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("untouched");

    const linked = join(f.home, "linked.lock");
    linkSync(target, linked);
    await expect(lock(linked, async () => {})).rejects.toThrow("Invalid lock file");
    expect(readFileSync(target, "utf8")).toBe("untouched");
  } finally {
    dispose(f);
  }
});

test("lifecycle commands reject lock symlinks without overwriting configuration", async () => {
  for (const [command, name] of [
    ["start", "admission.lock"], ["stop", "admission.lock"], ["recover", "admission.lock"],
    ["stop", "test/lifecycle.lock"], ["recover", "test/lifecycle.lock"],
  ]) {
    const f = fixture();
    try {
      const target = join(f.home, "profiles.json");
      const before = readFileSync(target, "utf8");
      symlinkSync(target, join(f.home, "profiles", name!));
      expect((await run(f, command!, "test")).code).toBe(1);
      expect(readFileSync(target, "utf8")).toBe(before);
      expect(existsSync(join(f.idDir, "running.json"))).toBe(false);
    } finally { dispose(f); }
  }
});

test("a zombie server does not block recovery", async () => {
  const f = fixture();
  const library = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  // Execute the native child without returning into Bun's VM after fork.
  const script = `import {dlopen, FFIType, ptr} from 'bun:ffi';
    const libc=dlopen(${JSON.stringify(library)}, {
      posix_spawn:{args:Array(6).fill(FFIType.ptr),returns:FFIType.i32},
      waitpid:{args:[FFIType.i32,FFIType.ptr,FFIType.i32],returns:FFIType.i32}
    });
    const path=Buffer.from('/usr/bin/true\\0'), argv=new BigUint64Array([BigInt(ptr(path)),0n]);
    const env=new BigUint64Array([0n]), child=new Int32Array(1);
    const error=libc.symbols.posix_spawn(ptr(child),ptr(path),null,null,ptr(argv),ptr(env));
    if(error) throw Error('posix_spawn failed: '+error);
    const pid=child[0]; console.log(pid);
    await Bun.stdin.text();
    if(libc.symbols.waitpid(pid,null,0)!==pid) throw Error('waitpid failed');
    libc.close();`;
  const parent = Bun.spawn([bun, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  try {
    const output = await parent.stdout.getReader().read();
    const zombie = Number(new TextDecoder().decode(output.value).trim());
    expect(zombie).toBeGreaterThan(1);
    const deadline = Date.now() + 5000;
    let ready = false;
    while (Date.now() < deadline) {
      if (process.platform === "linux") {
        const stat = readFileSync(`/proc/${zombie}/stat`, "utf8");
        ready = stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
      } else ready = processStart(zombie) === undefined;
      if (ready) break;
      await Bun.sleep(10);
    }
    expect(ready).toBe(true);
    process.kill(zombie, 0);
    record(f, { pid: dead, supervisorStart: "dead", serverPid: zombie, serverStart: "old" });
    const report = JSON.parse((await run(f, "status", "test")).stdout);
    expect(report.ownership.server).toBe("missing");
    expect((await run(f, "recover", "test")).code).toBe(0);
  } finally {
    parent.stdin.end();
    const code = await parent.exited;
    dispose(f);
    expect(code).toBe(0);
  }
}, 15000);

test("recheck maps to the check endpoint and initialized verification failures complete startup", async () => {
  const calls: string[] = [];
  const service = Bun.serve({
    port: 0,
    async fetch(req) {
      calls.push(`${req.method} ${new URL(req.url).pathname}`);
      if (req.method === "POST") await Bun.sleep(120);
      return Response.json({ profileId: "test", phase: "verification_failed" });
    },
  });
  const f = fixture(service.port!);
  try {
    record(f);
    writeFileSync(join(f.idDir, "initialized.json"), JSON.stringify({ instanceId: "test-instance" }));
    const start = await run(f, "start", "test");
    expect(start.code).toBe(0);
    expect(JSON.parse(start.stdout).phase).toBe("verification_failed");
    const recheck = await run(f, "recheck", "test");
    expect(recheck.code).toBe(0);
    expect(calls).toContain("POST /local-profile/check");
  } finally {
    service.stop(true);
    dispose(f);
  }
});

test("stop and interventions use deadlines longer than the action deadline", async () => {
  const service = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname.endsWith("stop")) return new Promise<Response>(() => {});
      await Bun.sleep(100);
      return Response.json({ checked: true });
    },
  });
  const f = fixture(service.port!);
  try {
    record(f);
    const script = `import { stop, intervention } from ${JSON.stringify(f.runtime)};
      const original=AbortSignal.timeout.bind(AbortSignal), deadlines=[];
      AbortSignal.timeout=(ms)=>{deadlines.push(ms); return original(ms===75000 ? 300 : ms)};
      const checked=await intervention('test','check'); let error='';
      try { await stop('test') } catch (e) { error=e.message }
      console.log(JSON.stringify({deadlines, checked, error}));`;
    const result = await runScript(f, script);
    expect(result.code).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.deadlines).toEqual([75000, 75000]);
    expect(value.checked.checked).toBe(true);
    expect(value.error).toContain("timed out");
    expect(existsSync(join(f.idDir, "running.json"))).toBe(true);
  } finally {
    service.stop(true);
    dispose(f);
  }
});

test("stop signals only a reverified unresponsive orphan and recovery remains explicit", async () => {
  const f = fixture();
  const marker = join(f.home, "term"),
    script = `const {writeFileSync}=require('node:fs'); process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(marker)},'term'); process.exit(0)}); console.log('ready'); setInterval(()=>{},1000);`;
  const child = Bun.spawn([bun, "-e", script], { stdout: "pipe", stderr: "pipe" });
  try {
    await child.stdout.getReader().read();
    record(f, {
      pid: dead,
      supervisorStart: "dead",
      serverPid: child.pid,
      serverStart: ownedRecord(child.pid),
    });
    const result = await run(f, "stop", "test");
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(readFileSync(marker, "utf8")).toBe("term");
    expect(JSON.parse(result.stdout).phase).toBe("unclean");
    expect(existsSync(join(f.idDir, "running.json"))).toBe(true);
    expect((await run(f, "recover", "test")).code).toBe(0);
  } finally {
    if (processStart(child.pid)) child.kill();
    await child.exited;
    dispose(f);
  }
}, 20000);

for (const httpStatus of [401, 500]) test(`an HTTP ${httpStatus} error cannot authorize signalling an orphan`, async () => {
  const service = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => Response.json({ error: "ConnectionRefused", code: "ConnectionRefused" }, { status: httpStatus }) });
  const f = fixture(service.port!);
  const marker = join(f.home, "term");
  const script = `const {writeFileSync}=require('node:fs'); process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(marker)},'term'); process.exit(0)}); console.log('ready'); setInterval(()=>{},1000);`;
  const child = Bun.spawn([bun, "-e", script], { stdout: "pipe", stderr: "pipe" });
  try {
    await child.stdout.getReader().read();
    record(f, { pid: dead, supervisorStart: "dead", serverPid: child.pid, serverStart: ownedRecord(child.pid) });
    const result = await run(f, "stop", "test");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("stop request failed");
    expect(existsSync(marker)).toBe(false);
    expect(processStart(child.pid)).toBeTruthy();
    expect(existsSync(join(f.idDir, "running.json"))).toBe(true);
  } finally {
    child.kill(); await child.exited; service.stop(true); dispose(f);
  }
});

test("doctor and logs provide bounded operational output", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.idDir, "server.log"), Array.from({ length: 600 }, (_, n) => `line-${n}\n`).join(""));
    writeFileSync(join(f.idDir, "supervisor.log"), "one\ntwo\n");
    const result = await run(f, "logs", "test", "--lines", "2");
    const value = JSON.parse(result.stdout);
    expect(value.server).toBe("line-598\nline-599");
    expect(value.supervisor).toBe("one\ntwo");
    expect((await run(f, "logs", "test", "--lines", "501")).code).toBe(1);
    writeFileSync(join(f.idDir, "server.log"), "x".repeat(100000));
    expect(JSON.parse((await run(f, "logs", "test")).stdout).server.length).toBeLessThanOrEqual(65536);
    const report = JSON.parse((await run(f, "doctor", "test")).stdout);
    expect(report.initialized).toBe(true);
    expect(report.setup).toBe(true);
    expect(report.profiles[0].phase).toBe("stopped");
  } finally {
    dispose(f);
  }
});

test("a real supervisor crash leaves its server visible until explicit stop and recovery", async () => {
  const socket = Bun.serve({ port: 0, fetch: () => new Response() }),
    port = socket.port!;
  socket.stop(true);
  const f = fixture(port),
    upstream = join(f.home, "runtime", "camofox-1.18.1");
  mkdirSync(upstream, { recursive: true });
  writeFileSync(
    join(upstream, "server.js"),
    `const http=require('node:http'), fs=require('node:fs'), path=require('node:path');
    const status=path.join(process.env.STELZ_PROFILE_DIR,'status.json');
    fs.writeFileSync(status, JSON.stringify({profileId:'test',phase:'ready'}));
    const server=http.createServer((req,res)=>{
      res.setHeader('content-type','application/json');
      if(req.url==='/local-profile/stop'){res.end('{}');setTimeout(()=>process.kill(process.pid,'SIGTERM'),10);return}
      res.end(JSON.stringify(req.url==='/local-profile/status'?{profileId:'test',phase:'ready'}:{}));
    }).listen(Number(process.env.CAMOFOX_PORT),'127.0.0.1');
    process.on('SIGTERM',()=>{fs.writeFileSync(status,JSON.stringify({profileId:'test',phase:'stopped'}));server.close(()=>process.exit(0))});`,
  );
  let started: { pid: number; supervisorStart: string; serverPid: number; serverStart: string } | undefined;
  try {
    const start = await run(f, "start", "test");
    expect(start.code).toBe(0);
    expect(JSON.parse(start.stdout).phase).toBe("ready");
    started = JSON.parse(readFileSync(join(f.idDir, "running.json"), "utf8"));
    expect(processStart(started!.pid)).toBe(started!.supervisorStart);
    process.kill(started!.pid, "SIGKILL");
    for (let n = 0; n < 50 && processStart(started!.pid) === started!.supervisorStart; n++)
      await Bun.sleep(50);
    const report = JSON.parse((await run(f, "status", "test")).stdout);
    expect(report.phase).toBe("orphaned");
    expect(report.serverPid).toBe(started!.serverPid);
    expect((await run(f, "recover", "test")).code).toBe(1);
    expect((await run(f, "stop", "test")).code).toBe(0);
    expect((await run(f, "recover", "test")).code).toBe(0);
  } finally {
    if (started && processStart(started.pid) === started.supervisorStart)
      process.kill(started.pid, "SIGKILL");
    if (started && processStart(started.serverPid) === started.serverStart)
      process.kill(started.serverPid, "SIGKILL");
    dispose(f);
  }
}, 25000);
