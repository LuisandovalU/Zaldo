import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/** promisify no conserva la sobrecarga con opciones, así que la envolvemos. */
function scrypt(
  password: string,
  salt: Buffer,
  keyLen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keyLen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Parámetros de scrypt. N=16384 tarda ~100 ms: suficiente contra fuerza bruta. */
const COST = { N: 16_384, r: 8, p: 1 };
const KEY_LEN = 32;
const SALT_LEN = 16;

/** Formato del hash: scrypt$N$r$p$saltBase64$keyBase64. Todo en una línea, cabe en un .env. */
export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error("La contraseña no puede estar vacía");
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LEN, COST);
  return [
    "scrypt",
    COST.N,
    COST.r,
    COST.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/**
 * Compara la contraseña con el hash guardado. Nunca lanza por un hash
 * malformado: devuelve false, para que un .env mal escrito no tumbe el login.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.trim().split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Un N absurdo desde el .env bloquearía el proceso; lo acotamos.
  if (N < 1_024 || N > 1_048_576 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = await scrypt(password.normalize("NFKC"), salt, expected.length, { N, r, p });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
