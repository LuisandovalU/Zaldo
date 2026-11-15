/**
 * La cuenta de pruebas de pey, para cobrar en producción mientras Banxico
 * activa la cuenta propia (hasta 5 días hábiles).
 *
 * La documentación de pey (Create an API key → "Start testing right away") da
 * esta CLABE: se activa de inmediato y sirve para probar con montos como $0.01.
 * OJO: lo que se pague ahí NO se devuelve y NO llega al banco del negocio.
 *
 *   npm run pey:test-account             → dice qué haría, sin tocar nada
 *   npm run pey:test-account -- --go     → registra la cuenta con la llave del .env y prueba un QR de $0.01
 *   npm run pey:test-account -- <id>     → revisa una cuenta ya registrada y prueba el QR
 *
 * Al final imprime las dos variables que hay que poner en el servidor.
 */
import { loadEnvFile } from "../src/envFile.js";
import { PeyClient, PeyError } from "../src/pey.js";

const TEST_ACCOUNT = {
  alias: "Pruebas Zaldo",
  name: "Ramón Orraca Lascurain",
  clabe: "012180015826225713",
  entity: "PERSON" as const,
};

loadEnvFile();
const key = process.env.PEY_API_KEY?.trim() ?? "";
const base = (process.env.PEY_API_BASE?.trim() || "https://api.pey.mx").replace(/\/$/, "");
const args = process.argv.slice(2);
const go = args.includes("--go");
const given = args.find((arg) => !arg.startsWith("--")) ?? "";

if (!key) {
  console.error("Falta PEY_API_KEY en .env.");
  process.exit(1);
}

function explain(error: unknown): string {
  if (error instanceof PeyError) return `${error.type ?? error.status}: ${error.message} (requestId ${error.requestId ?? "—"})`;
  return error instanceof Error ? error.message : String(error);
}

const pey = new PeyClient(base, key);
let id = given;

if (!id && !go) {
  console.log(`Esto registraría en ${base}, bajo la llave del .env, la cuenta de pruebas de pey:`);
  console.log(`  CLABE ${TEST_ACCOUNT.clabe} · ${TEST_ACCOUNT.name}`);
  console.log("Lo que se pague a esa cuenta no se devuelve ni llega a tu banco: es solo para probar con $0.01.");
  console.log("Para hacerlo de verdad: npm run pey:test-account -- --go");
  process.exit(0);
}

if (!id) {
  try {
    const created = await pey.registerBankAccount(TEST_ACCOUNT);
    id = created.id;
    console.log(`Cuenta registrada: ${id} (estado ${created.codiStatus ?? "desconocido"})`);
  } catch (error) {
    console.error(`pey no registró la cuenta. ${explain(error)}`);
    process.exit(1);
  }
}

let status: string | null = null;
for (let attempt = 0; attempt < 6 && status !== "ACTIVE" && status !== "ERROR"; attempt++) {
  if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 5000));
  try {
    const account = await pey.bankAccount(id);
    if (!account) {
      console.error("Esa cuenta no existe o es de otra llave.");
      process.exit(1);
    }
    status = account.codiStatus;
    console.log(`Estado en Banxico: ${status}${account.errorMessage ? ` · ${account.errorMessage}` : ""}`);
  } catch (error) {
    console.error(`No pude leer la cuenta. ${explain(error)}`);
    process.exit(1);
  }
}
if (status !== "ACTIVE") {
  console.error("La cuenta todavía no está ACTIVE. Vuelve a correr: npm run pey:test-account -- " + id);
  process.exit(1);
}

try {
  const receiver = new PeyClient(base, key, fetch, { bankAccountId: id });
  const qr = await receiver.qr({
    amountCents: 1,
    concept: "Prueba Zaldo",
    numRef: "1234567",
    chargeId: "prueba-cuenta",
    expirationSec: 360,
  });
  console.log(`QR de $0.01 creado con esa cuenta (id ${qr.id}). pey ya deja cobrar.`);
} catch (error) {
  console.error(`La cuenta está activa, pero pey no dejó crear el cobro. ${explain(error)}`);
  process.exit(1);
}

console.log("\nPon estas dos variables en el servidor (y en tu .env) y vuelve a desplegar:");
console.log(`PEY_BANK_ACCOUNT_ID=${id}`);
console.log("PEY_TEST_MAX_MXN=1");
console.log("\nCuando Banxico active tu cuenta propia, quita las dos: los cobros irán a tu banco.");
