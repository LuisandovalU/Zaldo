/**
 * Genera el hash de una contraseña para pegarlo en ADMIN_USERS.
 *
 *   npm run admin:hash -- ana
 *
 * Pide la contraseña sin mostrarla y no la escribe en ningún archivo:
 * la contraseña en claro nunca toca el disco ni el historial de la terminal.
 */
import { createInterface } from "node:readline";
import { hashPassword } from "../src/auth/password.js";

function askHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  const output = process.stdout;
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input, output, terminal: true });
    // Tapamos el eco para que la contraseña no quede en pantalla.
    const hide = (chunk: string | Buffer, encoding?: BufferEncoding, cb?: () => void): boolean => {
      const text = typeof chunk === "string" ? chunk : chunk.toString(encoding ?? "utf8");
      if (text.includes(prompt)) return original.call(output, chunk as never, encoding as never, cb as never);
      if (cb) cb();
      return true;
    };
    const original = output.write.bind(output);
    output.write = hide as typeof output.write;
    rl.question(prompt, (answer) => {
      output.write = original;
      output.write("\n");
      rl.close();
      resolve(answer);
    });
    rl.on("error", (error) => {
      output.write = original;
      reject(error);
    });
  });
}

async function main(): Promise<number> {
  const user = (process.argv[2] ?? "").trim().toLocaleLowerCase("es-MX");
  if (!user || !/^[a-z0-9._-]{2,40}$/.test(user)) {
    console.error("Uso: npm run admin:hash -- <usuario>");
    console.error("El usuario admite letras, números, punto, guion y guion bajo (2 a 40).");
    return 1;
  }

  const password = await askHidden(`Contraseña para "${user}": `);
  if (password.length < 12) {
    console.error("Usa al menos 12 caracteres.");
    return 1;
  }
  const repeat = await askHidden("Repítela: ");
  if (password !== repeat) {
    console.error("No coinciden.");
    return 1;
  }

  const hash = await hashPassword(password);
  console.log("\nPega esto en tu .env (si ya hay admins, sepáralos con comas):\n");
  console.log(`ADMIN_USERS=${user}:${hash}`);
  console.log("\nY si aún no tienes secreto de sesión:\n");
  console.log(`ADMIN_SESSION_SECRET=${(await import("node:crypto")).randomBytes(32).toString("base64url")}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
