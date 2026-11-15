import type { IncomingMessage, ServerResponse } from "node:http";
import { renderLoginPage } from "./loginPage.js";
import type { AuthService } from "./service.js";
import {
  buildCookie,
  clearCookie,
  csrfOk,
  newCsrfToken,
  parseCookies,
  CSRF_COOKIE,
  SESSION_COOKIE,
  type Session,
} from "./session.js";

const LOGIN_PATH = "/admin/login";
const LOGOUT_PATH = "/admin/logout";
const MAX_FORM_BYTES = 4 * 1024;

export interface AuthRouteDeps {
  auth: AuthService;
  now: () => number;
}

function html(res: ServerResponse, status: number, body: string, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  };
  if (cookies.length) headers["Set-Cookie"] = cookies;
  res.writeHead(status, headers);
  res.end(body);
}

function redirect(res: ServerResponse, to: string, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = { Location: to, "Cache-Control": "no-store" };
  if (cookies.length) headers["Set-Cookie"] = cookies;
  res.writeHead(303, headers);
  res.end();
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_FORM_BYTES) return null;
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** Solo rutas internas del panel: nada de "//evil.com" ni de otro host. */
export function safeNext(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (!value.startsWith("/admin")) return undefined;
  if (value.startsWith("//") || value.includes("\\")) return undefined;
  if (value.length > 200) return undefined;
  return value;
}

/**
 * La IP con la que frenamos los intentos. Detrás de un proxy (ih0st, Cloudflare)
 * el socket siempre es el del proxy, así que leemos el header solo si quien
 * despliega lo autorizó con ADMIN_TRUST_PROXY: si no, cualquiera se saltaría
 * el límite mandando un X-Forwarded-For inventado.
 */
function originOf(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return req.socket.remoteAddress ?? "desconocido";
}

/**
 * Exige sesión. Si hay, la devuelve; si no, manda al login (o 401 en JSON)
 * y devuelve null: quien llama solo tiene que cortar.
 */
export function requireSession(
  deps: AuthRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  wantsJson: boolean,
): Session | null {
  const cookies = parseCookies(req.headers.cookie);
  const session = deps.auth.session(cookies[SESSION_COOKIE], deps.now());
  if (session) return session;
  if (wantsJson) {
    res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "Sesión no válida." }));
    return null;
  }
  const next = safeNext(pathname);
  const target = next && next !== LOGIN_PATH ? `${LOGIN_PATH}?next=${encodeURIComponent(next)}` : LOGIN_PATH;
  redirect(res, target, [clearCookie(SESSION_COOKIE, deps.auth.cookieSecure)]);
  return null;
}

/**
 * Atiende /admin/login y /admin/logout. Devuelve true si se encargó de la
 * petición, para que el servidor siga con sus otras rutas cuando no.
 */
export async function handleAuthRoutes(
  deps: AuthRouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname.replace(/\/$/, "") || "/";
  const secure = deps.auth.cookieSecure;

  if (path === LOGIN_PATH && req.method === "GET") {
    const cookies = parseCookies(req.headers.cookie);
    // Con sesión viva, el login no tiene nada que preguntar.
    if (deps.auth.session(cookies[SESSION_COOKIE], deps.now())) {
      redirect(res, safeNext(url.searchParams.get("next")) ?? "/admin");
      return true;
    }
    const csrf = newCsrfToken();
    html(
      res,
      200,
      renderLoginPage({ csrfToken: csrf, next: safeNext(url.searchParams.get("next")) }),
      [buildCookie(CSRF_COOKIE, csrf, { secure, maxAgeSec: 1_800 })],
    );
    return true;
  }

  if (path === LOGIN_PATH && req.method === "POST") {
    const form = await readForm(req);
    const cookies = parseCookies(req.headers.cookie);
    const csrf = newCsrfToken();
    const freshCsrf = buildCookie(CSRF_COOKIE, csrf, { secure, maxAgeSec: 1_800 });

    if (!form) {
      html(res, 413, renderLoginPage({ csrfToken: csrf, error: "El formulario llegó demasiado grande." }), [freshCsrf]);
      return true;
    }
    const next = safeNext(form.get("next"));
    if (!csrfOk(cookies[CSRF_COOKIE], form.get("csrf") ?? undefined)) {
      html(
        res,
        403,
        renderLoginPage({ csrfToken: csrf, next, error: "La sesión del formulario caducó. Inténtalo otra vez." }),
        [freshCsrf],
      );
      return true;
    }

    const user = (form.get("user") ?? "").slice(0, 120);
    const password = (form.get("password") ?? "").slice(0, 200);
    const result = await deps.auth.login(user, password, originOf(req, deps.auth.trustProxy), deps.now());

    if (result.ok) {
      redirect(res, next ?? "/admin", [
        buildCookie(SESSION_COOKIE, result.token, { secure, maxAgeSec: deps.auth.sessionTtlSec }),
        clearCookie(CSRF_COOKIE, secure),
      ]);
      return true;
    }

    // Nunca decimos si falló el usuario o la contraseña.
    const message =
      result.reason === "locked"
        ? `Demasiados intentos. Espera ${Math.ceil(result.retryAfterSec / 60)} minuto(s).`
        : result.reason === "disabled"
          ? "El panel no tiene administradores configurados."
          : "Usuario o contraseña incorrectos.";
    const status = result.reason === "locked" ? 429 : 401;
    const extra = result.reason === "locked" ? { "Retry-After": String(result.retryAfterSec) } : {};
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": [freshCsrf],
      ...extra,
    });
    res.end(renderLoginPage({ csrfToken: csrf, next, error: message, user: user.trim() }));
    return true;
  }

  if (path === LOGOUT_PATH && (req.method === "POST" || req.method === "GET")) {
    if (req.method === "POST") {
      const form = await readForm(req);
      const cookies = parseCookies(req.headers.cookie);
      if (!form || !csrfOk(cookies[CSRF_COOKIE], form.get("csrf") ?? undefined)) {
        // Aun así cerramos: una salida fallida no debe dejar la sesión abierta.
        redirect(res, LOGIN_PATH, [clearCookie(SESSION_COOKIE, secure), clearCookie(CSRF_COOKIE, secure)]);
        return true;
      }
    }
    redirect(res, LOGIN_PATH, [clearCookie(SESSION_COOKIE, secure), clearCookie(CSRF_COOKIE, secure)]);
    return true;
  }

  return false;
}

export { CSRF_COOKIE, SESSION_COOKIE };
