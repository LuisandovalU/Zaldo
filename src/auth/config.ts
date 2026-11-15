export interface AdminUser {
  user: string;
  passwordHash: string;
}

export interface AuthConfig {
  /** Admins que pueden entrar. Vacío = el panel queda apagado. */
  users: AdminUser[];
  /** Llave para firmar la cookie de sesión. */
  sessionSecret: string;
  /** Vida de la sesión en milisegundos. */
  sessionTtlMs: number;
  /** Intentos fallidos seguidos antes de frenar a quien insiste. */
  maxAttempts: number;
  /** Cuánto dura ese freno. */
  lockoutMs: number;
  /** Marca la cookie como Secure. Falso solo sirve para probar en http local. */
  cookieSecure: boolean;
  /** Creer en X-Forwarded-For. Solo con un proxy de confianza delante. */
  trustProxy: boolean;
}

/**
 * Lee los admins de ADMIN_USERS: "ana:scrypt$...,luis:scrypt$...".
 * El hash trae "$" pero nunca ":" ni ",", así que partimos por el primer ":".
 */
export function parseAdminUsers(raw: string | undefined): AdminUser[] {
  const out: AdminUser[] = [];
  if (!raw?.trim()) return out;
  for (const chunk of raw.split(",")) {
    const entry = chunk.trim();
    if (!entry) continue;
    const colon = entry.indexOf(":");
    if (colon <= 0) continue;
    const user = entry.slice(0, colon).trim().toLocaleLowerCase("es-MX");
    const passwordHash = entry.slice(colon + 1).trim();
    if (!user || !passwordHash) continue;
    if (out.some((item) => item.user === user)) continue;
    out.push({ user, passwordHash });
  }
  return out;
}

function positive(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} tiene que ser un número positivo`);
  return value;
}

/**
 * Arma la configuración del login. No exige nada: sin ADMIN_USERS o sin
 * ADMIN_SESSION_SECRET el panel se apaga y el resto de Zaldo sigue corriendo.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const users = parseAdminUsers(env.ADMIN_USERS);
  const secret = env.ADMIN_SESSION_SECRET?.trim() ?? "";
  if (users.length > 0 && secret.length > 0 && secret.length < 32) {
    throw new Error("ADMIN_SESSION_SECRET necesita al menos 32 caracteres");
  }
  return {
    users,
    sessionSecret: secret,
    sessionTtlMs: positive("ADMIN_SESSION_HOURS", env.ADMIN_SESSION_HOURS, 8) * 3_600_000,
    maxAttempts: positive("ADMIN_MAX_ATTEMPTS", env.ADMIN_MAX_ATTEMPTS, 5),
    lockoutMs: positive("ADMIN_LOCKOUT_MINUTES", env.ADMIN_LOCKOUT_MINUTES, 15) * 60_000,
    cookieSecure: (env.ADMIN_COOKIE_SECURE?.trim().toLowerCase() ?? "true") !== "false",
    trustProxy: (env.ADMIN_TRUST_PROXY?.trim().toLowerCase() ?? "false") === "true",
  };
}

/** El panel solo se monta si hay admins y con qué firmar la sesión. */
export function authEnabled(config: AuthConfig): boolean {
  return config.users.length > 0 && config.sessionSecret.length >= 32;
}
