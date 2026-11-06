import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dir } from "../profiles/config.ts";
import { assertRunning, running, type Running } from "../runtime/runtime.ts";
import { ownership } from "../runtime/profile-process.ts";
import { CONTROL_PROTOCOL_VERSION } from "./control-protocol.ts";
import type { ControlTransport } from "./control-registry.ts";

type ServiceBinding = {
  readonly profileId: string;
  readonly instanceId: string;
  readonly record: Running;
  readonly address: string;
  readonly accessKey: string;
};
function identity(record: Running) {
  return JSON.stringify([record.version, record.pid, record.supervisorStart, record.serverPid, record.serverStart,
    record.instanceId, record.configurationHash, record.port, record.serverState]);
}
function assertCurrent(binding: ServiceBinding) {
  assertRunning(binding.profileId);
  const current = running(binding.profileId);
  if (!current || identity(current) !== identity(binding.record))
    throw Error("The recorded browser service changed. Release the old handle and acquire fresh control. Do not repeat an uncertain browser action.");
}
async function request(binding: ServiceBinding, action: string, body?: Record<string, unknown>) {
  assertCurrent(binding);
  const response = await fetch(`${binding.address}/local-profile/${action}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${binding.accessKey}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(body ? 120000 : 5000),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw Error(String(result.error || `Profile control returned ${response.status}.`));
  return result;
}

export const serviceTransport: ControlTransport<ServiceBinding> = {
  assertCurrent,
  ended(binding) {
    const { serverPid, serverStart } = binding.record;
    if (!serverPid || !serverStart) return false;
    const current = ownership(serverPid, serverStart);
    return current === "missing" || current === "different";
  },
  async bind(profileId) {
    assertRunning(profileId);
    const record = running(profileId);
    if (!record?.port || !record.serverPid || !record.serverStart)
      throw Error(`${profileId}: service ownership is unavailable. Run stelz doctor ${profileId}.`);
    const binding = { profileId, instanceId: "", record: Object.freeze({ ...record }),
      address: `http://127.0.0.1:${record.port}`, accessKey: readFileSync(join(dir(profileId), "access-key"), "utf8").trim() };
    const status = await request(binding, "status");
    if (status.controlProtocolVersion !== CONTROL_PROTOCOL_VERSION)
      throw Error(`${profileId}: incompatible control protocol. Explicitly stop running profiles before stelz setup. Then run stelz start ${profileId} before acquiring control.`);
    if (status.profileId !== profileId || typeof status.instanceId !== "string" || !status.instanceId)
      throw Error("The service identity does not match this profile. Inspect it with stelz doctor.");
    assertCurrent(binding);
    return Object.freeze({ ...binding, instanceId: status.instanceId });
  },
  request,
};
