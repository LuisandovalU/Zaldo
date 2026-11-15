import assert from "node:assert/strict";
import test from "node:test";
import type { Completer, ToolCall } from "../src/agent.js";
import type { AppConfig } from "../src/config.js";
import {
  ackInbound,
  asksToWait,
  handleInbound,
  modelMayConfirm,
  reconcilePending,
  runRecurring,
  takeExpired,
  type FlowDeps,
  type PeyPort,
} from "../src/flows.js";
import type { Outbound } from "../src/inbound.js";
import { mexicoDayStart } from "../src/money.js";
import { PeyError, type PeyTransaction, type PeyTransactionPage } from "../src/pey.js";
import { cancelRecurrings, findRecurrings, recurringLines, resumeRecurring, updateRecurring } from "../src/recurrentes.js";
import { memoryStore, type Recurring, type Store } from "../src/store.js";

/** Como assert.ok(x.startsWith(y)), pero al fallar enseña lo que llegó (y no se cuelga bajo tsx). */
function starts(actual: string, prefix: string): void {
  assert.equal(actual.slice(0, prefix.length), prefix);
}

function has(actual: string, piece: string): void {
  assert.equal(actual.includes(piece) ? piece : actual, piece);
}

const OWNER = "5215511111111";
const OTHER = "5215599999999";
const NOW = Date.parse("2026-11-14T18:00:00.000Z"); // sábado 14 nov, 12:00 en CDMX
const MIN = 60_000;
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
    confirmWindowMs: 15 * MIN,
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

const never: Completer = async () => {
  throw new Error("el modelo no debió participar");
};

function tx(id: string, amountCents: number, over: Partial<PeyTransaction> = {}): PeyTransaction {
  return {
    id,
    status: "PAID",
    amountCents,
    breakdown: null,
    currency: "MXN",
    paymentMethod: "CODI",
    payableType: "API_CODI_PN",
    payableId: null,
    description: null,
    applicationFeeCents: 0,
    dateCreated: NOW,
    datePaid: NOW + MIN,
    chargeId: null,
    ...over,
  };
}

interface FakePey extends PeyPort {
  pushes: { phone: string; amountCents: number }[];
  qrs: number[];
  paidPushes: Set<string>;
  fail: unknown;
  /** Lo que pey lista por llave (la cuenta compartida), por páginas. */
  pages: PeyTransaction[][];
  /** Lo que pey lista por cuenta propia. */
  byAccount: Record<string, PeyTransaction[]>;
  asked: string[];
}

function fakePey(): FakePey {
  return {
    pushes: [],
    qrs: [],
    paidPushes: new Set<string>(),
    fail: null,
    pages: [[]],
    byAccount: {},
    asked: [],
    async push(input) {
      if (this.fail) throw this.fail;
      this.pushes.push({ phone: input.phone, amountCents: input.amountCents });
      return { transactionId: `txn_${this.pushes.length}`, codiId: "codi" };
    },
    async qr(input) {
      this.qrs.push(input.amountCents);
      return { id: `idc_${this.qrs.length}`, qrString: "{}" };
    },
    async link() {
      return { id: "link_1", url: "https://app.mipey.mx/payment-link/x" };
    },
    async transaction(id) {
      return tx(id, 0, { status: this.paidPushes.has(id) ? "PAID" : "PENDING" });
    },
    async qrTransactions() {
      return { items: [], nextToken: null };
    },
    async transactionsByApiKey(token): Promise<PeyTransactionPage> {
      const index = token ? Number(token) : 0;
      this.asked.push(`llave:${index}`);
      return { items: this.pages[index] ?? [], nextToken: index + 1 < this.pages.length ? String(index + 1) : null };
    },
    async transactionsByBankAccount(id): Promise<PeyTransactionPage> {
      this.asked.push(`cuenta:${id}`);
      return { items: this.byAccount[id] ?? [], nextToken: null };
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

async function say(deps: FlowDeps, complete: Completer, text: string, owner = OWNER): Promise<Outbound[]> {
  deps.complete = complete;
  const messageId = `f${++seq}`;
  const handled = await handleInbound(deps, { type: "text", owner, messageId, text });
  if (handled.claimed) ackInbound(deps.store, messageId);
  return handled.messages;
}

async function press(deps: FlowDeps, buttonId: string, owner = OWNER): Promise<string> {
  const messageId = `f${++seq}`;
  const handled = await handleInbound(deps, { type: "button", owner, messageId, buttonId });
  if (handled.claimed) ackInbound(deps.store, messageId);
  return textOf(handled.messages);
}

function textOf(messages: Outbound[], index = 0): string {
  const item = messages[index];
  if (!item) return "";
  return item.kind === "image" ? item.caption : item.text;
}

function statuses(store: Store, owner = OWNER): string[] {
  return store.listCharges(owner).map((charge) => charge.status);
}

const WAITING = "Va, aquí lo dejo esperando. Cuando quieras: CONFIRMAR o CANCELAR.";
const CLEAR_YES = "Para mandarlo necesito un sí claro: escribe CONFIRMAR, o CANCELAR si ya no va.";

test('"espera" deja la tarjeta esperando: ni se manda ni se tira', async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  await say(deps, calls(["prepare_charge", { amount: 150 }]), "cobra 150");

  starts(textOf(await say(deps, never, "espérame tantito")), `${WAITING} Te lo guardo 15 minutos.`);
  assert.deepEqual([statuses(store), pey.qrs.length], [["awaiting_confirm"], 0]);

  // A los 10 minutos pide otro rato: la tarjeta recupera su plazo completo.
  clock = NOW + 10 * MIN;
  starts(textOf(await say(deps, never, "aguanta, ahorita no")), WAITING);
  assert.equal(store.listCharges(OWNER)[0]?.confirmBy, clock + 15 * MIN);
  // A los 20 ya habría caducado; como pidió esperar, el sí todavía la manda.
  clock = NOW + 20 * MIN;
  starts(textOf(await say(deps, never, "sí")), "QR CoDi por $150.00");
  assert.deepEqual([statuses(store), pey.qrs], [["pending"], [15_000]]);

  for (const wait of ["espera", "aguanta tantito", "todavía no", "ahorita no", "al rato", "déjame ver", "un momento porfa", "luego te digo"]) {
    assert.equal(asksToWait(wait), true, wait);
  }
  // Un cambio al cobro, una pregunta o un no rotundo no son "espera": eso no se contesta solo.
  for (const other of ["espera, mejor por link", "espera, mejor 200", "¿espero?", "espera, mejor cancélalo", "no", "sí", "cobra 150"]) {
    assert.equal(asksToWait(other), false, other);
  }
});

test("el sí que entiende el modelo lo revisa la caja antes de mandar dinero", async () => {
  const charge = { amountCents: 20_000, payerPhone: "5522223333" };
  for (const yes of ["ándale pues, mándaselo", "sí porfa, que le llegue ya", "sí, mándale los 200", "va, mándalo al 55 2222 3333", "órale, que salga"]) {
    assert.equal(modelMayConfirm(yes, charge), true, yes);
  }
  for (const no of [
    "ok, cancélalo",
    "claro que no",
    "si quieres",
    "¿ya se lo mando?",
    "mándalo mañana",
    "espera",
    "aguanta",
    "todavía no",
    "ahorita no",
    "luego",
    "al rato se lo mandas",
    "déjalo",
    "mejor no",
    "sí pero de 300",
    "sí, mándale 300",
    "sí, al 5544445555",
    "sí 👎",
    "",
  ]) {
    assert.equal(modelMayConfirm(no, charge), false, no);
  }

  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  const confirmTool = calls(["confirm_charge", {}]);
  await say(deps, calls(["prepare_charge", { amount: 200, payerName: "Ana", payerPhone: "5522223333" }]), "cóbrale 200 a Ana 5522223333");

  // El modelo "entendió" un sí donde no lo hay: no sale nada y la tarjeta sigue ahí.
  for (const doubt of ["si quieres mándaselo", "mándaselo pero mañana", "¿se lo mando ya o qué?", "no sé, aguanta que le llegue"]) {
    assert.equal(textOf(await say(deps, calls(["confirm_charge", {}]), doubt)), CLEAR_YES, doubt);
    assert.deepEqual([statuses(store), pey.pushes.length], [["awaiting_confirm"], 0], doubt);
  }
  // Un sí con sus palabras, que la lista de palabras no conoce: el modelo lo propone y la caja lo acepta.
  starts(textOf(await say(deps, confirmTool, "sí porfa, que le llegue ya")), "Listo, ya salió. A Ana le llega la notificación CoDi por $200.00");
  assert.deepEqual([statuses(store), pey.pushes], [["pending"], [{ phone: "5522223333", amountCents: 20_000 }]]);

  // Lo que mandó cobros por error (cazador C1) sigue sin mandarlos, con o sin modelo.
  const again = flow(memoryStore(), fakePey());
  await say(again, calls(["prepare_charge", { amount: 100 }]), "cobra 100");
  starts(textOf(await say(again, never, "ok, cancélalo")), "Cancelé el cobro de $100.00");
  await say(again, calls(["prepare_charge", { amount: 100 }]), "cobra 100");
  starts(textOf(await say(again, never, "claro que no")), "Cancelé el cobro de $100.00");
  await say(again, calls(["prepare_charge", { amount: 100 }]), "cobra 100");
  assert.equal(textOf(await say(again, calls(["confirm_charge", {}]), "si quieres")), CLEAR_YES);
  assert.equal((again.pey as FakePey).qrs.length, 0);
  assert.deepEqual(statuses(again.store), ["cancelled", "cancelled", "awaiting_confirm"]);
});

test("si después de la tarjeta hubo otra plática, el sí del modelo no es para el cobro", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  await say(deps, calls(["prepare_charge", { amount: 150 }]), "cobra 150");
  // Zaldo contestó otra cosa: lo último que dijo ya no es la tarjeta.
  await say(deps, async () => ({ content: "Vale una hora. ¿Te explico cómo se escanea?", toolCalls: [] }), "oye, cuánto dura el QR");
  assert.equal(textOf(await say(deps, calls(["confirm_charge", {}]), "sí porfa, eso mero quiero")), CLEAR_YES);
  assert.deepEqual([statuses(store), pey.qrs.length], [["awaiting_confirm"], 0]);
  // Ahora la pregunta sí fue por el cobro: un sí lo manda.
  starts(textOf(await say(deps, never, "sí")), "QR CoDi por $150.00");
  assert.equal(pey.qrs.length, 1);
});

test("el aviso de la caja va antes de la tarjeta, y confirmar una tarjeta vieja no manda nada", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  await say(deps, calls(["prepare_charge", { amount: 300, payerName: "Ana", payerPhone: "5522223333" }]), "cóbrale 300 a Ana 5522223333");
  const second = await say(deps, calls(["prepare_charge", { amount: 200, payerName: "Luis", payerPhone: "5544445555" }]), "cóbrale 200 a Luis 5544445555");
  assert.deepEqual(second.map((message) => message.kind), ["text", "buttons"]);
  starts(textOf(second), "Descarté el cobro de $300.00 a Ana que no habías confirmado");
  starts(textOf(second, 1), "Cobro por $200.00");
  const [old, fresh] = store.listCharges(OWNER);
  // En la memoria queda todo junto, y como tarjeta del cobro nuevo.
  const lastTurn = store.recentTurns(OWNER).at(-1);
  assert.equal(lastTurn?.cardOf, fresh?.id);
  has(lastTurn?.content ?? "", "Descarté el cobro de $300.00 a Ana");
  has(lastTurn?.content ?? "", "Cobro por $200.00");

  // El botón de la tarjeta vieja: no manda nada y dice por qué.
  assert.equal(
    await press(deps, `c:${old?.id}`),
    "Ese cobro de $300.00 ya lo había descartado y no se envió: lo reemplazó el de $200.00. Para mandar ese, confírmame la tarjeta nueva.",
  );
  assert.equal(pey.pushes.length, 0);
  starts(await press(deps, `c:${fresh?.id}`), "Listo, ya salió. A Luis le llega");
  // Dos toques al mismo botón no mandan dos cobros, y lo que ya salió no se "cancela".
  assert.equal(await press(deps, `c:${fresh?.id}`), "Ese cobro de $200.00 ya salió: estoy esperando el pago. No lo mando dos veces.");
  assert.equal(await press(deps, `x:${fresh?.id}`), "Ese cobro ya salió y no lo puedo retirar. Si no lo pagan, vence solo y no se cobra nada.");
  assert.equal(await press(deps, `x:${old?.id}`), "Ese cobro ya estaba cancelado. No se envió nada.");
  assert.deepEqual([statuses(store), pey.pushes.length], [["cancelled", "pending"], 1]);
});

test('"¿ya pagó Ana?" no se traga el pago de Luis que cayó al mismo tiempo', async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  await say(deps, calls(["prepare_charge", { amount: 200, payerName: "Ana", payerPhone: "5522223333" }]), "cóbrale 200 a Ana 5522223333");
  await say(deps, never, "confirmar");
  await say(deps, calls(["prepare_charge", { amount: 100, payerName: "Luis", payerPhone: "5544445555" }]), "cóbrale 100 a Luis 5544445555");
  await say(deps, never, "confirmar");
  pey.paidPushes.add("txn_1");
  pey.paidPushes.add("txn_2");

  const reply = textOf(await say(deps, calls(["charge_status", { query: "ana" }]), "¿ya pagó Ana?"));
  has(reply, "Ya cayó: $100.00 de Luis. Confirmado por CoDi.");
  has(reply, "Ana");
  // Ya se dijeron en la respuesta: el reloj no los repite.
  assert.deepEqual(store.listCharges(OWNER).map((charge) => [charge.status, charge.paidNoticeSent]), [
    ["paid", true],
    ["paid", true],
  ]);
  assert.deepEqual(await reconcilePending(deps), []);
});

test("cada quien ve solo sus pagos, aunque todos caigan en la misma cuenta", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey, { peyBankAccountId: undefined });
  await say(deps, calls(["prepare_charge", { amount: 150, concept: "uñas" }]), "cobra 150 de uñas");
  await say(deps, never, "confirmar");
  await say(deps, calls(["prepare_charge", { amount: 80, concept: "tacos" }]), "cobra 80 de tacos", OTHER);
  await say(deps, never, "confirmar", OTHER);
  const mine = store.listCharges(OWNER)[0];
  const theirs = store.listCharges(OTHER)[0];
  // La primera página es de puros cobros ajenos; el de esta persona viene en la segunda.
  pey.pages = [
    [tx("a1", 99_900, { description: "ajeno" }), tx("a2", 8_000, { description: "tacos", chargeId: theirs?.id ?? null })],
    [tx("m1", 15_000, { description: "uñas", payableType: "API_CODI_QR", chargeId: mine?.id ?? null })],
  ];

  const shown = textOf(await say(deps, calls(["pey_payments", {}]), "mis últimos pagos"));
  has(shown, "$150.00");
  assert.deepEqual([shown.includes("$999.00"), shown.includes("$80.00"), shown.includes("tacos")], [false, false, false]);
  const other = textOf(await say(deps, calls(["pey_payments", {}]), "mis últimos pagos", OTHER));
  has(other, "$80.00");
  assert.deepEqual([other.includes("$999.00"), other.includes("$150.00")], [false, false]);
  // Quien no ha cobrado nada no ve nada.
  const nobody = textOf(await say(deps, calls(["pey_payments", {}]), "mis últimos pagos", "5215500000000"));
  assert.deepEqual([nobody.includes("$"), nobody.includes("uñas")], [false, false]);

  // Con cuenta propia activa se consulta ESA cuenta: lo que cae ahí es suyo.
  store.setProfile({
    ...store.getProfile(OWNER),
    bank: { id: "01PROPIA", last4: "1234", holder: "Isabel", status: "ACTIVE", error: null, registeredAt: NOW },
  });
  pey.byAccount = { "01PROPIA": [tx("p1", 70_000, { description: "renta" })] };
  pey.asked = [];
  const own = textOf(await say(deps, calls(["pey_payments", {}]), "mis últimos pagos"));
  has(own, "$700.00");
  assert.deepEqual(pey.asked, ["cuenta:01PROPIA"]);
});

function plan(store: Store, over: Partial<Recurring> = {}): Recurring {
  const item: Recurring = {
    id: `plan-${store.listRecurrings().length + 1}`,
    owner: OWNER,
    payerName: "Ana",
    payerPhone: "5522223333",
    amountCents: 50_000,
    concept: "renta",
    every: "mensual",
    nextAt: Date.parse("2026-12-14T18:00:00.000Z"),
    active: true,
    createdAt: NOW,
    lastChargeId: null,
    missed: 0,
    ...over,
  };
  store.upsertRecurring(item);
  return item;
}

test("un segundo cobro recurrente al mismo cliente no pisa al primero", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  const monthly = (amount: number, concept: string) =>
    say(
      deps,
      calls(["prepare_charge", { amount, concept, payerName: "Ana", payerPhone: "5522223333", every: "mensual" }]),
      `cóbrale ${amount} de ${concept} a Ana cada mes, su cel es 5522223333`,
    );
  await monthly(500, "renta");
  await say(deps, never, "confirmar");
  await monthly(200, "internet");
  await say(deps, never, "confirmar");
  const active = () => store.listRecurrings(OWNER).filter((item) => item.active);
  assert.deepEqual(active().map((item) => [item.concept, item.amountCents]), [
    ["renta", 50_000],
    ["internet", 20_000],
  ]);
  // El mismo concepto y la misma frecuencia sí es el mismo plan: cambia el monto, no se duplica.
  await monthly(600, "renta");
  await say(deps, never, "confirmar");
  assert.deepEqual(active().map((item) => [item.concept, item.amountCents]), [
    ["renta", 60_000],
    ["internet", 20_000],
  ]);
});

test("si pey no deja salir el cobro del periodo, se reintenta sin contarlo como impago", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  const due = Date.parse("2026-12-14T18:00:00.000Z");
  const first = plan(store, { nextAt: due });
  const state = () => store.listRecurrings(OWNER).find((item) => item.id === first.id);

  pey.fail = new PeyError("upstream", "SERVICE_UNAVAILABLE", 503, null);
  clock = due + 30_000;
  const failed = await runRecurring(deps);
  starts(failed[0]?.text ?? "", "No salió el cobro recurrente de Ana ($500.00 cada mes).");
  assert.deepEqual([state()?.failures, state()?.missed, state()?.nextAt, state()?.dueAt, state()?.active], [1, 0, clock + 15 * MIN, due, true]);
  // Antes de tiempo no reintenta; el segundo fallo va callado.
  clock += 5 * MIN;
  assert.deepEqual(await runRecurring(deps), []);
  clock += 10 * MIN;
  assert.deepEqual(await runRecurring(deps), []);
  assert.deepEqual([state()?.failures, state()?.missed, state()?.nextAt], [2, 0, clock + 60 * MIN]);

  // pey vuelve: sale, y el siguiente cae en su fecha de siempre (no se recorre por el reintento).
  pey.fail = null;
  clock += 60 * MIN;
  const sent = await runRecurring(deps);
  starts(sent[0]?.text ?? "", "Cobro recurrente: Le mandé a Ana su cobro mensual de $500.00 · renta.");
  has(sent[0]?.text ?? "", "El siguiente, el 14 ene.");
  assert.deepEqual(
    [state()?.failures, state()?.missed, state()?.nextAt, state()?.dueAt, pey.pushes.length],
    [0, 0, Date.parse("2027-01-14T18:00:00.000Z"), undefined, 1],
  );
  // Los dos intentos fallidos quedaron como fallidos, no como cobros pendientes.
  assert.deepEqual(statuses(store), ["failed", "failed", "pending"]);

  // Cuatro seguidos sin poder salir: se pausa y lo dice. Sigue sin contar como impago.
  const paid = store.listCharges(OWNER).at(-1);
  if (paid) store.updateCharge({ ...paid, status: "paid", paidAt: clock });
  pey.fail = new PeyError("upstream", "SERVICE_UNAVAILABLE", 503, null);
  clock = Date.parse("2027-01-14T18:00:30.000Z");
  const texts: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const notice of await runRecurring(deps)) texts.push(notice.text);
    clock += 7 * 3_600_000;
  }
  assert.equal(texts.length, 2, "avisa del primer fallo y de la pausa, no de cada reintento");
  starts(texts[1] ?? "", "Pausé el cobro recurrente de Ana ($500.00 cada mes): no ha podido salir 4 veces seguidas.");
  assert.deepEqual([state()?.active, state()?.missed, state()?.failures], [false, 0, 4]);
  assert.deepEqual(await runRecurring(deps), []);
});

test("los cobros recurrentes se encuentran, se cambian, se cancelan y se retoman sin mandar nada", async () => {
  const store = memoryStore();
  store.setProfile({ ...store.getProfile(OWNER), phone: "5511111111" });
  const renta = plan(store);
  const internet = plan(store, { concept: "internet", amountCents: 20_000, nextAt: Date.parse("2026-11-20T18:00:00.000Z") });
  const own = plan(store, { payerName: "ti", payerPhone: "5511111111", amountCents: 10_000, concept: "Cobro", every: "semanal", nextAt: NOW + 7 * DAY });
  const maria = plan(store, { payerName: "la señora María", payerPhone: "5533334444", amountCents: 30_000, concept: "clases", every: "quincenal" });
  plan(store, { owner: OTHER, payerName: "Ana", payerPhone: "5522223333", concept: "ajeno" });
  const ids = (who: string) => findRecurrings(store, OWNER, who).map((item) => item.id);

  assert.deepEqual(ids("ana"), [renta.id, internet.id]);
  assert.deepEqual(ids("ANA"), [renta.id, internet.id]);
  assert.deepEqual(ids("a Ana"), [renta.id, internet.id]);
  assert.deepEqual(ids("55 2222 3333"), [renta.id, internet.id]);
  assert.deepEqual(ids("+52 1 55 3333 4444"), [maria.id]);
  assert.deepEqual(ids("maria"), [maria.id]);
  assert.deepEqual(ids("María"), [maria.id]);
  for (const me of ["yo", "mí", "a mí", "ti", "5511111111"]) assert.deepEqual(ids(me), [own.id], me);
  assert.deepEqual(ids("Pedro"), []);
  assert.deepEqual(ids(""), []);

  assert.deepEqual(recurringLines(store, OWNER, NOW), [
    "Ana · $200.00 cada mes · internet · siguiente 20 nov",
    "Tú · $100.00 cada semana · Cobro · siguiente 21 nov",
    "Ana · $500.00 cada mes · renta · siguiente 14 dic",
    "la señora María · $300.00 cada quincena · clases · siguiente 14 dic",
  ]);

  // Con dos planes de Ana hay que decir cuál; el concepto lo dice.
  const which = updateRecurring(store, OWNER, NOW, { who: "Ana", amountCents: 60_000 });
  assert.equal(which.ok, false);
  starts(which.text, "Hay más de un cobro recurrente ahí. ¿Cuál cambio?");
  assert.deepEqual(updateRecurring(store, OWNER, NOW, { who: "Ana", amountCents: 60_000, concept: "renta" }), {
    ok: true,
    text: "Listo: el cobro recurrente de Ana queda en $600.00 cada mes · renta. El siguiente sale el 14 dic; ahorita no mandé nada.",
  });
  const after = store.listRecurrings(OWNER).find((item) => item.id === renta.id);
  assert.deepEqual([after?.amountCents, after?.nextAt, after?.lastChargeId], [60_000, renta.nextAt, null]);
  assert.equal(store.listCharges(OWNER).length, 0, "cambiar un plan no arma ni manda ningún cobro");

  // Otra frecuencia: el siguiente no se aleja.
  assert.deepEqual(updateRecurring(store, OWNER, NOW, { who: "maría", every: "semanal" }), {
    ok: true,
    text: "Listo: el cobro recurrente de la señora María queda en $300.00 cada semana · clases. El siguiente sale el 21 nov; ahorita no mandé nada.",
  });
  assert.deepEqual(updateRecurring(store, OWNER, NOW, { who: "a mí", amountCents: 12_000 }), {
    ok: true,
    text: "Listo: tu cobro recurrente queda en $120.00 cada semana. El siguiente sale el 21 nov; ahorita no mandé nada.",
  });
  assert.equal(updateRecurring(store, OWNER, NOW, { who: "Pedro", amountCents: 100 }).ok, false);
  assert.equal(updateRecurring(store, OWNER, NOW, { who: "yo", amountCents: 0 }).ok, false);
  assert.equal(updateRecurring(store, OWNER, NOW, { who: "yo", amountCents: 12_000 }).ok, false, "ya estaba así");

  // Cancelar el propio, y solo uno de los de Ana.
  assert.deepEqual(cancelRecurrings(store, OWNER, "yo"), { ok: true, text: "Listo: ya no te cobro a ti cada semana ($120.00 · Cobro)." });
  assert.deepEqual(cancelRecurrings(store, OWNER, "ana", "internet"), {
    ok: true,
    text: "Listo: ya no le cobro a Ana cada mes ($200.00 · internet).",
  });
  assert.deepEqual(ids("ana"), [renta.id]);
  assert.equal(cancelRecurrings(store, OWNER, "Pedro").ok, false);
  // Sin decir de quién, con más de uno activo: pregunta.
  starts(cancelRecurrings(store, OWNER, "").text, "Tienes más de un cobro recurrente. ¿Cuál detengo?");
  assert.equal(store.listRecurrings(OTHER)[0]?.active, true, "los de otro dueño ni se tocan");

  // Retomar el que se detuvo: arranca limpio y hoy no sale nada.
  assert.deepEqual(resumeRecurring(store, OWNER, NOW, "ana"), {
    ok: true,
    text: "Listo: retomé el cobro recurrente de Ana: $200.00 cada mes · internet. El siguiente sale el 14 dic; ahorita no mandé nada.",
  });
  assert.deepEqual(ids("ana"), [renta.id, internet.id]);
  assert.equal(resumeRecurring(store, OWNER, NOW, "Pedro").ok, false);
});

test("el tope del día cuenta lo que se mandó aunque venza sin pagarse", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey, { dailyCapCents: 30_000 });
  await say(deps, calls(["prepare_charge", { amount: 200, payerName: "Ana", payerPhone: "5522223333" }]), "cóbrale 200 a Ana 5522223333");
  await say(deps, never, "confirmar");
  clock = NOW + 7 * MIN;
  assert.equal(takeExpired(store, clock).length, 1);
  assert.deepEqual([statuses(store), store.confirmedCentsSince(OWNER, mexicoDayStart(clock))], [["expired"], 20_000]);
  // Un recurrente que hoy ya no cabe se queda para más tarde, sin perder su fecha.
  const due = clock - MIN;
  const item = plan(store, { nextAt: due, amountCents: 20_000 });
  starts((await runRecurring(deps))[0]?.text ?? "", "No mandé el cobro recurrente de Ana ($200.00 cada mes): pasa el tope de cobros de hoy.");
  const later = store.listRecurrings(OWNER).find((entry) => entry.id === item.id);
  assert.deepEqual([later?.dueAt, later?.nextAt, pey.pushes.length], [due, clock + 6 * 3_600_000, 1]);
});
