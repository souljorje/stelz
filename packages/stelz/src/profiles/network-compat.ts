// Interpret legacy fields without migrating saved catalogs or changing launch hashes.
export function legacyConnectionMode(profile: object): "direct" | "proxy" | undefined {
  if (!Object.hasOwn(profile, "mode")) return undefined;
  const { mode } = profile as { mode?: unknown };
  if (mode !== "direct" && mode !== "proxy") throw Error("Legacy connection mode must be direct or proxy.");
  return mode;
}

export function hasProxy(profile: { proxyEnv?: string }): boolean {
  const legacy = legacyConnectionMode(profile);
  return legacy === "proxy" || legacy !== "direct" && profile.proxyEnv !== undefined;
}

export function withoutLegacyConnectionMode<T extends object>(profile: T): T {
  const copy = { ...profile };
  delete (copy as { mode?: unknown }).mode;
  return copy;
}
