import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Carpeta de la landing estática (landing/ en la raíz del repo). */
export const LANDING_DIR = fileURLToPath(new URL("../landing/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/**
 * Sirve la landing en "/" y sus archivos (styles.css, assets/, vendor/...).
 * Devuelve false si la ruta no corresponde a un archivo de la landing,
 * para que el servidor siga con su 404 normal.
 */
export async function serveLanding(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  root: string = LANDING_DIR,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let relative: string;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (relative.includes("\0")) return false;
  if (relative === "/" || relative === "/index.html") relative = "/index.html";
  const type = TYPES[extname(relative).toLowerCase()];
  if (!type) return false;
  const base = resolve(root);
  const file = resolve(base, `.${relative}`);
  // Nada fuera de landing/ (evita ../ y similares).
  if (!file.startsWith(base + sep)) return false;
  let body: Buffer;
  try {
    body = await readFile(file);
  } catch {
    return false;
  }
  const isHtml = type.startsWith("text/html");
  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": body.length,
    "Cache-Control": isHtml ? "no-cache" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}
