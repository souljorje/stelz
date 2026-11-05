import { useCallback, useEffect, useRef, useState } from "react";
import type { UiProfile } from "../../src/api/contracts.ts";
import type { UiTransfer, UiTransferImport } from "../../src/api/transfer-contracts.ts";
import { ApiError, errorMessage, request } from "./api.ts";

type Intent = { kind: "import"; file?: File } | { kind: "export"; profileIds: string[] };
type Operation = "creating" | "uploading" | "importing" | null;
const path = (id: string) => `/api/profile-transfers/${encodeURIComponent(id)}`;
const settled = (transfer: UiTransfer) => ["ready", "complete", "failed", "cancelled"].includes(transfer.phase);
const phaseOrder: Record<UiTransfer["phase"], number> = {
  awaiting_upload: 0, uploading: 1, snapshotting: 1, validating: 2, packing: 2,
  ready: 3, importing: 4, complete: 5, failed: 5, cancelled: 5,
};

export function exportUnavailable(profile: UiProfile): string | null {
  if (profile.pendingAction) return "Wait for the current service action to finish.";
  return profile.phase === "stopped" ? null : "Stop this profile cleanly before exporting.";
}

export function useTransfer() {
  const [kind, setKind] = useState<Intent["kind"] | null>(null);
  const [transfer, setTransfer] = useState<UiTransfer | null>(null);
  const [operation, setOperation] = useState<Operation>(null);
  const [closing, setClosing] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [pollVersion, setPollVersion] = useState(0);
  const [recovered, setRecovered] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const intent = useRef<Intent | null>(null);
  const current = useRef<UiTransfer | null>(null);
  const generation = useRef(0);
  const version = useRef(0);
  const working = useRef<Operation>(null);
  const closingRef = useRef(false);
  const closeRequested = useRef(false);
  const upload = useRef<AbortController | null>(null);
  const recoveryFlight = useRef<Promise<boolean> | null>(null);
  const recoveryKnown = useRef(false);
  const readCurrent = (): UiTransfer | null => current.current;

  const apply = useCallback((next: UiTransfer) => {
    if (current.current?.id === next.id && phaseOrder[next.phase] < phaseOrder[current.current.phase]) return;
    version.current += 1;
    current.current = next;
    setTransfer(next);
  }, []);
  const refreshStatus = useCallback(async () => {
    const active = current.current;
    if (!active) return;
    const run = generation.current, observed = version.current;
    try {
      const result = await request<{ transfer: UiTransfer }>(path(active.id));
      if (generation.current !== run || version.current !== observed) return;
      apply(result.transfer); setStatusError(""); setUncertain(false);
      if (["importing", "complete"].includes(result.transfer.phase)) setError("");
    } catch (cause) {
      if (generation.current === run && version.current === observed) {
        if (cause instanceof ApiError && cause.status === 404 && current.current) {
          apply({ ...current.current, phase: "failed", error: errorMessage(cause) });
          setUncertain(false); setStatusError(""); setError("");
        } else setStatusError(errorMessage(cause));
      }
    }
    if (generation.current === run) setPollVersion(value => value + 1);
  }, [apply]);
  const recover = useCallback((force = false): Promise<boolean> => {
    if (recoveryFlight.current) return recoveryFlight.current;
    if (!force && intent.current) return Promise.resolve(false);
    const run = generation.current;
    recoveryKnown.current = false;
    setRecovering(true); setRecoveryError("");
    const task = (async () => {
      try {
        const result = await request<{ transfers: UiTransfer[] }>("/api/profile-transfers");
        if (generation.current !== run) return false;
        recoveryKnown.current = true;
        const active = result.transfers[0];
        if (!active) return false;
        intent.current = active.kind === "import" ? { kind: "import" } : { kind: "export", profileIds: active.profileIds };
        setKind(active.kind); apply(active); setRecovered(true); setError(""); setStatusError("");
        return true;
      } catch (cause) {
        if (generation.current === run) {
          recoveryKnown.current = cause instanceof ApiError && cause.status === 404;
          setRecoveryError(errorMessage(cause));
        }
        return false;
      } finally {
        if (generation.current === run) setRecovering(false);
      }
    })();
    recoveryFlight.current = task;
    void task.finally(() => { if (recoveryFlight.current === task) recoveryFlight.current = null; });
    return task;
  }, [apply]);
  const markOperation = (next: Operation) => { working.current = next; setOperation(next); };
  const reset = () => {
    generation.current += 1;
    upload.current?.abort();
    upload.current = null;
    intent.current = null;
    current.current = null;
    working.current = null;
    closingRef.current = false;
    closeRequested.current = false;
    setKind(null); setTransfer(null); setOperation(null); setClosing(false); setUncertain(false);
    setError(""); setStatusError(""); setRecovered(false); setRecovering(false); setRecoveryError("");
  };

  const dismiss = async (): Promise<void> => {
    if (closingRef.current || working.current === "importing" || current.current?.phase === "importing" || uncertain) return;
    closeRequested.current = true;
    // Keep the creation response so its staging area can be removed by ID.
    if (!current.current && working.current === "creating") { setClosing(true); return; }
    if (!current.current) {
      const run = generation.current;
      closingRef.current = true; setClosing(true);
      await recover(true);
      if (generation.current !== run) return;
      closingRef.current = false; setClosing(false);
      const restored = readCurrent();
      if (restored) {
        if (restored.phase === "importing") { closeRequested.current = false; return; }
        await dismiss();
      } else if (recoveryKnown.current) reset();
      return;
    }
    closingRef.current = true; setClosing(true); setError("");
    const run = generation.current;
    try {
      const result = await request<{ transfer: UiTransfer }>(path(current.current.id), { method: "DELETE" });
      if (generation.current !== run) return;
      if (result.transfer.phase === "importing") {
        apply(result.transfer);
        closeRequested.current = false;
      } else reset();
    } catch (cause) {
      if (generation.current === run) {
        if (cause instanceof ApiError && cause.status === 404) { reset(); return; }
        closeRequested.current = false;
        setError(errorMessage(cause));
        await refreshStatus();
      }
    } finally {
      if (generation.current === run) { closingRef.current = false; setClosing(false); }
    }
  };

  const create = async (next: Intent) => {
    const run = ++generation.current;
    intent.current = next;
    current.current = null;
    recoveryKnown.current = false;
    closeRequested.current = false;
    setKind(next.kind); setTransfer(null); setError(""); setStatusError(""); setUncertain(false); setRecovered(false); setRecoveryError("");
    markOperation("creating");
    try {
      const result = await request<{ transfer: UiTransfer }>("/api/profile-transfers", {
        method: "POST", body: next.kind === "import" ? { kind: "import" } : next,
      });
      if (generation.current !== run) return;
      apply(result.transfer);
      if (closeRequested.current) {
        markOperation(null);
        await dismiss();
        return;
      }
      if (next.kind === "import" && next.file) {
        markOperation("uploading");
        const controller = new AbortController();
        upload.current = controller;
        const uploaded = await request<{ transfer: UiTransfer }>(`${path(result.transfer.id)}/archive`, {
          method: "PUT", file: next.file, signal: controller.signal, timeout: 0,
        });
        if (generation.current === run && !closingRef.current) apply(uploaded.transfer);
      }
    } catch (cause) {
      if (generation.current === run && !closingRef.current) {
        if (!current.current && await recover(true)) {
          if (closeRequested.current) {
            markOperation(null);
            if (readCurrent()?.phase === "importing") { closeRequested.current = false; setClosing(false); }
            else await dismiss();
          }
        } else if (generation.current === run) { setError(errorMessage(cause)); setClosing(false); }
      }
    } finally {
      if (generation.current === run) { upload.current = null; markOperation(null); }
    }
  };

  const beginImport = (file: File) => { if (!intent.current && !recoveryFlight.current) void create({ kind: "import", file }); };
  const beginExport = (profileIds: string[]) => { if (!intent.current && !recoveryFlight.current && profileIds.length) void create({ kind: "export", profileIds }); };

  const retry = async () => {
    const next = intent.current;
    if (!next || next.kind === "import" && !next.file || working.current || closingRef.current || current.current?.phase === "importing" || uncertain) return;
    const run = generation.current;
    closingRef.current = true; setClosing(true); setError("");
    try {
      if (current.current) {
        try {
          const result = await request<{ transfer: UiTransfer }>(path(current.current.id), { method: "DELETE" });
          if (generation.current !== run) return;
          if (result.transfer.phase === "importing") { apply(result.transfer); return; }
        } catch (cause) { if (!(cause instanceof ApiError && cause.status === 404)) throw cause; }
      }
      if (generation.current !== run) return;
      closingRef.current = false; setClosing(false);
      await create(next);
    } catch (cause) {
      if (generation.current === run) setError(errorMessage(cause));
    } finally {
      if (generation.current === run) { closingRef.current = false; setClosing(false); }
    }
  };

  const commit = async (input: UiTransferImport) => {
    const active = current.current;
    if (!active || active.phase !== "ready" || active.kind !== "import" || working.current || closingRef.current || uncertain) return;
    const run = generation.current;
    version.current += 1;
    markOperation("importing"); setError(""); setStatusError("");
    try {
      const result = await request<{ transfer: UiTransfer }>(`${path(active.id)}/import`, { method: "POST", body: input });
      if (generation.current === run) apply(result.transfer);
    } catch (cause) {
      if (generation.current !== run) return;
      setError(errorMessage(cause));
      // A lost response can still mean the atomic import has started.
      setUncertain(true);
      await refreshStatus();
    } finally {
      if (generation.current === run) markOperation(null);
    }
  };

  useEffect(() => {
    if (!transfer || closing || settled(transfer) && !(transfer.kind === "export" && transfer.phase === "ready") && !uncertain) return;
    const run = generation.current;
    const id = transfer.id;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    const poll = async () => {
      const observed = version.current;
      let delay = 750;
      try {
        const result = await request<{ transfer: UiTransfer }>(path(id), { signal: controller.signal });
        if (disposed || generation.current !== run || version.current !== observed || closingRef.current) return;
        const wasPreparing = current.current?.phase !== "ready";
        apply(result.transfer); setStatusError(""); setUncertain(false);
        if (["importing", "complete"].includes(result.transfer.phase) || wasPreparing && result.transfer.phase === "ready") setError("");
      } catch (cause) {
        if (!disposed && generation.current === run && version.current === observed) {
          if (cause instanceof ApiError && cause.status === 404 && current.current) {
            apply({ ...current.current, phase: "failed", error: errorMessage(cause) });
            setUncertain(false); setStatusError(""); setError("");
          } else setStatusError(errorMessage(cause));
        }
        delay = 3_000;
      } finally {
        if (!disposed && generation.current === run) timer = setTimeout(poll, delay);
      }
    };
    timer = setTimeout(poll, 400);
    return () => { disposed = true; clearTimeout(timer); controller.abort(); };
  }, [transfer?.id, transfer?.phase, closing, uncertain, pollVersion, apply]);

  useEffect(() => () => { generation.current += 1; upload.current?.abort(); }, []);

  const atomic = uncertain || operation === "importing" || transfer?.phase === "importing";
  const busy = kind !== null || recovering;
  const needsFile = kind === "import" && intent.current?.kind === "import" && !intent.current.file && ["awaiting_upload", "failed", "cancelled"].includes(transfer?.phase ?? "");
  useEffect(() => {
    if (!busy) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [busy]);

  return {
    kind, transfer, operation, closing, atomic, busy, error, statusError, recovered, recovering, recoveryError, needsFile,
    fileName: intent.current?.kind === "import" ? intent.current.file?.name ?? null : null,
    beginImport, beginExport, dismiss, retry, commit,
    recover,
    chooseFile: (file: File) => {
      if (kind !== "import" || working.current || closingRef.current || atomic) return;
      intent.current = { kind: "import", file };
      void retry();
    },
    refreshStatus: () => { void refreshStatus(); },
  };
}

export type TransferState = ReturnType<typeof useTransfer>;
