/**
 * Publica el bot de Zaldo en producción sin push ni deploy.
 *
 *   npm run zaldo:publish               → corre los tests, empaqueta src/core.ts y lo sube
 *   npm run zaldo:publish -- --no-test  → sin correr los tests antes
 *   npm run zaldo:status                → qué versión corre en producción
 *   npm run zaldo:rollback              → vuelve a la versión anterior
 *
 * Necesita en .env (o en el entorno):
 *   ZALDO_CORE_TOKEN  el mismo valor que tiene el servidor de ih0st.app
 *   ZALDO_CORE_URL    opcional; por defecto https://zaldo.ih0st.app/zaldo/core
 *
 * OJO: quien tenga ese token puede ejecutar código en el servidor. Guárdalo
 * como una contraseña y no lo compartas.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../src/envFile.js";
import { bundleCore } from "./bundle-core.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

loadEnvFile();
const token = process.env.ZALDO_CORE_TOKEN?.trim() ?? "";
const target = process.env.ZALDO_CORE_URL?.trim() || "https://zaldo.ih0st.app/zaldo/core";
const args = process.argv.slice(2);

if (!token) {
  console.error("Falta ZALDO_CORE_TOKEN en .env (el mismo valor que tiene el servidor).");
  process.exit(1);
}

async function call(method: "GET" | "PUT" | "DELETE", body?: Buffer, sha?: string): Promise<void> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(target, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/javascript", "x-zaldo-sha256": sha ?? "" } : {}),
      },
      body: body ? new Uint8Array(body) : undefined,
    });
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  const text = await res.text();
  if (res.status === 404) {
    console.error("✗ 404: el servidor no tiene ZALDO_CORE_TOKEN, o todavía no corre la versión que acepta publicar el bot.");
    process.exit(1);
  }
  let info: Record<string, unknown> = {};
  try {
    info = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* no era JSON */
  }
  if (!res.ok) {
    console.error(`✗ ${res.status} ${String(info.error ?? text).slice(0, 400)}`);
    process.exit(1);
  }
  if (info.ok === false) {
    console.error(`✗ Zaldo no está corriendo en el servidor: ${String(info.error ?? "sin detalle")}`);
    process.exit(1);
  }
  const origin = info.source === "bundle" ? "publicado" : "integrado en el servidor";
  console.log(`✓ En producción: ${String(info.build ?? "?")} (${origin}) · ${Date.now() - started} ms`);
  const versions = Array.isArray(info.versions) ? (info.versions as Record<string, unknown>[]) : [];
  for (const version of versions.slice(0, 5)) {
    console.log(`   #${String(version.id)} ${String(version.build ?? "")} ${String(version.sha ?? "").slice(0, 10)}`);
  }
}

if (args.includes("--status")) await call("GET");
else if (args.includes("--rollback")) await call("DELETE");
else {
  if (!args.includes("--no-test")) {
    // Con límite: unos tests colgados no deben dejar colgada la publicación.
    const tests = spawnSync("npm test", { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], shell: true, timeout: 180_000 });
    if (tests.status !== 0) {
      const why = tests.error ? "se pasaron de 3 minutos" : "no pasan";
      console.error(`✗ Los tests ${why}: no se publica. Corre npm test para ver cuál.`);
      process.exit(1);
    }
    console.log("✓ Tests");
  }
  const { code, sha, label } = await bundleCore();
  console.log(`✓ Paquete de ${Math.round(code.length / 1024)} KB · ${label}`);
  await call("PUT", code, sha);
}
