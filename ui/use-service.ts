import { useCallback, useEffect, useRef, useState } from "react";
import type { UiAction, UiProfile, UiProfileCreate, UiNetworkUpdate, UiSnapshot } from "../src/ui-types";
import { ApiError, errorMessage, profilePath, request } from "./api";
import { actionReason } from "./model";
import type { ShowProfileWindow } from "../src/profile-appearance";

export type Connection = "connecting" | "connected" | "offline" | "unauthorized" | "ending" | "ended";
export type Pending = { id: string; action: UiAction | "save" | "create" | "delete" | "show" } | null;
export const FRESH_FOR = 10_000;

export function useService(session: Promise<void>) {
  const [snapshot, setSnapshot] = useState<UiSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState("");
  const [lastGood, setLastGood] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [mutationVersion, setMutationVersion] = useState(0);
  const latest = useRef({ snapshot, connection, lastGood });
  const sessionReady = useRef(false);
  const flight = useRef<Promise<boolean> | null>(null);
  const mutationLock = useRef(false);
  const epoch = useRef(0);
  const failures = useRef(0);
  const mounted = useRef(true);
  const inactive = connection === "ending" || connection === "ended";

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const markConnection = useCallback((value: Connection) => {
    latest.current.connection = value;
    if (mounted.current) setConnection(value);
  }, []);

  const refresh = useCallback((): Promise<boolean> => {
    if (!sessionReady.current || !mounted.current) return Promise.resolve(false);
    if (flight.current) return flight.current;
    const currentEpoch = epoch.current;
    setRefreshing(true);
    const task = (async () => {
      try {
        const next = await request<UiSnapshot>("/api/state");
        if (!mounted.current || currentEpoch !== epoch.current) return false;
        const received = Date.now();
        latest.current = { snapshot: next, connection: "connected", lastGood: received };
        setSnapshot(next);
        setLastGood(received);
        markConnection("connected");
        setError("");
        failures.current = 0;
        return true;
      } catch (cause) {
        if (!mounted.current || currentEpoch !== epoch.current) return false;
        failures.current += 1;
        markConnection(cause instanceof ApiError && cause.status === 401 ? "unauthorized" : "offline");
        setError(errorMessage(cause));
        return false;
      } finally {
        if (mounted.current) setRefreshing(false);
      }
    })();
    flight.current = task;
    void task.finally(() => { if (flight.current === task) flight.current = null; });
    return task;
  }, [markConnection]);

  useEffect(() => {
    if (inactive) { sessionReady.current = false; return; }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollRun = 0;
    const tick = async () => {
      if (disposed || document.hidden || !sessionReady.current) return;
      const thisRun = ++pollRun;
      clearTimeout(timer);
      await refresh();
      if (disposed || thisRun !== pollRun || document.hidden || !sessionReady.current || latest.current.connection === "unauthorized") return;
      timer = setTimeout(tick, Math.min(30_000, 2_000 * 2 ** Math.min(failures.current, 4)));
    };
    const onVisibility = () => {
      pollRun += 1;
      clearTimeout(timer);
      if (!document.hidden) void tick();
    };
    const onOffline = () => {
      pollRun += 1;
      epoch.current += 1;
      markConnection("offline");
      setError("The connection is offline. Existing values remain visible.");
      clearTimeout(timer);
    };
    const onOnline = () => { void tick(); };
    void session.then(() => {
      if (disposed) return;
      sessionReady.current = true;
      void tick();
    }).catch((cause: unknown) => {
      if (disposed) return;
      markConnection(cause instanceof ApiError && cause.status === 401 ? "unauthorized" : "offline");
      setError(errorMessage(cause));
      // Read-only polling can reconnect after a temporary bootstrap failure.
      sessionReady.current = !(cause instanceof ApiError && cause.status === 401);
      if (sessionReady.current) timer = setTimeout(tick, 4_000);
    });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [session, refresh, markConnection, inactive]);

  const runMutation = useCallback(async <T,>(id: string, action: NonNullable<Pending>["action"], run: () => Promise<T>): Promise<T> => {
    const state = latest.current;
    if (state.connection !== "connected" || Date.now() - state.lastGood >= FRESH_FOR || document.hidden || mutationLock.current)
      throw new ApiError(409, "Refresh the connection and wait for the current action before making changes.");
    mutationLock.current = true;
    setPending({ id, action });
    epoch.current += 1;
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof ApiError && (cause.status === 0 || cause.status >= 500 || cause.status === 401)) {
        markConnection(cause.status === 401 ? "unauthorized" : "offline");
        if (mounted.current) setError(errorMessage(cause));
      }
      throw cause;
    } finally {
      epoch.current += 1;
      if (mounted.current) setMutationVersion((version) => version + 1);
      // An earlier poll cannot overwrite a mutation response. Only a new GET can refresh it.
      await flight.current;
      if (latest.current.connection !== "unauthorized") await refresh();
      mutationLock.current = false;
      if (mounted.current) setPending(null);
    }
  }, [markConnection, refresh]);

  const mutate = useCallback(async (id: string, action: UiAction | "save", update?: UiNetworkUpdate): Promise<UiProfile> => {
    const state = latest.current, profile = state.snapshot?.profiles.find(row => row.id === id);
    if (!profile || !state.snapshot) throw new ApiError(409, "This profile is no longer in the current state. Refresh before continuing.");
    const reason = action === "save"
      ? profile.phase !== "stopped" ? "Stop this profile before editing its network." : null
      : actionReason(profile, action, { snapshot: state.snapshot, connected: true, pending: mutationLock.current });
    if (reason) throw new ApiError(409, reason);
    if (action === "save" && !update) throw new ApiError(400, "Network settings are missing.");
    return runMutation(id, action, async () => {
      const result = await request<{ profile: UiProfile }>(`${profilePath(id)}/${action === "save" ? "network" : "actions"}`, {
        method: action === "save" ? "PUT" : "POST", body: action === "save" ? update : { action }, timeout: 120_000,
      });
      if (mounted.current && latest.current.snapshot) {
        const next = { ...latest.current.snapshot, profiles: latest.current.snapshot.profiles.map(row => row.id === id ? result.profile : row) };
        latest.current.snapshot = next; setSnapshot(next);
      }
      return result.profile;
    });
  }, [runMutation]);

  const changeCatalog = useCallback(async (action: "create" | "delete", input: UiProfileCreate): Promise<void> => {
    if (!latest.current.snapshot?.initialized) throw new ApiError(409, "Run stelz init first.");
    if (action === "delete" && latest.current.snapshot.profiles.find(row => row.id === input.id)?.phase !== "stopped")
      throw new ApiError(409, "Stop this profile cleanly before deleting it.");
    await runMutation(input.id, action, async () => {
      if (action === "create") {
        const result = await request<{ profile: UiProfile }>("/api/profiles", { method: "POST", body: input });
        if (mounted.current && latest.current.snapshot) {
          const next = { ...latest.current.snapshot, profiles: [...latest.current.snapshot.profiles, result.profile] };
          latest.current.snapshot = next; setSnapshot(next);
        }
      } else {
        await request(profilePath(input.id), { method: "DELETE", body: { revision: input.revision } });
        if (mounted.current && latest.current.snapshot) {
          const next = { ...latest.current.snapshot, profiles: latest.current.snapshot.profiles.filter(row => row.id !== input.id) };
          latest.current.snapshot = next; setSnapshot(next);
        }
      }
    });
  }, [runMutation]);

  const endSession = useCallback(async () => {
    const previous = latest.current.connection;
    if (!sessionReady.current || ["connecting", "unauthorized", "ending", "ended"].includes(previous))
      throw new ApiError(409, "Connect to the UI session before turning it off.");
    if (mutationLock.current) throw new ApiError(409, "Wait for the current UI operation before turning off the UI.");
    mutationLock.current = true;
    sessionReady.current = false;
    epoch.current += 1;
    markConnection("ending");
    try {
      await request("/api/shutdown", { method: "POST", body: {} });
      latest.current.snapshot = null;
      latest.current.lastGood = 0;
      if (mounted.current) { setSnapshot(null); setLastGood(0); setError(""); }
      markConnection("ended");
    } catch (cause) {
      markConnection(cause instanceof ApiError && cause.status === 401 ? "unauthorized"
        : cause instanceof ApiError && cause.status === 0 ? "offline" : previous);
      throw cause;
    } finally { mutationLock.current = false; }
  }, [markConnection]);

  const showWindow = useCallback(async (id: string, selection?: ShowProfileWindow) => {
    const profile = latest.current.snapshot?.profiles.find(row => row.id === id);
    if (!profile?.instanceId || !["ready", "paused", "verification_failed"].includes(profile.phase)) throw new ApiError(409, "Start the profile before selecting its window.");
    if (!profile.windowControls.available) throw new ApiError(409, profile.windowControls.reason || "Window controls are unavailable.");
    await runMutation(id, "show", () => request(profilePath(id) + "/window", {
      method: "POST", body: selection ?? { instanceId: profile.instanceId }, timeout: 80_000,
    }));
  }, [runMutation]);
  return { snapshot, connection, error, lastGood, refreshing, pending, mutationVersion, refresh, mutate, changeCatalog, endSession, showWindow };
}

export function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function useResource<T>(path: string, version: string | number, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const reload = useCallback(() => setRefreshVersion((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void request<T>(path, { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setData(next);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [path, version, refreshVersion, enabled]);
  return { data, error, loading, reload };
}
