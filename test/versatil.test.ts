import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, Completer, ToolCall } from "../src/agent.js";
import { corteText, nextOccurrence } from "../src/caja.js";
import type { AppConfig } from "../src/config.js";
import {
  ackInbound,
  applyPeyEvent,
  handleInbound,
  reconcilePending,
  runRecurring,
  takeExpired,
  type FlowDeps,
  type PeyPort,
} from "../src/flows.js";
import type { Outbound } from "../src/inbound.js";
import { PeyError, type PeyTransaction } from "../src/pey.js";
import { memoryStore, type Store } from "../src/store.js";


/** Como assert.ok(x.startsWith(y)), pero al fallar enseña lo que llegó (y no se cuelga bajo tsx). */
function starts(actual: string, prefix: string): void {
  assert.equal(actual.slice(0, prefix.length), prefix);
}

const OWNER = "5215511111111";
const NOW = Date.parse("2026-11-14T18:00:00.000Z"); // sábado 14 nov, 12:00 en CDMX
const DAY = 24 * 3_600_000;

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
    ...over,
  };
}

function call(name: string, args: object, id = "c1"): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** Un modelo de mentira: llama a esas herramientas y, si le regresan algo, lo repite. */
function calls(...list: [string, object][]): Completer {
  let step = 0;
  return async ({ messages }) => {
    step += 1;
    if (step === 1) {
      return { content: null, toolCalls: list.map(([name, args], index) => call(name, args, `call_${index}`)) };
    }
    const outputs = messages.filter((message) => message.role === "tool").map((message) => message.content ?? "");
    return { content: outputs.slice(-list.length).join("\n"), toolCalls: [] };
  };
}

function tx(id: string, amountCents: number, over: Partial<PeyTransaction> = {}): PeyTransaction {
  return {
    id,
    status: "PAID",
    amountCents,
    breakdown: null,
    currency: "MXN",
    paymentMethod: "CODI",
    payableType: "API_CODI_QR",
    payableId: null,
    description: null,
    applicationFeeCents: 0,
    dateCreated: NOW,
    datePaid: NOW + 60_000,
    chargeId: null,
    ...over,
  };
}

interface FakePey extends PeyPort {
  pushes: { phone: string; expirationSec: number; concept: string }[];
  qrs: { amountCents: number; expirationSec: number; concept: string }[];
  links: { amountCents: number; hasTip?: boolean }[];
  paidPushes: Set<string>;
  qrPayments: PeyTransaction[];
  rejectLongExpiry: boolean;
  fail: unknown;
}

function fakePey(): FakePey {
  return {
    pushes: [],
    qrs: [],
    links: [],
    paidPushes: new Set<string>(),
    qrPayments: [],
    rejectLongExpiry: false,
    fail: null,
    async push(input) {
      if (this.fail) throw this.fail;
      if (this.rejectLongExpiry && input.expirationSec > 360) {
        throw new PeyError("expiration must be at most 360", "INVALID_PARAMETER", 400, null);
      }
      this.pushes.push({ phone: input.phone, expirationSec: input.expirationSec, concept: input.concept });
      return { transactionId: `txn_${this.pushes.length}`, codiId: "codi" };
    },
    async qr(input) {
      this.qrs.push({ amountCents: input.amountCents, expirationSec: input.expirationSec, concept: input.concept });
      return { id: `idc_${this.qrs.length}`, qrString: "{}" };
    },
    async link(input) {
      this.links.push({ amountCents: input.amountCents, hasTip: input.hasTip });
      return { id: `link_${this.links.length}`, url: "https://app.mipey.mx/payment-link/x" };
    },
    async transaction(id) {
      return tx(id, 0, { status: this.paidPushes.has(id) ? "PAID" : "PENDING", payableType: "API_CODI_PN" });
    },
    async qrTransactions() {
      return { items: this.qrPayments, nextToken: null };
    },
    async transactionsByBankAccount() {
      return {
        items: [
          tx("t2", 15_000, { payableType: "API_CODI_PN", description: "uñas", datePaid: NOW + 2 * 3_600_000 }),
          tx("t1", 50_000, {
            payableType: "PAYMENT_LINK",
            breakdown: { baseCents: 45_000, tipCents: 5_000, feeCents: 350 },
            datePaid: NOW,
          }),
        ],
        nextToken: null,
      };
    },
    async transactionsByApiKey() {
      // Sin cuenta registrada por API, los pagos se leen por la llave: lo mismo.
      return this.transactionsByBankAccount!("");
    },
    async bankAccount(id) {
      return { id, alias: "Pruebas", name: "Negocio", clabeLast4: "5713", entity: "PERSON", codiStatus: "ACTIVE", errorMessage: null, dateCreated: NOW };
    },
  };
}

let seq = 0;
let clock = NOW;
function flow(store: Store, pey: PeyPort, over: Partial<AppConfig> = {}): FlowDeps {
  clock = NOW;
  return {
    store,
    config: config(over),
    pey,
    complete: async () => ({ content: "hola", toolCalls: [] }),
    transcribe: async () => "",
    now: () => clock,
    renderQr: async () => Buffer.from("qr"),
  };
}

/** Un mensaje que ya trae los montos de estas pruebas: la caja solo cobra cifras que la persona dijo. */
const SAID = "cobra 50, 75.50, 150, 200 y 500";

async function say(deps: FlowDeps, complete: Completer, text = SAID, owner = OWNER): Promise<Outbound[]> {
  deps.complete = complete;
  const messageId = `v${++seq}`;
  const handled = await handleInbound(deps, { type: "text", owner, messageId, text });
  if (handled.claimed) ackInbound(deps.store, messageId);
  return handled.messages;
}

function textOf(messages: Outbound[]): string {
  const first = messages[0];
  if (!first) return "";
  return first.kind === "image" ? first.caption : first.text;
}

/** La tarjeta de un cobro por confirmar. Si llegó otra cosa, el error enseña qué. */
function cardIn(messages: Outbound[]): Extract<Outbound, { kind: "buttons" }> {
  for (const message of messages) if (message.kind === "buttons") return message;
  throw new Error(`esperaba la tarjeta: ${textOf(messages)}`);
}

/** Lo que contestó la última herramienta, tal como quedó en la memoria (aunque a la persona le llegue otra cosa). */
function lastToolOutput(store: Store, owner = OWNER): string {
  const turns = store.recentTurns(owner);
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn?.role === "assistant") return turn.tools?.at(-1)?.output ?? "";
  }
  return "";
}

const never: Completer = async () => {
  throw new Error("el modelo no debió participar");
};

test("se cobra con solo el monto, y un cobro corregido reemplaza al anterior", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);

  const card = await say(deps, calls(["prepare_charge", { amount: 150 }]), "cobra 150");
  assert.equal(textOf(card), "Cobro por $150.00\nLo paga: quien escanee el QR con la app de su banco\nPor: QR CoDi");

  // "Mejor 200": el de 150 se descarta solo y solo queda uno por confirmar.
  await say(deps, calls(["prepare_charge", { amount: 200 }]), "mejor 200");
  assert.deepEqual(store.listCharges(OWNER).map((charge) => charge.status), ["cancelled", "awaiting_confirm"]);
  const sent = await say(deps, never, "confirmar");
  assert.equal(textOf(sent), "QR CoDi por $200.00. Se escanea desde la app del banco, en la opción CoDi. Vale 1 hora. Te aviso cuando caiga.");
  assert.deepEqual(pey.qrs, [{ amountCents: 20_000, expirationSec: 3600, concept: "Cobro" }]);
  // Un segundo "confirmar" ya no tiene nada que mandar.
  assert.match(textOf(await say(deps, never, "confirmar")), /No hay ningún cobro esperando confirmación/);
  assert.equal(pey.qrs.length, 1);

  const paid = applyPeyEvent(store, { type: "codi.qr.payment_received", codiQrId: "idc_1", transactionId: "T1" }, NOW);
  assert.equal(paid?.text, "Ya cayó: $200.00. Confirmado por CoDi.");

  // Un monto imposible lo dice la caja, tal cual.
  const huge = textOf(await say(deps, calls(["prepare_charge", { amount: 2_000_000 }]), "cobra 2,000,000"));
  starts(huge, "Ese monto no lo puedo cobrar");
  const capped = textOf(await say(deps, calls(["prepare_charge", { amount: 4900 }]), "cobra 4900"));
  starts(capped, "Ese monto pasa el tope de cobros de hoy: te quedan $4,800.00");
});

test("QR fijo de mostrador: no vence y cada pago cae como venta", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  const card = await say(deps, calls(["prepare_charge", { amount: 50, concept: "café", fixed: true, payerName: "Ana", method: "push" }]), "hazme un QR fijo de 50 para el café");
  assert.equal(
    textOf(card),
    "Cobro por $50.00\nConcepto: café\nLo paga: quien escanee el QR con la app de su banco\nPor: QR CoDi fijo (no vence y recibe varios pagos)",
  );
  const sent = await say(deps, never, "sí");
  assert.equal(sent[0]?.kind, "image");
  assert.match(textOf(sent), /^QR CoDi fijo por \$50\.00 · café\./);
  assert.match(textOf(sent), /No vence y sirve para muchos pagos/);
  assert.deepEqual(pey.qrs, [{ amountCents: 5_000, expirationSec: 0, concept: "café" }]);
  const qr = store.listCharges(OWNER)[0];
  assert.equal(qr?.expiresAt, null);

  // Dos clientes pagan el mismo QR: dos ventas. El mismo pago repetido no cuenta doble.
  const event = (transactionId: string) => ({ type: "codi.qr.payment_received", codiQrId: "idc_1", numRef: qr?.numRef, transactionId, amount: 50, datePaid: (NOW + 60_000) / 1000 });
  assert.equal(applyPeyEvent(store, event("T1"), NOW)?.text, "Ya cayó: $50.00 en tu QR fijo · café. Confirmado por CoDi.");
  assert.equal(applyPeyEvent(store, event("T1"), NOW), null);
  assert.ok(applyPeyEvent(store, event("T2"), NOW));

  // Sin webhook, la consulta a pey trae un tercero y no repite los dos que ya se contaron.
  pey.qrPayments = [tx("T3", 5_000), tx("T2", 5_000), tx("T1", 5_000)];
  const found = await reconcilePending(deps);
  assert.equal(found.length, 1);
  assert.deepEqual(await reconcilePending(deps), []);

  const sales = store.listCharges(OWNER).filter((charge) => charge.parentId === qr?.id);
  assert.equal(sales.length, 3);
  assert.ok(sales.every((sale) => sale.status === "paid" && !sale.reusable));
  // El QR sigue abierto, nunca vence, y no cuenta como alguien que debe.
  assert.equal(store.getCharge(qr?.id ?? "")?.status, "pending");
  assert.deepEqual(takeExpired(store, NOW + 400 * DAY), []);
  const corte = corteText(store, OWNER, "hoy", NOW + 120_000);
  assert.match(corte, /Ventas CoDi: \$150\.00 en 3 cobros \(ticket promedio \$50\.00\)/);
  assert.doesNotMatch(corte, /Por cobrar/);
  assert.equal(textOf(await say(deps, calls(["charge_status", {}]))), "QR fijo: $50.00 · café · activo · 3 pagos, $150.00");
  // Sus ventas no se comen el tope de cobros del día.
  assert.equal(store.confirmedCentsSince(OWNER, 0), 5_000);
});

test("QR de monto abierto: quien paga pone la cantidad", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  const card = await say(deps, calls(["prepare_charge", { openAmount: true, fixed: true }]), "un QR abierto para el mostrador");
  assert.equal(
    textOf(card),
    "Cobro con monto abierto\nLo paga: quien escanee el QR; escribe el monto en la app de su banco\nPor: QR CoDi fijo (no vence y recibe varios pagos)",
  );
  assert.match(textOf(await say(deps, never, "confirmar")), /^QR CoDi fijo de monto abierto\. Quien paga lo escanea/);
  assert.deepEqual(pey.qrs, [{ amountCents: 0, expirationSec: 0, concept: "Cobro" }]);
  const sale = applyPeyEvent(store, { type: "codi.qr.payment_received", codiQrId: "idc_1", transactionId: "T9", amount: 75.5 }, NOW);
  assert.equal(sale?.text, "Ya cayó: $75.50 en tu QR fijo. Confirmado por CoDi.");

  // De un solo uso: al pagarse toma el monto que puso el cliente.
  await say(deps, calls(["prepare_charge", { openAmount: true }]), "un QR sin monto");
  await say(deps, never, "confirmar");
  const once = applyPeyEvent(store, { type: "codi.qr.payment_received", codiQrId: "idc_2", transactionId: "T10", amount: 120 }, NOW);
  assert.equal(once?.text, "Ya cayó: $120.00. Confirmado por CoDi.");

  // En modo de prueba no: no se podría topar lo que paguen, y ese dinero no se devuelve.
  const test = flow(memoryStore(), fakePey(), { testMaxCents: 100 });
  const refused = textOf(await say(test, calls(["prepare_charge", { openAmount: true }]), "un QR abierto"));
  starts(refused, "En modo de prueba no hago QR de monto abierto");
});

test("link de pago con propina", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  const card = await say(deps, calls(["prepare_charge", { amount: 500, concept: "cena", tip: true }]), "link de 500 de la cena, con propina");
  assert.match(textOf(card), /Por: link de pago, con opción de propina$/);
  const sent = textOf(await say(deps, never, "confirmar"));
  assert.match(sent, /^Link para pagar \$500\.00 · cena \(CoDi o tarjeta, con opción de propina\):\nhttps:\/\//);
  assert.deepEqual(pey.links, [{ amountCents: 50_000, hasTip: true }]);
  const charge = store.listCharges(OWNER)[0];
  const paid = applyPeyEvent(
    store,
    {
      type: "payment_link.status_updated",
      status: "paid",
      clientReferenceId: charge?.id,
      transactions: [{ transactionId: "L1", datePaid: NOW / 1000, amount: 553.5, amountBreakdown: { base: 500, tip: 50, fee: 3.5 } }],
    },
    NOW,
  );
  assert.equal(paid?.text, "Ya cayó: $500.00 · cena. Confirmado por CoDi. Más $50.00 de propina.");
  assert.match(corteText(store, OWNER, "hoy", NOW + 1), /Propinas: \$50\.00 \(aparte de lo vendido\)/);
});

test("cobro recurrente: se confirma una vez y después sale solo", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);

  // Sin celular no hay recurrente: cada periodo le llega la notificación a su banco.
  const ask = textOf(await say(deps, calls(["prepare_charge", { amount: 500, every: "mensual" }]), "cobra 500 cada mes"));
  starts(ask, "Para un cobro recurrente necesito el celular del cliente");

  const card = await say(
    deps,
    calls(["prepare_charge", { amount: 500, concept: "renta", payerName: "Ana", payerPhone: "5522223333", every: "mensual" }]),
    "cóbrale 500 de renta a Ana cada mes, su cel es 5522223333",
  );
  assert.equal(
    textOf(card),
    "Cobro por $500.00\nConcepto: renta\nLe llega a: Ana · 55 2222 3333, en la app de su banco\nPor: notificación CoDi\nSe repite: cada mes, solo. El siguiente, el 14 dic.",
  );
  assert.equal(store.listRecurrings(OWNER).length, 0, "nada queda programado antes de confirmar");
  const sent = textOf(await say(deps, never, "confirmar"));
  assert.match(sent, /Queda como cobro recurrente: se lo mando solo cada mes; el siguiente, el 14 dic\./);
  const plan = store.listRecurrings(OWNER)[0];
  assert.equal(plan?.nextAt, Date.parse("2026-12-14T18:00:00.000Z"));
  assert.equal(pey.pushes.length, 1);

  const list = textOf(await say(deps, calls(["list_recurring", {}])));
  assert.equal(list, "Tus cobros recurrentes\nAna · $500.00 cada mes · renta · siguiente 14 dic");

  // Antes de la fecha no sale nada.
  clock = NOW + 29 * DAY;
  assert.deepEqual(await runRecurring(deps), []);
  // El primero se pagó. Llega la fecha: sale solo, con un día para aceptarlo, y avisa.
  const first = store.listCharges(OWNER)[0];
  if (first) store.updateCharge({ ...first, status: "paid", paidAt: NOW });
  clock = Date.parse("2026-12-14T18:00:30.000Z");
  const notices = await runRecurring(deps);
  assert.equal(notices.length, 1);
  assert.equal(
    notices[0]?.text,
    "Cobro recurrente: Le mandé a Ana su cobro mensual de $500.00 · renta. Tiene 24 horas para aceptarlo en la app de su banco. Te aviso cuando caiga. El siguiente, el 14 ene.",
  );
  assert.deepEqual(pey.pushes[1], { phone: "5522223333", expirationSec: 86_400, concept: "renta" });
  const second = store.listCharges(OWNER).at(-1);
  assert.deepEqual([second?.status, second?.recurringId, second?.expiresAt], ["pending", plan?.id, clock + 86_400_000]);
  assert.deepEqual(await runRecurring(deps), [], "no se manda dos veces el mismo periodo");

  // Ese pago cae como cualquier otro.
  const paid = applyPeyEvent(store, { type: "codi.pn.payment_received", metadata: { externalMetadata: { chargeId: second?.id } } }, clock);
  assert.equal(paid?.text, "Ya cayó: $500.00 de Ana · renta. Confirmado por CoDi.");

  // Si pey no acepta un plazo largo, se manda con el mínimo.
  pey.rejectLongExpiry = true;
  clock = Date.parse("2027-01-14T18:01:00.000Z");
  assert.match((await runRecurring(deps))[0]?.text ?? "", /Tiene 6 minutos para aceptarlo/);
  assert.equal(pey.pushes.at(-1)?.expirationSec, 360);

  // Tres seguidos sin pagar: se pausa solo. Nadie recibe cobros que ya no quiere.
  clock = Date.parse("2027-02-14T18:02:00.000Z");
  assert.match((await runRecurring(deps))[0]?.text ?? "", /^Cobro recurrente/);
  clock = Date.parse("2027-03-14T18:03:00.000Z");
  assert.match((await runRecurring(deps))[0]?.text ?? "", /^Cobro recurrente/);
  clock = Date.parse("2027-04-14T18:04:00.000Z");
  const paused = await runRecurring(deps);
  assert.equal(paused[0]?.text, "Pausé el cobro recurrente de Ana ($500.00 cada mes): lleva 3 seguidos sin pagar. Si quieres retomarlo, dímelo.");
  assert.equal(store.listRecurrings(OWNER)[0]?.active, false);
  const pushesBefore = pey.pushes.length;
  clock += 40 * DAY;
  assert.deepEqual(await runRecurring(deps), []);
  assert.equal(pey.pushes.length, pushesBefore);

  // Detenerlo a mano.
  const other = flow(memoryStore(), fakePey());
  await say(other, calls(["prepare_charge", { amount: 200, payerName: "Luis", payerPhone: "5544445555", every: "semanal" }]), "cóbrale 200 a Luis cada semana, su cel es 5544445555");
  await say(other, never, "sí");
  assert.equal(textOf(await say(other, calls(["cancel_recurring", { payerName: "luis" }]))), "Listo: ya no le cobro a Luis cada semana ($200.00 · Cobro).");
  clock = NOW + 8 * DAY;
  assert.deepEqual(await runRecurring(other), []);
  assert.match(textOf(await say(other, calls(["list_recurring", {}]))), /^No tienes cobros recurrentes/);

  // Las fechas: semanal, quincenal, y mensual sin brincarse febrero.
  assert.equal(nextOccurrence(NOW, "semanal"), NOW + 7 * DAY);
  assert.equal(nextOccurrence(NOW, "quincenal"), NOW + 15 * DAY);
  assert.equal(nextOccurrence(Date.parse("2027-01-31T18:00:00.000Z"), "mensual"), Date.parse("2027-02-28T18:00:00.000Z"));
  assert.equal(nextOccurrence(Date.parse("2026-12-15T18:00:00.000Z"), "mensual"), Date.parse("2027-01-15T18:00:00.000Z"));
});

test("lo mismo a otra persona, y el estado se le pregunta a pey en ese momento", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  await say(deps, calls(["prepare_charge", { amount: 200, concept: "boletos", payerName: "Ana", payerPhone: "5522223333" }]), "cóbrale 200 de boletos a Ana 5522223333");
  await say(deps, never, "confirmar");

  const same = await say(deps, calls(["repeat_charge", { toName: "Luis", toPhone: "55 4444 5555" }]), "lo mismo a Luis, 5544445555");
  assert.equal(
    textOf(same),
    "Cobro por $200.00\nConcepto: boletos\nLe llega a: Luis · 55 4444 5555, en la app de su banco\nPor: notificación CoDi",
  );
  await say(deps, never, "confirmar");
  assert.deepEqual(pey.pushes.map((push) => push.phone), ["5522223333", "5544445555"]);

  // "¿Ya pagó Ana?": pey dice que sí aunque el webhook no haya llegado.
  assert.equal(textOf(await say(deps, calls(["charge_status", { query: "ana" }]))), "Ana: $200.00 · boletos · pendiente");
  pey.paidPushes.add("txn_1");
  // La respuesta es el aviso de que cayó: no hace falta repetir la línea "pagado" del mismo cobro.
  assert.equal(textOf(await say(deps, calls(["charge_status", { query: "ana" }]))), "Ya cayó: $200.00 de Ana · boletos. Confirmado por CoDi.");
  // Y preguntado otra vez, ya solo es su estado.
  assert.equal(textOf(await say(deps, calls(["charge_status", { query: "ana" }]))), "Ana: $200.00 · boletos · pagado");
  // Ya se lo dijo la respuesta: no llega además un "ya cayó" repetido.
  assert.deepEqual(await reconcilePending(deps), []);
  assert.equal(store.listCharges(OWNER)[0]?.paidNoticeSent, true);

  // En la cuenta compartida caen cobros de mucha gente: solo se enseñan los que salieron de su libro.
  const [toAna, toLuis] = store.listCharges(OWNER);
  pey.transactionsByApiKey = async () => ({
    items: [
      tx("t3", 99_900, { payableType: "API_CODI_QR", description: "de otro negocio", datePaid: NOW + 3 * 3_600_000 }),
      tx("t2", 15_000, { payableType: "API_CODI_PN", description: "uñas", datePaid: NOW + 2 * 3_600_000, chargeId: toAna?.id ?? null }),
      tx("t1", 50_000, {
        payableType: "PAYMENT_LINK",
        breakdown: { baseCents: 45_000, tipCents: 5_000, feeCents: 350 },
        datePaid: NOW,
        chargeId: toLuis?.id ?? null,
      }),
    ],
    nextToken: null,
  });
  const payments = textOf(await say(deps, calls(["pey_payments", {}])));
  assert.equal(
    payments,
    "Últimos pagos según pey\n14 nov 14:00 · $150.00 · notificación · uñas\n14 nov 12:00 · $500.00 · link (propina $50.00) (comisión $3.50)\nSuman $650.00 en 2 pagos.",
  );
});

test("la cuenta, la ayuda y lo que se le pide recordar", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey(), { peyBankAccountId: "01ACC", testMaxCents: 100 });
  assert.equal(
    textOf(await say(deps, calls(["account_status", {}]))),
    "Los cobros caen en la cuenta con CLABE terminada en 5713: activa en CoDi.\nEstás en modo de prueba: máximo $1.00 por cobro. Ese dinero va a la cuenta de pruebas de pey, no a tu banco, y no se devuelve. Para recibir en tu banco dime \"registrar mi cuenta\".\nTope de cobros de hoy: te quedan $5,000.00 de $5,000.00.",
  );
  const plain = flow(memoryStore(), fakePey());
  assert.match(textOf(await say(plain, calls(["account_status", {}]))), /^Los cobros caen en la cuenta CoDi ligada a la llave de pey del negocio\./);
  assert.match(textOf(await say(deps, calls(["show_help", {}]))), /^Esto hago por ti:\n· Cobrar con CoDi/);
  assert.match(corteText(store, OWNER, "ayer", NOW), /^Corte de ayer/);

  const kept = textOf(await say(deps, calls(["remember", { fact: "Cierro a las 8 y los lunes no abro" }]), "recuerda que cierro a las 8 y los lunes no abro"));
  assert.equal(kept, 'Anotado, no se me olvida: "Cierro a las 8 y los lunes no abro".');
  await say(deps, calls(["remember", { fact: "A Ana siempre le cobro con link" }]), "acuérdate que a Ana siempre le cobro con link");
  await say(deps, calls(["prepare_charge", { amount: 0.5, payerName: "Ana", payerPhone: "5522223333" }]), "cóbrale 50 centavos a Ana 5522223333");

  // El modelo ve lo recordado y los últimos cobros sin que se los repitan.
  let seen: ChatMessage[] = [];
  await say(deps, async ({ messages }) => {
    seen = messages;
    return { content: "Va.", toolCalls: [] };
  }, "¿a qué hora cierro?");
  const context = seen[0]?.content ?? "";
  assert.match(context, /Lo que te pidió recordar: Cierro a las 8 y los lunes no abro · A Ana siempre le cobro con link\./);
  assert.match(context, /Últimos cobros \(del más viejo al más nuevo\): Ana \$0\.50 Cobro \(esperando confirmación\)\./);

  const gone = textOf(await say(deps, calls(["forget", { fact: "lunes" }])));
  assert.equal(gone, 'Olvidado: "Cierro a las 8 y los lunes no abro".');
  assert.deepEqual(store.getProfile(OWNER).facts, ["A Ana siempre le cobro con link"]);
});

test("aguanta: el modelo se cae, llegan mensajes encimados o demasiados", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());

  // Si el modelo no contesta, la persona no se queda en visto.
  const quiet = console.error;
  console.error = () => {};
  const down = await say(deps, async () => {
    throw new Error("timeout");
  }, "cobra 150");
  console.error = quiet;
  assert.equal(textOf(down), "Se me fue la señal un momento. Mándamelo otra vez, porfa.");

  // Dos mensajes al mismo tiempo se atienden en orden: el segundo ya ve al primero.
  const order: string[] = [];
  deps.complete = async ({ messages }) => {
    const last = messages.at(-1)?.content ?? "";
    order.push(`entra:${last}`);
    await new Promise((resolve) => setTimeout(resolve, last === "uno" ? 40 : 1));
    order.push(`sale:${last}`);
    return { content: `eco ${last}`, toolCalls: [] };
  };
  const [a, b] = await Promise.all([
    handleInbound(deps, { type: "text", owner: OWNER, messageId: "x1", text: "uno" }),
    handleInbound(deps, { type: "text", owner: OWNER, messageId: "x2", text: "dos" }),
  ]);
  assert.deepEqual(order, ["entra:uno", "sale:uno", "entra:dos", "sale:dos"]);
  assert.deepEqual([textOf(a.messages), textOf(b.messages)], ["eco uno", "eco dos"]);
  // Personas distintas no se esperan entre sí.
  order.length = 0;
  await Promise.all([
    handleInbound(deps, { type: "text", owner: OWNER, messageId: "y1", text: "uno" }),
    handleInbound(deps, { type: "text", owner: "5215522222222", messageId: "y2", text: "dos" }),
  ]);
  assert.deepEqual(order.slice(0, 2), ["entra:uno", "entra:dos"]);

  // Un mensaje kilométrico llega recortado al modelo.
  let got = "";
  await say(deps, async ({ messages }) => {
    got = messages.at(-1)?.content ?? "";
    return { content: "ok", toolCalls: [] };
  }, "a".repeat(5000));
  assert.equal(got.length, 1500);

  // Veinte por minuto por persona; al pasarse se le avisa una vez y después silencio.
  const flood = flow(memoryStore(), fakePey());
  let asked = 0;
  const echo: Completer = async () => {
    asked += 1;
    return { content: "ok", toolCalls: [] };
  };
  for (let i = 0; i < 20; i++) await say(flood, echo, `mensaje ${i}`);
  assert.equal(asked, 20);
  assert.match(textOf(await say(flood, echo, "otro")), /^Voy un poco saturado/);
  assert.deepEqual(await say(flood, echo, "y otro"), []);
  assert.equal(asked, 20);
  // Confirmar o cancelar nunca se frenan, y al minuto vuelve a atender.
  assert.match(textOf(await say(flood, never, "cancelar")), /No hay ningún cobro esperando/);
  clock = NOW + 61_000;
  assert.equal(textOf(await say(flood, echo, "ya")), "ok");
});

test("lo que rompió el jurado simulado ya no se rompe", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);

  // "Cobra 150 de uñas" mandado como producto sin catálogo: es un cobro suelto, no una pregunta.
  const loose = await say(deps, calls(["prepare_charge", { items: [{ name: "uñas", qty: 1 }], amount: 150 }]), "cobra 150 de uñas");
  assert.equal(textOf(loose), "Cobro por $150.00\nConcepto: uñas\nLo paga: quien escanee el QR con la app de su banco\nPor: QR CoDi");
  // "2 cortes a 150 cada uno": el precio es por pieza, aunque el modelo mande el total mal.
  const each = await say(deps, calls(["prepare_charge", { items: [{ name: "corte", qty: 2 }], amount: 150 }]), "cobra 2 cortes a 150 cada uno");
  starts(textOf(each), "Cobro por $300.00\nConcepto: 2 cortes\n");
  // Sin monto dicho, sigue preguntando el precio.
  starts(textOf(await say(deps, calls(["prepare_charge", { items: [{ name: "gringa" }], amount: 60 }]), "cobra una gringa")), 'No tengo "gringa" en tu catálogo.');

  // Un celular sin nombre es de un cliente, no del dueño.
  const toNumber = await say(deps, calls(["prepare_charge", { amount: 300, payerPhone: "5522223333", method: "push" }]), "cobra 300 al 5522223333");
  // El QR de los cortes quedó sin confirmar: se avisa que ya no va, y sale la tarjeta nueva.
  starts(textOf(toNumber), "Descarté el cobro de $300.00 que no habías confirmado");
  assert.equal(cardIn(toNumber).text, "Cobro por $300.00\nLe llega a: el celular 55 2222 3333, en la app de su banco\nPor: notificación CoDi");
  starts(textOf(await say(deps, never, "sí, mándalo")), "Listo, ya salió. Al 55 2222 3333 le llega la notificación CoDi por $300.00");
  assert.equal(store.listContacts(OWNER).length, 0);

  // "Cóbrame" con celular conocido es notificación a su banco, aunque el modelo diga QR.
  const mine = await say(deps, calls(["prepare_charge", { amount: 150, payerName: "yo", payerPhone: "5511111111", method: "qr" }]), "cóbrame 150");
  assert.match(textOf(mine), /Le llega a: tu celular 55 1111 1111/);
  // Con frase natural se cancela el cobro, y no se borra ningún apunte.
  await say(deps, calls(["add_note", { kind: "gasto", amount: 80, concept: "hielo", category: "insumos" }]), "gasté 80 en hielo");
  await say(deps, calls(["prepare_charge", { amount: 150 }]), "cobra 150");
  assert.equal(textOf(await say(deps, never, "ya no, gracias")), "Cancelé el cobro de $150.00. No se envió nada.");
  assert.equal(store.listNotes(OWNER).length, 1);
  // Si el modelo usa undo_last para cancelar, también cancela el cobro y no toca la caja.
  await say(deps, calls(["prepare_charge", { amount: 150 }]), "cobra 150");
  assert.equal(textOf(await say(deps, calls(["undo_last", {}]), "ay no, espérame tantito que siempre no era eso")), "Cancelé el cobro de $150.00. No se envió nada.");
  assert.equal(store.listNotes(OWNER).length, 1);
  starts(textOf(await say(deps, calls(["cancel_charge", {}]), "cancela")), "No hay ningún cobro");
  // "No, mejor 200" no es cancelar: es otro cobro, y lo decide el modelo.
  await say(deps, calls(["prepare_charge", { amount: 150 }]), "cobra 150");
  starts(textOf(await say(deps, calls(["prepare_charge", { amount: 200 }]), "no, mejor 200")), "Cobro por $200.00");
  await say(deps, never, "cancelar");

  clock += 61_000; // otro minuto: esta prueba manda más de veinte mensajes
  // El perfil es del dueño: ni el nombre ni el celular de un cliente entran ahí.
  const before = store.getProfile(OWNER);
  // El modelo de mentira repite el error con sus nombres internos: a la persona no le llegan, a la memoria sí.
  const wrong = textOf(await say(deps, calls(["set_profile", { name: "Ana", phone: "5522223333" }]), "cóbrale 500 de renta a Ana cada mes, su cel es 5522223333"));
  starts(wrong, "No me quedó claro qué hacer con eso.");
  starts(lastToolOutput(store), "ERROR: ese celular no es de quien escribe");
  starts(textOf(await say(deps, calls(["set_profile", { name: "Cliente" }]), "cobra 150")), "No me quedó claro qué hacer con eso.");
  starts(lastToolOutput(store), "ERROR: set_profile es solo para el nombre de quien escribe");
  assert.deepEqual(store.getProfile(OWNER), before);
  assert.match(textOf(await say(deps, calls(["set_profile", { name: "Toro" }]), "hola, soy Toro y vendo tacos")), /se llama Toro/);
  // Y el "de renta" que el modelo dejó fuera sí llega al cobro.
  const rent = await say(deps, calls(["prepare_charge", { amount: 500, payerName: "Ana", payerPhone: "5522223333", every: "mensual" }]), "cóbrale 500 de renta a Ana cada mes, su cel es 5522223333");
  starts(textOf(rent), "Cobro por $500.00\nConcepto: renta\n");
  await say(deps, never, "cancelar");

  // "Corte" es el corte de caja aunque haya un producto que se llame corte. Y no pasa por el modelo.
  await say(deps, calls(["set_product", { name: "corte", price: 150 }]), "agrega corte a 150");
  starts(textOf(await say(deps, never, "corte")), "Corte de hoy\n");
  starts(textOf(await say(deps, never, "dame el corte de la semana")), "Corte de esta semana\n");
  starts(textOf(await say(deps, never, "¿qué puedes hacer?")), "Esto hago por ti:");
  // "Cobra un corte" sí es una venta.
  starts(textOf(await say(deps, calls(["prepare_charge", { items: [{ name: "corte" }] }]), "cobra un corte")), "Cobro por $150.00\n1 × corte");
  await say(deps, never, "cancelar");

  clock += 61_000; // otro minuto: esta prueba manda más de veinte mensajes
  // Tres cosas en un mensaje: lo que contestaron las otras dos sale antes de la tarjeta.
  const many = await say(
    deps,
    calls(["set_product", { name: "café", price: 35 }], ["prepare_charge", { items: [{ name: "café", qty: 2 }] }], ["get_balance", {}]),
    "agrega café a 35, cobra 2 cafés y dime el corte",
  );
  assert.deepEqual(many.map((message) => message.kind), ["text", "buttons"]);
  starts(textOf(many), "En tu catálogo: café a $35.00.\nCorte de hoy\n");
  assert.equal(store.listCharges(OWNER).at(-1)?.concept, "2 cafés");
  await say(deps, never, "cancelar");

  // Montos imposibles los contesta la caja.
  starts(textOf(await say(deps, calls(["prepare_charge", { amount: -50 }]), "cobra -50")), "Ese monto no se puede cobrar: tiene que ser mayor a cero.");

  clock += 61_000; // otro minuto: esta prueba manda más de veinte mensajes
  // Si el modelo pide un celular para un cobro normal, se le manda de vuelta a cobrar por QR.
  let asked = 0;
  const shy: Completer = async ({ messages }) => {
    asked += 1;
    if (asked === 1) return { content: "¿A qué celular te mando la notificación? Son 10 dígitos.", toolCalls: [] };
    assert.equal(messages.at(-1)?.role, "system");
    return { content: null, toolCalls: [call("prepare_charge", { amount: 150 })] };
  };
  starts(textOf(await say(deps, shy, "cobra 150")), "Cobro por $150.00\nLo paga: quien escanee el QR");
  assert.equal(asked, 2);
  await say(deps, never, "cancelar");
  // Con "cóbrale a Ana" sí es válido pedir su celular: no se interviene.
  asked = 0;
  const fair: Completer = async () => {
    asked += 1;
    return { content: "¿Cuál es el celular de Beto? Son 10 dígitos.", toolCalls: [] };
  };
  assert.equal(textOf(await say(deps, fair, "cóbrale 90 a Beto")), "¿Cuál es el celular de Beto? Son 10 dígitos.");
  assert.equal(asked, 1);
});

test("con dinero de por medio, sí es sí y lo demás no se adivina", async () => {
  const { confirmIntent } = await import("../src/flows.js");
  const yes = ["sí", "si", "Sí.", "sí, mándalo", "va, dale", "órale", "ándale", "👍", "✅", "sí porfa", "simón", "ok", "dale pues", "confirmado", "mándaselo", "claro que sí", "yes", "ok mándalo", "sale", "arre", "jalo", "perfecto", "CONFIRMAR"];
  const no = ["no", "No.", "nel", "ok, cancélalo", "claro que no", "ok no", "ok cancela", "está bien, cancélalo", "sale, mejor no", "dale cancelar", "exacto, cancélalo", "así es, no lo mandes", "claro que no lo mandes", "okay no gracias", "ok ya no", "ya no, gracias", "mejor no", "cancélalo", "👎", "CANCELAR", "no gracias"];
  const unsure = [
    "si quieres", "sí?", "listo?", "correcto?", "vas a mandarlo?", "sí le llega a su banco?", "mándalo mañana", "cóbralo después", "hazlo después",
    "envíalo luego", "no manches, sí mándalo", "no, sí mándalo", "sí no", "confirmo que no quiero", "confirmar cancelación", "ok gracias",
    "listo, gracias", "ya", "gracias", "si me lo mandas a otro número", "sí pero que sean 100", "no, mejor 200", "claro, cámbialo a link",
    "espera", "aguanta", "espérame tantito", "si Ana no quiere no", "adelante no pero luego", "no?", "sí por favor mándaselo ya que tengo prisa y se me va el cliente",
  ];
  for (const phrase of yes) assert.equal(confirmIntent(phrase), "yes", phrase);
  for (const phrase of no) assert.equal(confirmIntent(phrase), "no", phrase);
  for (const phrase of unsure) assert.equal(confirmIntent(phrase), null, phrase);

  // En la conversación: "ok, cancélalo" cancela y no sale nada.
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  await say(deps, calls(["prepare_charge", { amount: 100, payerName: "Ana", payerPhone: "5522223333" }]), "cóbrale 100 a Ana 5522223333");
  assert.equal(textOf(await say(deps, never, "ok, cancélalo")), "Cancelé el cobro de $100.00. No se envió nada.");
  assert.equal(pey.pushes.length, 0);

  // Un "sí" contesta lo último que dijo Zaldo. Si después de la tarjeta hubo otra pregunta, no manda el cobro viejo.
  await say(deps, calls(["prepare_charge", { amount: 80, payerName: "Ana", payerPhone: "5522223333" }]), "cóbrale 80 a Ana 5522223333");
  await say(deps, async () => ({ content: "No tengo \"gringa\" en tu catálogo. ¿La agrego?", toolCalls: [] }), "y tengo gringas?");
  let asked = 0;
  await say(deps, async () => {
    asked += 1;
    return { content: "Va, dime el precio.", toolCalls: [] };
  }, "sí");
  assert.equal(asked, 1, "ese sí le llegó al modelo, no a la tarjeta");
  assert.equal(pey.pushes.length, 0);
  assert.equal(store.listCharges(OWNER).at(-1)?.status, "awaiting_confirm");
  // CONFIRMAR, con todas sus letras, sí es para la tarjeta.
  starts(textOf(await say(deps, never, "confirmar")), "Listo, ya salió.");
  assert.equal(pey.pushes.length, 1);
});
