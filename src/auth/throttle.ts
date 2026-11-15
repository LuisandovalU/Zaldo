interface Attempt {
  fails: number;
  /** Mientras no pase este momento, no aceptamos más intentos. */
  lockedUntil: number;
}

/**
 * Cuenta intentos fallidos en memoria. Se reinicia al reiniciar el proceso:
 * es un freno contra fuerza bruta, no una bitácora.
 */
export class Throttle {
  private readonly attempts = new Map<string, Attempt>();

  constructor(
    private readonly maxAttempts: number,
    private readonly lockoutMs: number,
  ) {}

  /** Milisegundos que faltan para poder reintentar, o 0 si ya puede. */
  retryAfterMs(key: string, now: number): number {
    const entry = this.attempts.get(key);
    if (!entry) return 0;
    if (entry.lockedUntil > now) return entry.lockedUntil - now;
    if (entry.lockedUntil !== 0) {
      // Se cumplió el castigo: borrón y cuenta nueva.
      this.attempts.delete(key);
    }
    return 0;
  }

  fail(key: string, now: number): void {
    const entry = this.attempts.get(key) ?? { fails: 0, lockedUntil: 0 };
    entry.fails += 1;
    if (entry.fails >= this.maxAttempts) {
      entry.lockedUntil = now + this.lockoutMs;
      entry.fails = 0;
    }
    this.attempts.set(key, entry);
  }

  succeed(key: string): void {
    this.attempts.delete(key);
  }

  /** Suelta las entradas ya vencidas para que el mapa no crezca sin fin. */
  sweep(now: number): void {
    for (const [key, entry] of this.attempts) {
      if (entry.lockedUntil !== 0 && entry.lockedUntil <= now) this.attempts.delete(key);
    }
  }
}
