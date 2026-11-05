import { readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export type PackedRelease = { filename: string; files: Array<{ path: string; size?: number }>; bundled?: string[] };

/** Bun understands its isolated workspace layout; npm inspects the resulting tarball. */
export async function packRelease(product: string, destination: string, options: {
  ignoreScripts?: boolean; env?: Record<string, string>;
} = {}): Promise<PackedRelease> {
  const manifest = JSON.parse(readFileSync(join(product, "package.json"), "utf8"));
  const filename = `${String(manifest.name).replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
  const archive = resolve(destination, filename);
  mkdirSync(destination, { recursive: true });
  async function run(args: string[], cwd: string) {
    const child = Bun.spawn(args, { cwd, env: options.env ?? process.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    if (code !== 0) throw Error(stderr || stdout || `${args[0]} exited ${code}.`);
    return stdout;
  }
  await run([process.execPath, "pm", "pack", "--quiet", "--filename", archive,
    ...(options.ignoreScripts ? ["--ignore-scripts"] : [])], product);
  const npm = Bun.which("npm");
  if (!npm) throw Error("npm is required to inspect the release tarball.");
  const metadata = JSON.parse(await run([npm, "pack", archive, "--dry-run", "--json", "--ignore-scripts"], resolve(destination))) as PackedRelease[];
  if (metadata.length !== 1 || metadata[0]?.filename !== filename || !Array.isArray(metadata[0].files))
    throw Error("npm returned invalid metadata for the release tarball.");
  return metadata[0];
}
