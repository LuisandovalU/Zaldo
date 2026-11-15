import { authEnabled, type AuthConfig } from "./config.js";
import { hashPassword, verifyPassword } from "./password.js";
import { createSession, readSession, type Session } from "./session.js";
import { Throttle } from "./throttle.js";

export type LoginResult =
  | { ok: true; token: string; session: Session }
  | { ok: false; reason: "bad_credentials" }
  | { ok: false; reason: "locked"; retryAfterSec: number }
  | { ok: false; reason: "disabled" };

/** Hash de relleno: cuesta lo mismo que uno real, para no delatar al usuario inexistente. */
let decoyHash: Promise<string> | null = null;
function decoy(): Promise<string> {
  decoyHash ??= hashPassword("zaldo-usuario-inexistente");
  return decoyHash;
}

/**
 * Todo el login en un objeto. No conoce HTTP: recibe usuario, contraseña y
 * una clave de origen (la IP) y devuelve qué pasó. Así se prueba sin servidor.
 */
export class AuthService {
  private readonly throttle: Throttle;

  constructor(private readonly config: AuthConfig) {
    this.throttle = new Throttle(config.maxAttempts, config.lockoutMs);
  }

  get enabled(): boolean {
    return authEnabled(this.config);
  }

  get sessionTtlSec(): number {
    return Math.floor(this.config.sessionTtlMs / 1000);
  }

  get cookieSecure(): boolean {
    return this.config.cookieSecure;
  }

  get trustProxy(): boolean {
    return this.config.trustProxy;
  }

  async login(user: string, password: string, origin: string, now: number): Promise<LoginResult> {
    if (!this.enabled) return { ok: false, reason: "disabled" };

    const name = user.trim().toLocaleLowerCase("es-MX");
    // Frenamos por origen y por usuario: ni una IP ni una cuenta se machacan.
    const keys = [`ip:${origin}`, `user:${name}`];
    for (const key of keys) {
      const wait = this.throttle.retryAfterMs(key, now);
      if (wait > 0) return { ok: false, reason: "locked", retryAfterSec: Math.ceil(wait / 1000) };
    }

    const found = this.config.users.find((item) => item.user === name);
    // Sin usuario igual gastamos un scrypt, para que el tiempo no lo revele.
    const hash = found?.passwordHash ?? (await decoy());
    const matches = await verifyPassword(password, hash);

    if (!found || !matches) {
      for (const key of keys) this.throttle.fail(key, now);
      return { ok: false, reason: "bad_credentials" };
    }

    for (const key of keys) this.throttle.succeed(key);
    const { token, session } = createSession(
      this.config.sessionSecret,
      found.user,
      now,
      this.config.sessionTtlMs,
    );
    return { ok: true, token, session };
  }

  /** Lee la sesión de una cookie. null si no hay, no cuadra la firma o venció. */
  session(token: string | undefined, now: number): Session | null {
    if (!this.enabled) return null;
    return readSession(this.config.sessionSecret, token, now);
  }

  sweep(now: number): void {
    this.throttle.sweep(now);
  }
}
