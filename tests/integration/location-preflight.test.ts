import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMockPackage } from "../helpers/mock-package.ts";
import { fixtureLocation, fixtureModel, managedFixture, geoipFixture } from "../helpers/geoip-fixture.ts";
import { UPSTREAM_VERSION } from "../../src/versions.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture(ipCode?: string) {
  const home = mkdtempSync(join(tmpdir(), "stelz-preflight-")); homes.push(home);
  const pkg = createMockPackage(home);
  const upstream = join(home, `runtime/camofox-${UPSTREAM_VERSION}`), directory = join(home, "profiles/test");
  mkdirSync(directory, { recursive: true }); mkdirSync(join(upstream, "plugins/local-profile"), { recursive: true });
  writeFileSync(join(directory, "access-key"), "fixture-access-key", { mode: 0o600 });
  mkdirSync(join(upstream, "mcp/lib"), { recursive: true });
  writeFileSync(join(upstream, "mcp/lib/tool-contracts.mjs"), 'export * from '+JSON.stringify(resolve("node_modules/@askjo/camofox-browser/mcp/lib/tool-contracts.mjs"))+';');
  writeFileSync(join(upstream, "plugins/local-profile/index.js"), pkg.plugin);
  writeFileSync(join(upstream, "server.js"), "throw Error('A blocked preflight must never launch this server');");
  fixtureLocation(home, pkg.packageRoot, ipCode);
  writeFileSync(join(home, "browser"), "fixture executable");
  writeFileSync(join(home, "application.ini"), "[App]\nVersion=156.0.1-beta.36\n");
  fixtureModel(join(home, "runtime/fpgen"));
  writeFileSync(join(home, "runtime/versions.json"), "{}");
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ profiles: [{ id: "test", port: 19378, proxyEnv: "TEST_PROXY" }] }));
  writeFileSync(join(home, "secrets.env"), "TEST_PROXY=http://fixture-user:fixture-password@proxy.test:8080\n", { mode: 0o600 });
  const env = { ...process.env, STELZ_HOME: home, CAMOUFOX_EXECUTABLE: join(home, "browser"), CAMOUFOX_FPGEN_DATA: join(home, "runtime/fpgen") };
  async function script(body: string) {
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      import {readFileSync,writeFileSync,rmSync,renameSync,mkdirSync} from 'node:fs';
      const runtime = await import(${JSON.stringify(pkg.runtime)});
      const location = await import(${JSON.stringify(join(pkg.packageRoot, "src/runtime/location-preflight.ts"))});
      const config = await import(${JSON.stringify(join(pkg.packageRoot, "src/profiles/config.ts"))});
      try { console.log(JSON.stringify(await (async()=>{${body}})())); }
      catch(e){ console.log(JSON.stringify({error:e.message,location:e.location})); }
    `], { env, stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, error).toBe(0); return JSON.parse(out);
  }
  async function cli(action: string) {
    const child = Bun.spawn([process.execPath, "--no-env-file", pkg.cli, action, "test", "--json"], { env, stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, error, code };
  }
  return { ...pkg, cliPath:pkg.cli, home, directory, upstream, env, script, cli };
}
for (const condition of ["missing", "corrupt", "incompatible", "incomplete"] as const) test(`${condition} data blocks UI, CLI and MCP before a process reservation`, async () => {
  const f = fixture('throw Error("No network call is allowed");');
  if (condition === "missing") rmSync(join(f.home, "runtime/geoip"), { recursive: true });
  else managedFixture(join(f.home, "runtime"), condition === "corrupt" ? Buffer.from("bad") : condition === "incompatible" ? geoipFixture(undefined, "GeoLite2-Country") : geoipFixture({ latitude: 0, longitude: 0 }, "GeoIP2-City"));
  const code = condition === "missing" ? "GEOIP_DATA_MISSING" : condition === "incompatible" ? "GEOIP_DATA_INCOMPATIBLE" : "GEOIP_DATA_INVALID";
  const result = await f.cli("start"); expect(result.code).toBe(1);
  expect(JSON.parse(result.error)).toMatchObject({ location: { code, browserStarted: false, nextAction: { command: "stelz setup" } } });
  const ui = await f.script(`
    const {createUiServer} = await import(${JSON.stringify(join(f.packageRoot, "src/api/ui-server.ts"))});
    const server = createUiServer({port:0, assets:{'/':{body:'test',type:'text/html'}}});
    try {
      const token = new URLSearchParams(new URL(server.launchUrl).hash.slice(1)).get('token');
      const session = await fetch(server.url+'/api/session',{method:'POST',headers:{Origin:server.url,'Content-Type':'application/json'},body:JSON.stringify({token})});
      const headers = {Origin:server.url,'Content-Type':'application/json',Cookie:session.headers.get('set-cookie').split(';')[0]};
      const state = await (await fetch(server.url+'/api/state',{headers})).json();
      const started = await fetch(server.url+'/api/profiles/test/actions',{method:'POST',headers,body:JSON.stringify({action:'start'})});
      return {profile:state.profiles[0],status:started.status,body:await started.json()};
    } finally {server.stop();}`);
  expect(ui.profile.location).toMatchObject({ status: "blocked", code });
  expect(ui).toMatchObject({ status: 409, body: { location: { code, browserStarted: false } } });
  const client = new Client({ name: "geoip-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--no-env-file", f.cliPath, "mcp"], env: f.env as Record<string, string>, stderr: "pipe" }));
    expect((await client.listTools()).tools).toHaveLength(18);
    const result = await client.callTool({ name: "profile_start", arguments: { profileId: "test" } });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({ location: { code, browserStarted: false } });
  } finally { await client.close(); }
  expect(existsSync(join(f.directory, "running.json"))).toBe(false);
  expect(JSON.stringify(ui) + result.error).not.toContain("fixture-password");
});

test("preflight persists useful results, refresh stays local, and resolved secret changes invalidate readiness", async () => {
  const f = fixture(`const fs=await import('node:fs');fs.appendFileSync(process.env.STELZ_HOME+'/calls','x');return '198.51.100.10';`);
  expect(await f.script(`return (await runtime.reportStatus('test')).location;`)).toMatchObject({ status: "not_checked" });
  expect(existsSync(join(f.home, "calls"))).toBe(false);
  expect((await f.cli("recheck")).code).toBe(0);
  expect(await f.script(`return (await runtime.reportStatus('test')).location;`)).toMatchObject({ status: "ready", browserStarted: false, timezone: "Europe/London", language: "en-GB", network: "passed", geoip: "passed", browser: "not_checked" });
  expect(readFileSync(join(f.home, "calls"), "utf8")).toBe("x");
  expect(await f.script(`process.env.TEST_PROXY='http://changed:secret@proxy.test:8080'; return (await runtime.reportStatus('test')).location;`)).toMatchObject({ status: "not_checked" });
  expect(existsSync(join(f.directory, "running.json"))).toBe(false);
});
test("the default policy reports a location conflict; the strict policy blocks conflicting or stale data before launch", async () => {
  const f = fixture();
  // The comparison database places the exit in another offset at city precision.
  managedFixture(join(f.home, "runtime"), undefined, geoipFixture({ latitude: 0, longitude: 0, time_zone: "Asia/Tokyo", accuracy_radius: 20 },
    "GeoLite2-City", { city: { geoname_id: 1 } }), new Date().toISOString());
  expect((await f.cli("recheck")).code).toBe(0);
  expect(await f.script(`return (await runtime.reportStatus('test')).location;`)).toMatchObject({ status: "ready", evidence: { source: "GeoIP AIO", stale: false,
    comparison: { source: "GeoLite2 City", result: "conflicting", timezone: "Asia/Tokyo", accuracyRadiusKm: 20, city: true } } });
  writeFileSync(join(f.home, "secrets.env"), readFileSync(join(f.home, "secrets.env"), "utf8") + "STELZ_LOCATION_POLICY=strict\n");
  const conflict = await f.cli("start"); expect(conflict.code).toBe(1);
  expect(JSON.parse(conflict.error)).toMatchObject({ location: { code: "LOCATION_CONFLICT", browserStarted: false, evidence: { comparison: { result: "conflicting" } } } });
  managedFixture(join(f.home, "runtime"));
  const stale = await f.cli("recheck"); expect(stale.code).toBe(1);
  expect(JSON.parse(stale.error)).toMatchObject({ location: { code: "GEOIP_DATA_STALE", nextAction: { command: "stelz setup" }, evidence: { stale: true } } });
  expect(existsSync(join(f.directory, "running.json"))).toBe(false);
});
for (const code of ["PROXY_AUTHENTICATION", "PROXY_UNREACHABLE", "IP_DETECTION_FAILED"] as const) test(`${code} remains specific and sanitized after a failed check`, async () => {
  const f = fixture(`throw Object.assign(Error('http://fixture-user:fixture-password@proxy.test:8080'),{code:${JSON.stringify(code)}});`);
  const checked = await f.cli("recheck"); expect(checked.code).toBe(1);
  expect(JSON.parse(checked.error)).toMatchObject({ location: { code, network: "failed", geoip: "not_checked", nextAction: { kind: code === "IP_DETECTION_FAILED" ? "check_again" : "edit_proxy" } } });
  expect(checked.error).not.toContain("fixture-password");
  expect(await f.script(`return (await runtime.reportStatus('test')).location;`)).toMatchObject({ code, status: "blocked" });
});

test("edits during preflight reject stale completion without replacing the current configuration", async () => {
  const f = fixture(`await new Promise(r=>setTimeout(r,100));return '198.51.100.10';`);
  const value = await f.script(`const pending=runtime.recheck('test');while(!config.json(config.dir('test')+'/location.json')?.result?.checkedAt)await Bun.sleep(5);process.env.TEST_PROXY='http://changed:secret@proxy.test:8080';
    try {await pending;} catch(e){return {failure:e.location,local:await location.profileLocation(config.profile('test'))};}`);
  expect(value.failure.code).toBe("LOCATION_INPUT_CHANGED"); expect(value.local.status).toBe("not_checked");
});

test("cancellation and the overall deadline end the preflight without a browser", async () => {
  const f = fixture(`await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true})});`);
  for (const mode of ["cancel", "timeout"]) {
    const result = await f.script(`const controller=new AbortController();
      ${mode === "cancel" ? "setTimeout(()=>controller.abort(),40);" : "const timeout=AbortSignal.timeout.bind(AbortSignal);AbortSignal.timeout=ms=>timeout(ms===30000?40:ms);"}
      const keepAlive=setInterval(()=>{},1000);try {await runtime.recheck('test',controller.signal);}finally{clearInterval(keepAlive);}`);
    expect(result.location.code).toBe(mode === "cancel" ? "PREFLIGHT_CANCELLED" : "PREFLIGHT_TIMEOUT");
  }
  expect(existsSync(join(f.directory, "running.json"))).toBe(false);
});

test("concurrent checks share one result and direct profiles never call the IP helper", async () => {
  const f = fixture(`const fs=await import('node:fs');fs.appendFileSync(process.env.STELZ_HOME+'/calls','x');await new Promise(r=>setTimeout(r,80));return '198.51.100.10';`);
  expect(await f.script(`return (await Promise.all([runtime.recheck('test'),runtime.recheck('test'),runtime.recheck('test')])).map(v=>v.location.status);`)).toEqual(["ready", "ready", "ready"]);
  expect(readFileSync(join(f.home, "calls"), "utf8")).toBe("x");
  writeFileSync(join(f.home, "profiles.json"), JSON.stringify({ profiles: [{ id: "test", port: 19378 }] }));
  expect(await f.script(`return (await runtime.recheck('test')).location;`)).toMatchObject({ status: "not_applicable" });
  expect(readFileSync(join(f.home, "calls"), "utf8")).toBe("x");
});

test("Start repeats network preflight after a green UI result", async () => {
  const f = fixture(`const fs=await import('node:fs'),file=process.env.STELZ_HOME+'/checked';if(fs.existsSync(file))throw Object.assign(Error('fixture-password'),{code:'PROXY_AUTHENTICATION'});fs.writeFileSync(file,'yes');return '198.51.100.10';`);
  expect((await f.cli("recheck")).code).toBe(0);
  const started = await f.cli("start"); expect(started.code).toBe(1);
  expect(JSON.parse(started.error)).toMatchObject({ location: { code: "PROXY_AUTHENTICATION", browserStarted: false } });
  expect(existsSync(join(f.directory, "running.json"))).toBe(false);
});

test("changed engine, integration, dataset and expected IP invalidate old green results", async () => {
  const f = fixture();
  for (const file of [join(f.home, "browser"), join(f.upstream, "lib/browser-identity.js")]) {
    expect((await f.cli("recheck")).code).toBe(0);
    writeFileSync(file, readFileSync(file, "utf8") + "\n// new version");
    expect(await f.script(`return (await runtime.reportStatus('test')).location;`)).toMatchObject({ status: "not_checked", valid: false });
  }
  expect((await f.cli("recheck")).code).toBe(0);
  managedFixture(join(f.home, "runtime"), geoipFixture({ latitude: 1, longitude: 0, time_zone: "Europe/London" }, "GeoIP2-City"));
  expect(await f.script(`return (await runtime.reportStatus('test')).location;`)).toMatchObject({ status: "not_checked" });
  const config = JSON.parse(readFileSync(join(f.home, "profiles.json"), "utf8")); config.profiles[0].expectedIPEnv = "EXPECTED_TEST";
  writeFileSync(join(f.home, "profiles.json"), JSON.stringify(config));
  writeFileSync(join(f.home, "secrets.env"), readFileSync(join(f.home, "secrets.env"), "utf8") + "EXPECTED_TEST=198.51.100.99\n");
  const checked = await f.cli("recheck"); expect(checked.code).toBe(1);
  expect(JSON.parse(checked.error)).toMatchObject({ location: { code: "EXPECTED_IP_MISMATCH", network: "passed", geoip: "not_checked" } });
});

test("the launch adapter applies checked options and closes a failed preparation without disabled GeoIP", async () => {
  const f = fixture(); expect((await f.cli("recheck")).code).toBe(0);
  const result = await f.script(`
    Object.defineProperty(process,'platform',{value:'darwin'});
    const {prepareProfileLaunch}=await import(${JSON.stringify(join(f.packageRoot, "src/browser/location-launch.ts"))});
    const path=config.dir('test')+'/location.json', record=JSON.parse(readFileSync(path,'utf8'));record.attemptId='attempt';
    Object.assign(process.env,{STELZ_PROFILE_DIR:config.dir('test'),STELZ_UPSTREAM:config.UPSTREAM,PROXY_HOST:'proxy.test',STELZ_START_ID:'attempt',STELZ_LOCATION_LAUNCH:JSON.stringify(record)});
    const options=await prepareProfileLaunch({proxy:{server:'http://proxy.test:8080'}},async options=>options);
    let terminated=false;process.kill=()=>{terminated=true;return true};
    try {await prepareProfileLaunch({proxy:{server:'http://proxy.test:8080'}},async()=>{throw Error('fixture-password')});}catch{}
    await Bun.sleep(40);
    return {options,terminated,result:JSON.parse(readFileSync(path,'utf8')).result};`);
  expect(result.options).toMatchObject({ geoip: false, ff_version: "156", i_know_what_im_doing: true, timezoneId: "Europe/London", config: { timezone: "Europe/London" } });
  expect(result).toMatchObject({ terminated: true, result: { code: "LOCATION_PREPARATION_FAILED", browserStarted: false, nextAction: { kind: "run_setup" } } });
  expect(JSON.stringify(result)).not.toContain("fixture-password");
});

test("a saved proxy profile without a state directory remains unchecked and can run preflight", async () => {
  const f = fixture(); rmSync(f.directory, { recursive: true });
  expect(await f.script(`return (await runtime.reportStatus('test')).location;`)).toMatchObject({ status: "not_checked", code: null });
  expect(existsSync(f.directory)).toBe(false);
  expect((await f.cli("recheck")).code).toBe(0);
});

test("the supervisor cleans its unlaunched reservation when a resolved secret disappears", async () => {
  const f = fixture(); expect((await f.cli("recheck")).code).toBe(0);
  const value = await f.script(`
    const path=config.dir('test'), record=JSON.parse(readFileSync(path+'/location.json','utf8'));record.attemptId='reserved';writeFileSync(path+'/location.json',JSON.stringify(record));
    writeFileSync(path+'/running.json',JSON.stringify({version:2,pid:0,instanceId:'reserved',serverState:'not-started',configurationHash:config.configurationHash(config.profile('test'))}));
    process.env.TEST_PROXY='';process.argv=[process.execPath,'supervisor','test','reserved'];
    try {await import(${JSON.stringify(join(f.packageRoot, "src/runtime/supervisor.ts"))});}catch{}
    return {location:JSON.parse(readFileSync(path+'/location.json','utf8')).result,stopped:JSON.parse(readFileSync(path+'/stopped.json','utf8')),running:JSON.parse(readFileSync(path+'/running.json','utf8'))};`);
  expect(value).toMatchObject({ location: { code: "LOCATION_INPUT_CHANGED", browserStarted: false }, stopped: { instanceId: "reserved" }, running: { serverState: "not-started" } });
  expect(value.running.serverPid).toBeUndefined();
});

test("stale Camofox integration blocks recheck before it can probe", async () => {
  const f = fixture('throw Error("Network probe must not run");');
  writeFileSync(join(f.upstream, "lib/browser-identity.js"), "if (hasProxy) return { permissions: ['geolocation'] };");
  expect(await f.script(`return (await runtime.reportStatus('test')).location;`)).toMatchObject({ code: "GEOIP_RUNTIME_MISSING", status: "blocked" });
  const checked = await f.cli("recheck"); expect(checked.code).toBe(1);
  expect(JSON.parse(checked.error)).toMatchObject({ location: { code: "GEOIP_RUNTIME_MISSING", nextAction: { command: "stelz setup" } } });
});
