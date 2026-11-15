import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "zaldo_admin";
export const CSRF_COOKIE = "zaldo_csrf";

export interface Session {
  /** Usuario admin dueño de la sesión. */
  user: string;
  /** Identificador de esta sesión, para los logs. */
  sid: string;
  /** Milisegundos epoch en que caduca. */
  expiresAt: number;
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Token de sesión: payloadBase64url.firmaBase64url. La firma cubre el payload. */
export function createSession(secret: string, user: string, now: number, ttlMs: number): { token: string; session: Session } {
  const session: Session = { user, sid: randomUUID(), expiresAt: now + ttlMs };
  const payload = b64url(JSON.stringify(session));
  return { token: `${payload}.${sign(secret, payload)}`, session };
}

/** Devuelve la sesión solo si la firma cuadra y no venció. Cualquier duda: null. */
export function readSession(secret: string, token: string | undefined, now: number): Session | null {
  if (!secret || !token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payload = token.slice(0, dot);
  const given = token.slice(dot + 1);
  const expected = sign(secret, payload);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.user !== "string" || typeof value.sid !== "string") return null;
  if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return null;
  if (value.expiresAt <= now) return null;
  return { user: value.user, sid: value.sid, expiresAt: value.expiresAt };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface CookieOptions {
  maxAgeSec?: number;
  secure: boolean;
  httpOnly?: boolean;
}

export function buildCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Strict"];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.maxAgeSec !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSec))}`);
  return parts.join("; ");
}

export function clearCookie(name: string, secure: boolean): string {
  return buildCookie(name, "", { maxAgeSec: 0, secure });
}

export function newCsrfToken(): string {
  return randomUUID();
}

/** El token del formulario tiene que ser igual al de la cookie. */
export function csrfOk(cookieToken: string | undefined, formToken: string | undefined): boolean {
  if (!cookieToken || !formToken) return false;
  const a = Buffer.from(cookieToken);
  const b = Buffer.from(formToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
