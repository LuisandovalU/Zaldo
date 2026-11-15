/**
 * Empaqueta src/core.ts y todo lo que usa en un solo archivo CommonJS que no
 * depende de node_modules: es lo que `zaldo:publish` sube al servidor.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const ENTRY = fileURLToPath(new URL("../src/core.ts", import.meta.url));

/** "2026-11-15 02:40 UTC · a1b2c3d": se ve en /health y en zaldo:status. */
export function buildLabel(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "src"], { cwd: ROOT }).toString().trim();
    return `${stamp} UTC · ${sha}${dirty ? "+cambios" : ""}`;
  } catch {
    return `${stamp} UTC`;
  }
}

export async function bundleCore(label = buildLabel()): Promise<{ code: Buffer; sha: string; label: string }> {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    write: false,
    logLevel: "silent",
    legalComments: "none",
    define: { __ZALDO_BUILD__: JSON.stringify(label) },
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error("esbuild no devolvió el paquete");
  const code = Buffer.from(file.contents);
  return { code, sha: createHash("sha256").update(code).digest("hex"), label };
}
