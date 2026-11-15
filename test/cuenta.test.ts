import assert from "node:assert/strict";
import test from "node:test";
import type { Completer, ToolCall } from "../src/agent.js";
import type { AppConfig } from "../src/config.js";
import {
  accountLink,
  applyBankEvent,
  checkAccounts,
  handleAccountPage,
  LINK_TTL_MS,
  readAccountToken,
  takeNewAccounts,
  validClabe,
  type AccountDeps,
} from "../src/cuenta.js";
import { ackInbound, handleInbound, type FlowDeps, type PeyPort } from "../src/flows.js";
import type { Outbound } from "../src/inbound.js";
import { PeyError, type BankAccountInput, type BankAccountStatus } from "../src/pey.js";
import { memoryStore, type Store } from "../src/store.js";

const OWNER = "5215511111111";
const NOW = Date.parse("2026-11-14T18:00:00.000Z");
/** La CLABE de pruebas que publica la documentación de pey: su dígito verificador es válido. */
const CLABE = "012180015826225713";

function starts(actual: string, prefix: string): void {
  assert.equal(actual.slice(0, prefix.length), prefix);
}

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    openRouterKey: "test",
    openRouterModel: "test",
    transcribeModel: "test",
    peyKey: "test",
    peyWebhookSecret: "whsec_dGVzdA==",
    peyApiBase: "https://api.pey.mx",
    whatsappToken: "test",
    whatsappPhoneNumberId: "1",
    whatsappAppSecret: "appsecret",
    whatsappVerifyToken: "zaldo",
    allowedPhones: [],
    dailyCapCents: 500_000,
    publicBaseUrl: "https://zaldo.example",
    dataPath: "./data/zaldo.json",
    pushExpirationSec: 360,
    qrExpirationSec: 3600,
    confirmWindowMs: 15 * 60 * 1000,
    peyBankAccountId: "01PRUEBAS",
    testMaxCents: 100,
    ...over,
  };
}

interface FakePey extends PeyPort {
  registered: BankAccountInput[];
  status: BankAccountStatus;
  fail: unknown;
  qrs: { amountCents: number; bankAccountId?: string | null }[];
  pushes: { bankAccountId?: string | null }[];
}

function fakePey(): FakePey {
  return {
    registered: [],
    status: "PENDING",
    fail: null,
    qrs: [],
    pushes: [],
    async push(input) {
      this.pushes.push({ bankAccountId: input.bankAccountId });
      return { transactionId: "t1", codiId: "c" };
    },
    async qr(input) {
      this.qrs.push({ amountCents: input.amountCents, bankAccountId: input.bankAccountId });
      return { id: "idc", qrString: "{}" };
    },
    async link() {
      return { id: "l", url: "https://x" };
    },
    async registerBankAccount(input) {
      if (this.fail) throw this.fail;
      this.registered.push(input);
      return { id: `01CUENTA${this.registered.length}`, codiStatus: "PENDING" };
    },
    async bankAccount(id) {
      return { id, alias: null, name: null, clabeLast4: "5713", entity: "PERSON", codiStatus: this.status, errorMessage: this.status === "ERROR" ? "CLABE inexistente" : null, dateCreated: NOW };
    },
  };
}

let clock = NOW;
function setup(over: Partial<AppConfig> = {}): { store: Store; pey: FakePey; deps: AccountDeps; flow: FlowDeps } {
  clock = NOW;
  const store = memoryStore();
  const pey = fakePey();
  const cfg = config(over);
  const deps: AccountDeps = { store, config: cfg, pey, now: () => clock, botNumber: () => "5213300000000" };
  const flow: FlowDeps = {
    store,
    config: cfg,
    pey,
    complete: async () => ({ content: "hola", toolCalls: [] }),
    transcribe: async () => "",
    now: () => clock,
    renderQr: async () => Buffer.from("qr"),
  };
  return { store, pey, deps, flow };
}

const tokenOf = (link: string) => new URL(link).searchParams.get("t") ?? "";
const get = (deps: AccountDeps, token: string, extra: Record<string, string> = {}) =>
  handleAccountPage(deps, { method: "GET", query: { t: token, ...extra }, body: async () => Buffer.alloc(0) });
const post = (deps: AccountDeps, fields: Record<string, string>) =>
  handleAccountPage(deps, { method: "POST", query: {}, body: async () => Buffer.from(new URLSearchParams(fields).toString()) });

function calls(...list: [string, object][]): Completer {
  let step = 0;
  return async ({ messages }) => {
    step += 1;
    if (step === 1) {
      const toolCalls: ToolCall[] = list.map(([name, args], index) => ({ id: `c${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
      return { content: null, toolCalls };
    }
    return { content: messages.filter((message) => message.role === "tool").at(-1)?.content ?? "", toolCalls: [] };
  };
}

let seq = 0;
async function say(flow: FlowDeps, complete: Completer, text: string): Promise<Outbound[]> {
  flow.complete = complete;
  const messageId = `q${++seq}`;
  const handled = await handleInbound(flow, { type: "text", owner: OWNER, messageId, text });
  if (handled.claimed) ackInbound(flow.store, messageId);
  return handled.messages;
}
const textOf = (messages: Outbound[]) => {
  const first = messages[0];
  return !first ? "" : first.kind === "image" ? first.caption : first.text;
};

test("la CLABE se valida con su dígito verificador", () => {
  assert.equal(validClabe(CLABE), true);
  assert.equal(validClabe("012180015826225714"), false, "un dígito cambiado");
  assert.equal(validClabe("01218001582622571"), false, "17 dígitos");
  assert.equal(validClabe("0121800158262257133"), false, "19 dígitos");
  assert.equal(validClabe("01218001582622571a"), false);
  assert.equal(validClabe(""), false);
});

test("el enlace es de una persona, caduca y no se puede alterar", () => {
  const cfg = config();
  const link = accountLink(cfg, OWNER, NOW) ?? "";
  starts(link, "https://zaldo.example/cuenta?t=");
  const token = tokenOf(link);
  assert.equal(readAccountToken(cfg, token, NOW)?.owner, OWNER);
  assert.equal(readAccountToken(cfg, token, NOW + LINK_TTL_MS + 1), null, "caducó");
  // Cambiar el dueño dentro del enlace rompe la firma.
  const [payload, mac] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ o: "5215599999999", e: NOW + LINK_TTL_MS, n: "x" })).toString("base64url");
  assert.equal(readAccountToken(cfg, `${forged}.${mac}`, NOW), null);
  assert.equal(readAccountToken(cfg, `${payload}.${"A".repeat(43)}`, NOW), null);
  assert.equal(readAccountToken(cfg, payload ?? "", NOW), null);
  assert.equal(readAccountToken(cfg, "", NOW), null);
  // Otro servidor (otros secretos) no acepta el enlace.
  assert.equal(readAccountToken(config({ peyWebhookSecret: "otro" }), token, NOW), null);
  // Dos enlaces de la misma persona son distintos.
  assert.notEqual(accountLink(cfg, OWNER, NOW), link);
  assert.equal(accountLink(config({ publicBaseUrl: null }), OWNER, NOW), null);
});

test("la página registra la cuenta en pey y no guarda la CLABE", async () => {
  const { store, pey, deps } = setup();
  const token = tokenOf(accountLink(deps.config, OWNER, NOW) ?? "");

  const form = await get(deps, token);
  assert.equal(form.status, 200);
  assert.match(form.body, /¿En qué cuenta quieres recibir\?/);
  assert.match(form.body, /src="\/assets\/zaldo-cube\.png"/);
  assert.match(form.body, /name="referrer" content="no-referrer"/);
  assert.match(form.body, /Content-Security-Policy/);
  assert.doesNotMatch(form.body, /<script/i);

  // Lo que no pasa: nombre vacío, CLABE mal, sin aceptar.
  const ok = { t: token, name: "Isabel Veliz", entity: "PERSON", clabe: "0121 8001 5826 2257 13", ok: "1" };
  assert.match((await post(deps, { ...ok, name: " " })).body, /Escribe el nombre del titular/);
  const badClabe = await post(deps, { ...ok, clabe: "012180015826225714" });
  assert.equal(badClabe.status, 422);
  assert.match(badClabe.body, /Esa CLABE no es válida/);
  assert.doesNotMatch(badClabe.body, /012180015826225714/, "la CLABE no se repite en la página");
  assert.match((await post(deps, { ...ok, ok: "" })).body, /Falta confirmar que eres titular/);
  assert.equal(pey.registered.length, 0);

  // Un nombre con HTML no se ejecuta en la página.
  const xss = await post(deps, { ...ok, name: '<img src=x onerror="alert(1)">', clabe: "1" });
  assert.doesNotMatch(xss.body, /<img src=x/);

  // pey rechaza: se explica sin tirar el formulario.
  pey.fail = new PeyError("clabe is not valid", "INVALID_CLABE", 400, "r1");
  const quiet = console.error;
  console.error = () => {};
  assert.match((await post(deps, ok)).body, /pey no aceptó esa CLABE/);
  pey.fail = new PeyError("down", "SERVICE_UNAVAILABLE", 503, null);
  assert.equal((await post(deps, ok)).status, 503);
  console.error = quiet;
  pey.fail = null;

  const done = await post(deps, ok);
  assert.equal(done.status, 200);
  assert.match(done.body, /Listo, quedó registrada/);
  assert.match(done.body, /•••• 5713/);
  assert.match(done.body, /href="https:\/\/wa\.me\/5213300000000"/);
  assert.deepEqual(pey.registered, [{ alias: "Zaldo 5713", name: "Isabel Veliz", clabe: CLABE, entity: "PERSON" }]);

  // En el libro: el id de pey y los últimos 4. La CLABE completa no está en ningún lado.
  const bank = store.getProfile(OWNER).bank;
  assert.deepEqual([bank?.id, bank?.last4, bank?.holder, bank?.status], ["01CUENTA1", "5713", "Isabel Veliz", "PENDING"]);
  assert.equal(JSON.stringify(store.snapshot()).includes(CLABE), false);
  assert.equal(JSON.stringify(store.snapshot()).includes("0121800158"), false);

  // El enlace ya se usó: no sirve otra vez, ni para ver ni para mandar.
  assert.equal((await get(deps, token)).status, 410);
  assert.equal((await post(deps, ok)).status, 410);
  assert.equal(pey.registered.length, 1);

  // Un enlace vencido o inventado tampoco.
  clock = NOW + LINK_TTL_MS + 1000;
  const late = tokenOf(accountLink(deps.config, OWNER, NOW) ?? "");
  assert.equal((await get(deps, late)).status, 410);
  assert.equal((await get(deps, "basura")).status, 410);
  assert.equal((await handleAccountPage(deps, { method: "PUT", query: {}, body: async () => Buffer.alloc(0) })).status, 405);
});

test("con cuenta registrada: se le avisa, y al activarse cobra de verdad a su banco", async () => {
  const { store, pey, deps, flow } = setup();
  const never: Completer = async () => {
    throw new Error("el modelo no debió participar");
  };

  // El bot manda el enlace; la CLABE no se pide en el chat.
  const invite = textOf(await say(flow, calls(["connect_bank", {}]), "quiero recibir en mi banco"));
  starts(invite, "Para recibir tus cobros directo en tu banco, registra tu cuenta en esta página segura.");
  assert.match(invite, /https:\/\/zaldo\.example\/cuenta\?t=/);
  assert.match(invite, /No me mandes tu CLABE por el chat/);
  const token = tokenOf(invite.split("\n")[1] ?? "");
  await post(deps, { t: token, name: "Isabel Veliz", entity: "PERSON", clabe: CLABE, ok: "1" });

  // Se le avisa por WhatsApp una vez.
  assert.deepEqual(takeNewAccounts(store), [
    { owner: OWNER, text: "Recibí tu cuenta terminada en 5713. Banxico la activa en hasta 5 días hábiles; yo te aviso." },
  ]);
  assert.deepEqual(takeNewAccounts(store), []);
  starts(textOf(await say(flow, calls(["connect_bank", {}]), "registrar mi cuenta")), "Tu cuenta terminada en 5713 ya está registrada; Banxico la activa");

  // Mientras se activa: sigue en modo de prueba, a la cuenta de pruebas.
  starts(textOf(await say(flow, calls(["prepare_charge", { amount: 150 }]), "cobra 150")), "Esta caja está en modo de prueba");
  const cent = await say(flow, calls(["prepare_charge", { amount: 0.01 }]), "cobra 0.01");
  assert.match(textOf(cent), /Modo de prueba: el pago va a la cuenta de pruebas de pey/);
  await say(flow, never, "sí");
  assert.equal(pey.qrs[0]?.bankAccountId, undefined, "sin cuenta propia activa, va a la del servidor");

  // Sigue pendiente: la consulta no avisa nada.
  assert.deepEqual(await checkAccounts(deps), []);
  // Banxico la activa: pey avisa por webhook.
  const activated = applyBankEvent(store, { type: "bank.account.updated", bankAccountId: "01CUENTA1", codiStatus: "ACTIVE" });
  assert.equal(activated?.text, "Tu cuenta terminada en 5713 ya está activa en CoDi. Desde ahora tus cobros caen directo en tu banco.");
  assert.equal(applyBankEvent(store, { type: "bank.account.updated", bankAccountId: "01CUENTA1" }), null, "no se avisa dos veces");
  assert.equal(applyBankEvent(store, { type: "bank.account.updated", bankAccountId: "de-otro" }), null);
  assert.equal(applyBankEvent(store, { type: "codi.qr.payment_received" }), null);

  // Ya no hay modo de prueba para ella: cobra $150 y cae en SU cuenta.
  const real = await say(flow, calls(["prepare_charge", { amount: 150 }]), "cobra 150");
  assert.equal(textOf(real), "Cobro por $150.00\nLo paga: quien escanee el QR con la app de su banco\nPor: QR CoDi");
  await say(flow, never, "sí");
  assert.deepEqual(pey.qrs[1], { amountCents: 15_000, bankAccountId: "01CUENTA1" });
  assert.equal(store.listCharges(OWNER).at(-1)?.bankAccountId, "01CUENTA1");
  await say(flow, calls(["prepare_charge", { amount: 200, payerName: "Ana", payerPhone: "5522223333" }]), "cóbrale 200 a Ana 5522223333");
  await say(flow, never, "sí");
  assert.equal(pey.pushes[0]?.bankAccountId, "01CUENTA1");
  starts(textOf(await say(flow, calls(["account_status", {}]), "¿dónde cae mi dinero?")), "Tus cobros caen directo en tu cuenta terminada en 5713: activa en CoDi.");
  starts(textOf(await say(flow, calls(["connect_bank", {}]), "registrar mi cuenta")), "Tus cobros ya caen directo en tu cuenta terminada en 5713.");
  // Otra persona sigue en modo de prueba: la cuenta es de cada quien.
  flow.complete = calls(["prepare_charge", { amount: 150 }]);
  const other = await handleInbound(flow, { type: "text", owner: "5215522222222", messageId: "otra", text: "cobra 150" });
  starts(textOf(other.messages), "Esta caja está en modo de prueba");
});

test("sin webhook, la activación se consulta; y un error de Banxico se avisa", async () => {
  const { store, pey, deps } = setup();
  const token = tokenOf(accountLink(deps.config, OWNER, NOW) ?? "");
  await post(deps, { t: token, name: "Negocio SA", entity: "BUSINESS", clabe: CLABE, ok: "1" });
  assert.equal(pey.registered[0]?.entity, "BUSINESS");
  takeNewAccounts(store);

  pey.status = "PROCESSING";
  assert.deepEqual(await checkAccounts(deps), []);
  assert.equal(store.getProfile(OWNER).bank?.status, "PROCESSING");
  pey.status = "ACTIVE";
  const notices = await checkAccounts(deps);
  assert.equal(notices[0]?.text, "Tu cuenta terminada en 5713 ya está activa en CoDi. Desde ahora tus cobros caen directo en tu banco.");
  assert.deepEqual(await checkAccounts(deps), [], "activa: ya no se consulta");

  // Otra persona: Banxico la rechaza. Puede intentar con otra cuenta.
  const second = "5215533333333";
  const token2 = tokenOf(accountLink(deps.config, second, NOW) ?? "");
  await post(deps, { t: token2, name: "Luis", entity: "PERSON", clabe: CLABE, ok: "1" });
  takeNewAccounts(store);
  pey.status = "ERROR";
  const failed = await checkAccounts(deps);
  assert.equal(failed[0]?.owner, second);
  assert.equal(failed[0]?.text, 'Banxico no pudo activar tu cuenta terminada en 5713: CLABE inexistente. Dime "registrar mi cuenta" y lo intentamos con otra.');
  const retry = tokenOf(accountLink(deps.config, second, NOW) ?? "");
  assert.match((await get(deps, retry)).body, /¿En qué cuenta quieres recibir\?/);
  // Quien ya tiene una en buen estado ve su estado, no el formulario; puede pedir cambiarla.
  const again = tokenOf(accountLink(deps.config, OWNER, NOW) ?? "");
  assert.match((await get(deps, again)).body, /Tu cuenta ya está registrada/);
  assert.match((await get(deps, again, { cambiar: "1" })).body, /¿En qué cuenta quieres recibir\?/);
});
