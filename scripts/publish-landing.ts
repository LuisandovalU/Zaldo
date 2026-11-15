/**
 * Publica landing/ en zaldo.ih0st.app sin push ni deploy.
 *
 *   npm run landing:publish   → sube la carpeta una vez
 *   npm run landing:watch     → sube otra vez cada que guardas un archivo
 *
 * Necesita en .env (o en el entorno):
 *   ZALDO_PUBLISH_TOKEN  el mismo valor que tiene el servidor de ih0st.app
 *   ZALDO_PUBLISH_URL    opcional; por defecto https://zaldo.ih0st.app/zaldo/site
 *
 * Cada publicación reemplaza el sitio entero: lo que borres aquí deja de servirse.
 */
import { readdirSync, readFileSync, statSync, watch } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "../src/envFile.js";

const ROOT = fileURLToPath(new URL("../landing/", import.meta.url));
const EXTENSIONS = /\.(html|css|m?js|json|txt|xml|svg|png|jpe?g|gif|webp|avif|ico|woff2?|mp4|webm)$/i;

loadEnvFile();
const token = process.env.ZALDO_PUBLISH_TOKEN?.trim() ?? "";
const target = process.env.ZALDO_PUBLISH_URL?.trim() || "https://zaldo.ih0st.app/zaldo/site";
const watching = process.argv.includes("--watch");

if (!token) {
  console.error("Falta ZALDO_PUBLISH_TOKEN en .env (el mismo valor que tiene el servidor).");
  process.exit(1);
}

function collect(dir: string, out: { path: string; data: string }[] = []): { path: string; data: string }[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (EXTENSIONS.test(name)) {
      out.push({ path: relative(ROOT, full).split(sep).join("/"), data: readFileSync(full).toString("base64") });
    }
  }
  return out;
}

async function publish(): Promise<boolean> {
  const files = collect(ROOT);
  const started = Date.now();
  try {
    const res = await fetch(target, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`✗ ${res.status} ${text.slice(0, 300)}`);
      return false;
    }
    const body = JSON.parse(text) as { files: number; bytes: number };
    const kb = Math.round(body.bytes / 1024);
    console.log(`✓ ${body.files} archivos (${kb} KB) en ${Date.now() - started} ms → ${new URL("/", target).href}`);
    return true;
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

const ok = await publish();
if (!watching) process.exit(ok ? 0 : 1);

console.log(`Mirando ${ROOT} — guarda un archivo y se publica. Ctrl+C para salir.`);
let timer: NodeJS.Timeout | undefined;
let running = false;
let again = false;
async function run(): Promise<void> {
  if (running) {
    again = true;
    return;
  }
  running = true;
  await publish();
  running = false;
  if (again) {
    again = false;
    void run();
  }
}
watch(ROOT, { recursive: true }, (_event, name) => {
  if (name && String(name).split(/[\\/]/).some((part) => part.startsWith("."))) return;
  clearTimeout(timer);
  timer = setTimeout(() => void run(), 300);
});
