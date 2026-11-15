import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chargeCard, type ChatMessage, type Completer, type ToolCall } from "../src/agent.js";
import { corteText, normalizeCategory, periodRange } from "../src/caja.js";
import type { AppConfig } from "../src/config.js";
import { fileStore } from "../src/fileStore.js";
import {
  ackInbound,
  applyPeyEvent,
  explainPeyError,
  handleInbound,
  reconcilePending,
  takeExpired,
  type FlowDeps,
  type PeyPort,
} from "../src/flows.js";
import type { Outbound } from "../src/inbound.js";
import { PeyClient, PeyError } from "../src/pey.js";
import { memoryStore, type Store } from "../src/store.js";


/** Como assert.ok(x.startsWith(y)), pero al fallar enseña lo que llegó (y no se cuelga bajo tsx). */
function starts(actual: string, prefix: string): void {
  assert.equal(actual.slice(0, prefix.length), prefix);
}

const OWNER = "5215511111111";
/** Un chat que WhatsApp entrega sin número (LID): Zaldo no sabe su celular. */
const LID = "198765432109876";
const NOW = Date.parse("2026-11-14T18:00:00.000Z"); // sábado 14 nov, 12:00 en CDMX

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

interface FakePey extends PeyPort {
  pushes: { phone: string; chargeId: string; concept: string }[];
  qrs: { concept: string; amountCents: number }[];
  paid: Set<string>;
  fail: unknown;
}

function fakePey(): FakePey {
  return {
    pushes: [],
    qrs: [],
    paid: new Set<string>(),
    fail: null,
    async push(input) {
      if (this.fail) throw this.fail;
      this.pushes.push({ phone: input.phone, chargeId: input.chargeId, concept: input.concept });
      return { transactionId: `txn_${this.pushes.length}`, codiId: "codi_1" };
    },
    async qr(input) {
      if (this.fail) throw this.fail;
      this.qrs.push({ concept: input.concept, amountCents: input.amountCents });
      return { id: `idc_${this.qrs.length}`, qrString: '{"TYP":20}' };
    },
    async link() {
      return { id: "link_1", url: "https://pay.example/abc" };
    },
    async transaction(id) {
      return {
        id,
        status: this.paid.has(id) ? "PAID" : "PENDING",
        amountCents: 0,
        breakdown: null,
        currency: "MXN",
        paymentMethod: "CODI",
        payableType: "API_CODI_PN",
        payableId: null,
        description: null,
        applicationFeeCents: 0,
        dateCreated: null,
        datePaid: this.paid.has(id) ? NOW + 60_000 : null,
        chargeId: null,
      };
    },
  };
}

let seq = 0;
function flow(store: Store, pey: PeyPort, over: Partial<AppConfig> = {}, now = NOW): FlowDeps {
  return {
    store,
    config: config(over),
    pey,
    complete: async () => ({ content: "hola", toolCalls: [] }),
    transcribe: async () => "",
    now: () => now,
    renderQr: async () => Buffer.from("qr"),
  };
}

/** Un mensaje que ya trae los montos de estas pruebas: la caja solo cobra cifras que la persona dijo. */
const SAID = "cóbrame a mí 0.01, 10, 20, 40, 50, 90, 120, 150, 200, 420 o 450";

async function say(deps: FlowDeps, owner: string, complete: Completer, text = SAID): Promise<Outbound[]> {
  deps.complete = complete;
  const messageId = `m${++seq}`;
  const handled = await handleInbound(deps, { type: "text", owner, messageId, text });
  if (handled.claimed) ackInbound(deps.store, messageId);
  return handled.messages;
}

async function press(deps: FlowDeps, owner: string, buttonId: string): Promise<Outbound[]> {
  const messageId = `m${++seq}`;
  const handled = await handleInbound(deps, { type: "button", owner, messageId, buttonId });
  if (handled.claimed) ackInbound(deps.store, messageId);
  return handled.messages;
}

function textOf(messages: Outbound[]): string {
  const first = messages[0];
  if (!first) return "";
  return first.kind === "image" ? first.caption : first.text;
}

/** Prepara un cobro y lo confirma. Devuelve lo que contestó la confirmación. */
async function sell(deps: FlowDeps, owner: string, args: object): Promise<string> {
  const card = await say(deps, owner, calls(["prepare_charge", args]));
  if (card[0]?.kind !== "buttons") throw new Error(`esperaba la tarjeta: ${textOf(card)}`);
  return textOf(await press(deps, owner, card[0].yesId));
}

test("los errores de Pey se leen: nunca más [object Object]", async () => {
  const body = { error: { message: "Bank account is not CoDi enabled", type: "INVALID_STATE", requestId: "req_1" } };
  const client = new PeyClient("https://api.pey.mx", "k", async () => new Response(JSON.stringify(body), { status: 400 }));
  const input = { amountCents: 15000, phone: "5512345678", concept: "uñas", numRef: "1234567", chargeId: "c1", expirationSec: 360 };
  await assert.rejects(client.push(input), (error: unknown) => {
    assert.ok(error instanceof PeyError);
    assert.equal(error.message, "Bank account is not CoDi enabled");
    assert.equal(error.type, "INVALID_STATE");
    assert.equal(error.requestId, "req_1");
    assert.equal(error.status, 400);
    return true;
  });

  // Un error sin forma conocida tampoco se imprime como objeto.
  const odd = new PeyClient("https://api.pey.mx", "k", async () => new Response('{"error":{"detail":{"x":1}}}', { status: 502 }));
  await assert.rejects(odd.push(input), (error: unknown) => {
    assert.ok(error instanceof PeyError);
    assert.doesNotMatch(error.message, /object Object/);
    assert.equal(error.message, "Pey respondió 502");
    return true;
  });

  // Sin respuesta: red caída o tiempo agotado.
  const down = new PeyClient("https://api.pey.mx", "k", async () => {
    throw new Error("fetch failed");
  });
  await assert.rejects(down.push(input), (error: unknown) => error instanceof PeyError && error.type === "NETWORK");

  // Lo que Pey espera en un push: pesos con decimales, 10 dígitos, 360 s mínimo, metadata.
  let sent: Record<string, unknown> = {};
  const ok = new PeyClient("https://api.pey.mx", "k", async (_url, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ transactionId: "01J5", codiId: "123" }), { status: 200 });
  });
  await ok.push(input);
  assert.deepEqual(sent, {
    amount: 150,
    phoneNumber: "5512345678",
    concept: "uñas",
    expiration: 360,
    numRef: "1234567",
    metadata: { chargeId: "c1" },
  });

  assert.match(explainPeyError(new PeyError("x", "INVALID_STATE", 400, null), "push"), /no tiene CoDi activo en pey/);
  assert.match(explainPeyError(new PeyError("x", "SERVICE_UNAVAILABLE", 503, null), "qr"), /fallando ahorita/);
  assert.match(explainPeyError(new PeyError("phoneNumber must be a 10-digit string", "INVALID_PARAMETER", 400, null), "push"), /10 dígitos/);
  assert.match(explainPeyError(new Error("otro"), "push"), /de mi lado/);
});

test("si Pey rechaza el cobro, Zaldo lo explica y ofrece el QR", async () => {
  const store = memoryStore();
  const pey = fakePey();
  pey.fail = new PeyError("Bank account is not CoDi enabled", "INVALID_STATE", 400, "req_1");
  const deps = flow(store, pey);
  const quiet = console.error;
  console.error = () => {};
  try {
    const failed = await sell(deps, OWNER, { amount: 150, concept: "uñas", payerName: "yo" });
    assert.doesNotMatch(failed, /object Object/);
    assert.match(failed, /No salió el cobro de \$150\.00/);
    assert.match(failed, /no tiene CoDi activo en pey/);
    assert.match(failed, /QR/);
    assert.equal(store.listCharges(OWNER)[0]?.status, "failed");
  } finally {
    console.error = quiet;
  }
});

test("el catálogo arma el ticket: precios y total los pone la caja", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);

  const empty = textOf(await say(deps, OWNER, calls(["list_products", {}])));
  assert.match(empty, /catálogo está vacío/);

  const added = textOf(
    await say(deps, OWNER, calls(["set_product", { name: "uñas acrílicas", price: 350 }], ["set_product", { name: "gel", price: 200 }], ["set_product", { name: "corte", price: 150 }])),
  );
  assert.equal(added, "En tu catálogo: uñas acrílicas a $350.00.\nEn tu catálogo: gel a $200.00.\nEn tu catálogo: corte a $150.00.");
  const list = textOf(await say(deps, OWNER, calls(["list_products", {}])));
  assert.equal(list, "Tu catálogo\nuñas acrílicas · $350.00\ngel · $200.00\ncorte · $150.00");

  // Nombres a medias, con mayúsculas o en plural caen en el producto; el modelo no manda precios.
  const card = await say(deps, OWNER, calls(["prepare_charge", { items: [{ name: "acrílicas", qty: 2 }, { name: "Gel" }, { name: "cortes", qty: 1 }] }]));
  assert.equal(
    textOf(card),
    [
      "Cobro por $1,050.00",
      "2 × uñas acrílicas · $350.00 c/u",
      "1 × gel · $200.00",
      "1 × corte · $150.00",
      "Lo paga: quien escanee el QR con la app de su banco",
      "Por: QR CoDi",
    ].join("\n"),
  );
  const charge = store.listCharges(OWNER)[0];
  assert.equal(charge?.amountCents, 105_000);
  assert.equal(charge?.concept, "2 uñas acrílicas, 1 gel, 1 corte");
  assert.equal(charge?.method, "qr");
  if (card[0]?.kind !== "buttons") throw new Error("esperaba la tarjeta");
  const image = await press(deps, OWNER, card[0].yesId);
  assert.equal(image[0]?.kind, "image");
  assert.equal(pey.qrs[0]?.amountCents, 105_000);
  assert.equal(pey.qrs[0]?.concept, "2 uñas acrílicas, 1 gel, 1 corte");

  // Aunque el modelo mande un monto o un precio, manda el catálogo.
  await say(deps, OWNER, calls(["prepare_charge", { items: [{ name: "gel", qty: 3, price: 1 }], amount: 5 }]));
  assert.equal(store.listCharges(OWNER).at(-1)?.amountCents, 60_000);

  // Lo que no está en el catálogo no se inventa…
  const unknown = textOf(await say(deps, OWNER, calls(["prepare_charge", { items: [{ name: "tinte" }] }]), "cobra un tinte"));
  assert.equal(unknown, 'No tengo "tinte" en tu catálogo. ¿A cuánto lo cobro? Dime el precio y lo dejo guardado.');
  // …salvo que la persona haya dicho el precio.
  await say(deps, OWNER, calls(["prepare_charge", { items: [{ name: "tinte", price: 450 }, { name: "corte" }] }]));
  assert.equal(store.listCharges(OWNER).at(-1)?.amountCents, 60_000);

  const bad = textOf(await say(deps, OWNER, calls(["prepare_charge", { items: [{ name: "gel", qty: 0 }] }])));
  assert.match(bad, /de 1 a 99/);

  const changed = textOf(await say(deps, OWNER, calls(["set_product", { name: "Gel", price: 250 }])));
  assert.equal(changed, "Precio nuevo: Gel a $250.00 (antes $200.00).");
  const removed = textOf(await say(deps, OWNER, calls(["set_product", { name: "corte", price: 0 }])));
  assert.equal(removed, "Quité corte del catálogo.");
  assert.deepEqual(store.listProducts(OWNER).map((product) => product.name), ["uñas acrílicas", "Gel"]);

  // Un concepto largo llega recortado al banco y completo en el libro.
  const long = "Paquete de novia: peinado, maquillaje y uñas para seis personas";
  await sell(deps, OWNER, { amount: 420, concept: long });
  assert.equal(store.listCharges(OWNER).at(-1)?.concept, long);
  assert.ok((pey.qrs.at(-1)?.concept.length ?? 99) <= 40);
});

test("quién paga: el cliente con QR, su celular, o quien escribe", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);

  // Sin pagador: QR abierto. La tarjeta dice quién lo paga.
  const open = await say(deps, OWNER, calls(["prepare_charge", { amount: 0.01, concept: "Pepito" }]));
  assert.equal(store.listCharges(OWNER).at(-1)?.method, "qr");
  assert.match(textOf(open), /Cobro por \$0\.01\nConcepto: Pepito/);
  assert.match(textOf(open), /quien escanee el QR/);
  if (open[0]?.kind !== "buttons") throw new Error("esperaba la tarjeta");
  const image = await press(deps, OWNER, open[0].yesId);
  assert.match(textOf(image), /QR CoDi por \$0\.01 · Pepito/);
  assert.match(textOf(image), /1 hora/);

  // "cóbrame": notificación al celular de quien escribe.
  const mine = await say(deps, OWNER, calls(["prepare_charge", { amount: 150, concept: "uñas", payerName: "yo" }]));
  assert.match(textOf(mine), /tu celular 55 1111 1111/);
  if (mine[0]?.kind !== "buttons") throw new Error("esperaba la tarjeta");
  const sent = textOf(await press(deps, OWNER, mine[0].yesId));
  assert.match(sent, /Te llega la notificación CoDi por \$150\.00/);
  assert.match(sent, /6 minutos/);
  assert.equal(pey.pushes.at(-1)?.phone, "5511111111");

  // Un cliente sin celular ni registro: no se inventa a quién cobrarle.
  const unknown = textOf(await say(deps, OWNER, calls(["prepare_charge", { amount: 90, concept: "pan", payerName: "Ana" }])));
  assert.match(unknown, /no tengo el celular de Ana/);
  assert.equal(pey.pushes.length, 1);

  // Con celular queda de cliente, y la siguiente vez basta el nombre.
  await say(deps, OWNER, calls(["prepare_charge", { amount: 90, concept: "pan", payerName: "Ana", payerPhone: "55 2222 3333" }]));
  const again = await say(deps, OWNER, calls(["prepare_charge", { amount: 50, concept: "café", payerName: "ana" }]));
  assert.match(textOf(again), /ana · 55 2222 3333/);

  const bad = textOf(await say(deps, OWNER, calls(["prepare_charge", { amount: 10, concept: "x", payerName: "Luis", payerPhone: "12345" }])));
  assert.match(bad, /10 dígitos/);
});

test("un chat sin número pide el celular una sola vez", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());
  const ask = textOf(await say(deps, LID, calls(["prepare_charge", { amount: 150, concept: "uñas", payerName: "yo" }])));
  assert.match(ask, /no sé el celular/);
  assert.equal(store.listCharges(LID).length, 0);

  const card = await say(deps, LID, calls(["prepare_charge", { amount: 150, concept: "uñas", payerName: "yo", payerPhone: "3322054352" }]));
  assert.match(textOf(card), /tu celular 33 2205 4352/);
  assert.equal(store.getProfile(LID).phone, "3322054352");
  const next = await say(deps, LID, calls(["prepare_charge", { amount: 20, concept: "propina", payerName: "yo" }]));
  assert.match(textOf(next), /tu celular 33 2205 4352/);

  // El nombre y el negocio se guardan sin pisar el celular.
  const named = textOf(await say(deps, LID, calls(["set_profile", { name: "Isabel" }]), "me llamo Isabel"));
  assert.match(named, /se llama Isabel/);
  const shop = textOf(await say(deps, LID, calls(["set_business", { business: "Uñas Isa", dailyGoal: 2000 }])));
  assert.equal(shop, "Tu negocio: Uñas Isa. Meta del día: $0.00 de $2,000.00 (0%), faltan $2,000.00.");
  assert.deepEqual(store.getProfile(LID), { owner: LID, name: "Isabel", phone: "3322054352", business: "Uñas Isa", dailyGoalCents: 200_000 });
});

test("no se bombardea un celular: tres cobros sin pagar y Zaldo frena", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  for (let i = 0; i < 3; i++) await sell(deps, OWNER, { amount: 10, concept: "prueba", payerName: "Ana", payerPhone: "5522223333" });
  assert.equal(pey.pushes.length, 3);
  const stopped = textOf(await say(deps, OWNER, calls(["prepare_charge", { amount: 10, concept: "prueba", payerName: "Ana" }])));
  assert.match(stopped, /3 cobros sin pagar/);
  assert.equal(store.listCharges(OWNER).length, 3);
  const other = await say(deps, OWNER, calls(["prepare_charge", { amount: 10, concept: "prueba", payerName: "Luis", payerPhone: "5544445555" }]));
  assert.equal(other[0]?.kind, "buttons");
});

test("el webhook cruza por metadata y el pago abona el fiado", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  const fiado = textOf(await say(deps, OWNER, calls(["add_note", { kind: "deuda", amount: 300, concept: "uñas", who: "Ana" }])));
  assert.equal(fiado, 'Apuntado: Ana te debe $300.00 · uñas. En total te debe $300.00. Dime "cóbrale a Ana" y le mando el cobro CoDi.');
  await sell(deps, OWNER, { amount: 200, concept: "abono uñas", payerName: "Ana", payerPhone: "5522223333" });
  const charge = store.listCharges(OWNER)[0];
  if (!charge) throw new Error("falta el cobro");

  // Como lo manda Pey: sin numRef útil, con lo nuestro dentro de externalMetadata.
  const notice = applyPeyEvent(
    store,
    {
      type: "codi.pn.payment_received",
      amount: 200,
      numRef: "0",
      transactionId: "01M3QR8H0RH0XBCKYYD242YXNV",
      datePaid: 1_790_724_818,
      metadata: { clabe: "0121", externalMetadata: { chargeId: charge.id } },
    },
    NOW,
  );
  assert.equal(notice?.text, "Ya cayó: $200.00 de Ana · abono uñas. Confirmado por CoDi. Lo aboné a su fiado: le quedan $100.00.");
  assert.equal(store.getCharge(charge.id)?.status, "paid");
  assert.equal(store.getCharge(charge.id)?.paidAt, 1_790_724_818_000);

  // El QR cruza por el IDC que devolvió /codi/qr.
  await sell(deps, OWNER, { amount: 40, concept: "agua", method: "qr" });
  const qrPaid = applyPeyEvent(store, { type: "codi.qr.payment_received", codiQrId: "idc_1", numRef: "x" }, NOW);
  assert.equal(qrPaid?.text, "Ya cayó: $40.00 · agua. Confirmado por CoDi.");

  // Un evento que no es de ningún cobro no inventa nada.
  assert.equal(applyPeyEvent(store, { type: "codi.pn.payment_received", numRef: "999", transactionId: "nadie" }, NOW), null);
  assert.equal(applyPeyEvent(store, { type: "bank.account.updated" }, NOW), null);
});

test("sin webhook, Zaldo le pregunta a Pey y avisa igual", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  await sell(deps, OWNER, { amount: 150, concept: "uñas", payerName: "yo" });

  assert.deepEqual(await reconcilePending(deps), []);
  assert.equal(store.listCharges(OWNER)[0]?.status, "pending");

  pey.paid.add("txn_1");
  const notices = await reconcilePending(deps);
  assert.equal(notices.length, 1);
  assert.match(notices[0]?.text ?? "", /Ya cayó: \$150\.00, lo pagaste tú · uñas/);
  assert.equal(store.listCharges(OWNER)[0]?.status, "paid");
  assert.equal(store.listCharges(OWNER)[0]?.paidAt, NOW + 60_000);
  // Ni se avisa dos veces ni se da por vencido después.
  assert.deepEqual(await reconcilePending(deps), []);
  assert.deepEqual(takeExpired(store, NOW + 3_600_000), []);

  // Si Pey falla al consultar, el cobro sigue abierto y nada truena.
  await sell(deps, OWNER, { amount: 20, concept: "pan", payerName: "yo" });
  pey.transaction = async () => {
    throw new PeyError("caído", "SERVICE_UNAVAILABLE", 503, null);
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await reconcilePending(deps), []);
  } finally {
    console.error = quiet;
  }
  assert.equal(store.listCharges(OWNER)[1]?.status, "pending");
});

test("la caja apunta efectivo, gastos y fiado sin mover dinero", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  await say(deps, OWNER, calls(["set_business", { dailyGoal: 1000 }]));

  const cash = textOf(await say(deps, OWNER, calls(["add_note", { kind: "ingreso", amount: 250, concept: "corte" }])));
  assert.equal(cash, "Apuntado: venta en efectivo de $250.00 · corte. Meta del día: $250.00 de $1,000.00 (25%), faltan $750.00.");

  // Dos gastos en un mensaje; una categoría rara cae en "otros".
  const spent = textOf(
    await say(deps, OWNER, calls(["add_note", { kind: "gasto", amount: 300, concept: "esmaltes", category: "Insumos" }], ["add_note", { kind: "gasto", amount: 80, concept: "uber", category: "viajes" }])),
  );
  assert.equal(spent, "Apuntado: gasto de $300.00 · esmaltes (insumos).\nApuntado: gasto de $80.00 · uber (otros).");
  assert.equal(normalizeCategory("Publicidad"), "publicidad");

  const owes = textOf(await say(deps, OWNER, calls(["add_note", { kind: "debo", amount: 800, concept: "mercancía", who: "Proveedor" }])));
  assert.equal(owes, "Apuntado: le debes $800.00 a Proveedor · mercancía. En total le debes $800.00.");
  const part = textOf(await say(deps, OWNER, calls(["settle_debt", { who: "proveedor", direction: "pague", amount: 300 }])));
  assert.equal(part, "Listo: le pagaste $300.00 a proveedor. Quedan $500.00.");

  await say(deps, OWNER, calls(["add_note", { kind: "deuda", amount: 300, concept: "tinte", who: "Ana" }]));
  const paidBack = textOf(await say(deps, OWNER, calls(["settle_debt", { who: "Ana", direction: "me_pagaron" }])));
  assert.equal(paidBack, "Listo: Ana te pagó $300.00. Quedó saldado.");
  const nobody = textOf(await say(deps, OWNER, calls(["settle_debt", { who: "Pedro", direction: "me_pagaron" }])));
  assert.match(nobody, /no tengo una deuda abierta con Pedro/);

  await say(deps, OWNER, calls(["add_note", { kind: "gasto", amount: 999, concept: "error", category: "otros" }]));
  const undone = textOf(await say(deps, OWNER, calls(["undo_last", {}])));
  assert.equal(undone, "Borré: gasto de $999.00 · error.");

  assert.equal(pey.pushes.length + pey.qrs.length, 0);
  assert.equal(
    textOf(await say(deps, OWNER, calls(["get_balance", {}]))),
    [
      "Corte de hoy",
      "Ventas CoDi: $0.00",
      "Efectivo y otros: $250.00",
      "Total vendido: $250.00",
      "Gastos: $380.00 (insumos $300.00 · otros $80.00)",
      "Te queda: -$130.00",
      "Meta del día: $250.00 de $1,000.00 (25%), faltan $750.00",
      "Debes: $500.00 (Proveedor $500.00)",
    ].join("\n"),
  );
});

test("el corte de caja: ventas confirmadas, ticket promedio y lo más vendido", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  await say(deps, OWNER, calls(["set_product", { name: "uñas acrílicas", price: 350 }], ["set_product", { name: "gel", price: 200 }]));
  await say(deps, OWNER, calls(["set_business", { business: "Uñas Isa", dailyGoal: 2000 }]));

  // Tres ventas: dos por QR y una por notificación. Una cuarta se queda sin pagar.
  await sell(deps, OWNER, { items: [{ name: "uñas acrílicas", qty: 2 }, { name: "gel" }] });
  await sell(deps, OWNER, { items: [{ name: "gel", qty: 2 }] });
  await sell(deps, OWNER, { items: [{ name: "uñas acrílicas" }], payerName: "Ana", payerPhone: "5522223333" });
  await sell(deps, OWNER, { amount: 120, concept: "decorado", payerName: "Luis", payerPhone: "5544445555" });
  const [first, second] = store.listCharges(OWNER);
  if (!first || !second) throw new Error("faltan cobros");

  // Antes de que el banco confirme, nada cuenta como vendido.
  assert.match(corteText(store, OWNER, "hoy", NOW), /Ventas CoDi: \$0\.00\nTotal vendido: \$0\.00/);
  assert.match(corteText(store, OWNER, "hoy", NOW), /Por cobrar: 4 cobros esperando pago \(\$1,770\.00\)/);

  applyPeyEvent(store, { type: "codi.qr.payment_received", metadata: { externalMetadata: { chargeId: first.id } } }, NOW);
  const paid2 = applyPeyEvent(store, { type: "codi.qr.payment_received", metadata: { externalMetadata: { chargeId: second.id } } }, NOW);
  assert.match(paid2?.text ?? "", /Meta del día: \$1,300\.00 de \$2,000\.00 \(65%\), faltan \$700\.00/);
  pey.paid.add("txn_1");
  await reconcilePending(deps);
  await say(deps, OWNER, calls(["add_note", { kind: "ingreso", amount: 150, concept: "corte" }], ["add_note", { kind: "gasto", amount: 300, concept: "esmaltes", category: "insumos" }]));
  // El cobro de Luis vence sin pagarse.
  const later = NOW + 7 * 60_000;
  takeExpired(store, later);

  assert.equal(
    corteText(store, OWNER, "hoy", later),
    [
      "Corte de hoy · Uñas Isa",
      "Ventas CoDi: $1,650.00 en 3 cobros (ticket promedio $550.00)",
      "Cómo pagaron: QR $1,300.00 · notificación $350.00",
      "Efectivo y otros: $150.00",
      "Total vendido: $1,800.00",
      "Lo más vendido: uñas acrílicas ×3 ($1,050.00) · gel ×3 ($600.00) · corte ×1 ($150.00)",
      "Gastos: $300.00 (insumos $300.00)",
      "Te queda: $1,500.00",
      "Meta del día: $1,800.00 de $2,000.00 (90%), faltan $200.00",
      "Vencidos sin pagar: 1",
    ].join("\n"),
  );

  // Los periodos, en hora de México.
  const day = 24 * 3_600_000;
  store.insertNote({ id: "viejo", owner: OWNER, kind: "ingreso", amountCents: 99_900, concept: "evento", who: null, createdAt: NOW - 20 * day });
  assert.match(corteText(store, OWNER, "semana", later), /Corte de esta semana · Uñas Isa/);
  assert.match(corteText(store, OWNER, "mes", later), /Corte de noviembre/);
  const lastMonth = corteText(store, OWNER, "mes_pasado", later);
  assert.match(lastMonth, /Corte de octubre/);
  assert.match(lastMonth, /Total vendido: \$999\.00/);
  assert.doesNotMatch(lastMonth, /Meta del día|Vencidos/);
  assert.equal(periodRange("semana", NOW).start, Date.parse("2026-11-09T06:00:00.000Z"));
  assert.equal(periodRange("mes", NOW).start, Date.parse("2026-11-01T06:00:00.000Z"));
  assert.equal(periodRange("mes_pasado", NOW).end, Date.parse("2026-11-01T06:00:00.000Z"));
  assert.equal(periodRange("mes_pasado", Date.parse("2026-01-10T18:00:00.000Z")).label, "diciembre");

  // "Otra igual": repite el ticket con sus precios.
  const again = await say(deps, OWNER, calls(["repeat_charge", { payerName: "Ana" }]));
  assert.match(textOf(again), /Cobro por \$350\.00\n1 × uñas acrílicas · \$350\.00\nLe llega a: Ana · 55 2222 3333/);
});

test("las cifras salen del libro, no del modelo", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());

  // Con la herramienta hecha, el mensaje es su resultado: no hay segunda vuelta al modelo.
  let asked = 0;
  const once: Completer = async () => {
    asked += 1;
    if (asked > 1) return { content: "Llevas como $999 vendidos, creo.", toolCalls: [] };
    return { content: null, toolCalls: [call("add_note", { kind: "gasto", amount: 250, concept: "tacos", category: "comida" })] };
  };
  assert.equal(textOf(await say(deps, OWNER, once)), "Apuntado: gasto de $250.00 · tacos (comida).");
  assert.equal(asked, 1);

  // Si la herramienta falla, sí vuelve al modelo para que pregunte.
  asked = 0;
  const failing: Completer = async ({ messages }) => {
    asked += 1;
    if (asked === 1) return { content: null, toolCalls: [call("add_note", { kind: "deuda", amount: 100, concept: "pan" })] };
    assert.match(messages.at(-1)?.content ?? "", /^ERROR: falta el nombre/);
    return { content: "¿Quién te quedó a deber esos $100?", toolCalls: [] };
  };
  assert.equal(textOf(await say(deps, OWNER, failing)), "¿Quién te quedó a deber esos $100?");
  assert.equal(asked, 2);

  // El modelo presume que apuntó sin llamar a nada: se le exige hacerlo de verdad.
  asked = 0;
  const liar: Completer = async ({ messages }) => {
    asked += 1;
    if (asked === 1) return { content: "Listo, ya quedó apuntada tu venta de $3,000.00.", toolCalls: [] };
    assert.equal(messages.at(-1)?.role, "system");
    return { content: null, toolCalls: [call("add_note", { kind: "ingreso", amount: 3000, concept: "evento" })] };
  };
  assert.equal(textOf(await say(deps, OWNER, liar)), "Apuntado: venta en efectivo de $3,000.00 · evento.");
  assert.equal(store.listNotes(OWNER).filter((note) => note.kind === "ingreso").length, 1);

  // Si insiste en presumir, la persona recibe la verdad, no un "apuntado" falso.
  asked = 0;
  const stubborn: Completer = async () => {
    asked += 1;
    return { content: "Apunté tu gasto de $400.00 en el súper.", toolCalls: [] };
  };
  const honest = textOf(await say(deps, OWNER, stubborn));
  assert.match(honest, /^No me quedó claro qué hacer/);
  assert.equal(asked, 2);
  assert.equal(store.listNotes(OWNER).filter((note) => note.kind === "gasto").length, 1);

  // Si tras el aviso contesta sin presumir, pasa tal cual.
  asked = 0;
  const corrected: Completer = async () => {
    asked += 1;
    return { content: asked === 1 ? "Ya agregué el tinte." : "¿A cuánto cobras el tinte?", toolCalls: [] };
  };
  assert.equal(textOf(await say(deps, OWNER, corrected)), "¿A cuánto cobras el tinte?");

  // El modelo se niega a cobrar un centavo ("el mínimo es 1 peso"): eso lo decide la caja, no él.
  asked = 0;
  const refuser: Completer = async ({ messages }) => {
    asked += 1;
    if (asked === 1) return { content: "No puedo generar un cobro de 0.01, ya que el mínimo es 1 peso.", toolCalls: [] };
    assert.equal(messages.at(-1)?.role, "system");
    return { content: null, toolCalls: [call("prepare_charge", { amount: 0.01, concept: "prueba" })] };
  };
  const cent = await say(deps, OWNER, refuser, "dame un QR de 0.01 de prueba");
  starts(textOf(cent), "Cobro por $0.01");
  assert.equal(asked, 2);

  // Explicar que cobra y no paga no cuenta como negarse.
  asked = 0;
  await say(deps, OWNER, async () => {
    asked += 1;
    return { content: "Yo no muevo tu dinero: yo cobro. Si quieres pagar algo aquí, te mando el cobro CoDi. ¿De cuánto?", toolCalls: [] };
  }, "quiero hacer un pago");
  assert.equal(asked, 1);

  // Una plática normal no dispara nada.
  asked = 0;
  const chat: Completer = async () => {
    asked += 1;
    return { content: "¡Qué onda! ¿Armamos un cobro, apuntamos una venta o vemos el corte?", toolCalls: [] };
  };
  await say(deps, OWNER, chat);
  assert.equal(asked, 1);
});

test("un cobro nunca lleva un monto que nadie dijo", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);

  // "cobra una gringa" sin catálogo: el modelo inventa $60. No pasa.
  const invented = textOf(await say(deps, OWNER, calls(["prepare_charge", { amount: 60, concept: "gringa" }]), "cobra una gringa"));
  starts(invented, "Me falta el monto. ¿De cuánto es el cobro?");
  const inventedItem = textOf(await say(deps, OWNER, calls(["prepare_charge", { items: [{ name: "gringa", price: 60 }] }]), "cobra una gringa"));
  starts(inventedItem, 'No tengo "gringa" en tu catálogo. ¿A cuánto lo cobro?');
  const guessed = textOf(await say(deps, OWNER, calls(["prepare_charge", { amount: 130, concept: "2 gringas" }]), "cobra dos gringas"));
  starts(guessed, "Me falta el monto.");
  assert.equal(store.listCharges(OWNER).length, 0);

  // Si el modelo cambia la cifra que la persona escribió, manda la de la persona.
  const cent = await say(deps, OWNER, calls(["prepare_charge", { amount: 1, concept: "prueba" }]), "dame un QR de 0.01 de prueba");
  starts(textOf(cent), "Cobro por $0.01");
  const pesos = await say(deps, OWNER, calls(["prepare_charge", { amount: 1500, concept: "uñas" }]), "cobra 150 pesos de uñas");
  starts(textOf(pesos), "Cobro por $150.00");
  const dollar = await say(deps, OWNER, calls(["prepare_charge", { concept: "corte" }]), "cobra $80 de un corte");
  starts(textOf(dollar), "Cobro por $80.00");
  // "1 centavo" es un centavo aunque el modelo mande un peso, o lo mande bien.
  const oneCent = await say(deps, OWNER, calls(["prepare_charge", { amount: 1, concept: "prueba" }]), "cobra 1 centavo de prueba");
  starts(textOf(oneCent), "Cobro por $0.01");
  const fifty = await say(deps, OWNER, calls(["prepare_charge", { amount: 0.5, concept: "chicle" }]), "cobra 50 centavos de un chicle");
  starts(textOf(fifty), "Cobro por $0.50");
  // Con dos montos en el mensaje no se adivina cuál; una cantidad suelta ("3 tintes") no es dinero.
  const two = textOf(await say(deps, OWNER, calls(["prepare_charge", { amount: 999, concept: "varios" }]), "cobra 150 pesos y 300 pesos"));
  starts(two, "Me falta el monto.");
  const qty = textOf(await say(deps, OWNER, calls(["prepare_charge", { amount: 1350, concept: "3 tintes" }]), "cobra 3 tintes"));
  starts(qty, "Me falta el monto.");
  assert.equal(store.listCharges(OWNER).length, 5);

  // En cuanto la persona lo dice, sí: suelto, por pieza o con formato.
  const said = await say(deps, OWNER, calls(["prepare_charge", { amount: 65, concept: "gringa" }]), "a 65");
  assert.equal(said[0]?.kind, "buttons");
  const perPiece = await say(deps, OWNER, calls(["prepare_charge", { items: [{ name: "gringa", qty: 2, price: 65 }] }]), "mejor dos");
  assert.match(textOf(perPiece), /Cobro por \$130\.00/);
  const formatted = await say(deps, OWNER, calls(["prepare_charge", { amount: 1500, concept: "evento" }]), "cobra $1,500.00 del evento.");
  assert.equal(formatted[0]?.kind, "buttons");

  // Dicho con letra en una nota de voz: no se puede cotejar, pero la persona sí dijo un monto.
  const spoken = await say(deps, OWNER, calls(["prepare_charge", { amount: 150, concept: "uñas", payerName: "yo" }]), "cóbrame ciento cincuenta pesos de uñas");
  assert.equal(spoken[0]?.kind, "buttons");

  // Un fiado apuntado es un monto del libro: "cóbrale lo que me debe" no necesita repetirlo.
  const other = memoryStore();
  const otherDeps = flow(other, pey);
  other.insertNote({ id: "f1", owner: OWNER, kind: "deuda", amountCents: 35_000, concept: "uñas", who: "Lupita", createdAt: NOW, paidCents: 0 });
  const debt = await say(otherDeps, OWNER, calls(["prepare_charge", { amount: 350, concept: "uñas", payerName: "Lupita", payerPhone: "5522223333" }]), "cóbrale a Lupita lo que me debe, su cel es 5522223333");
  assert.match(textOf(debt), /Cobro por \$350\.00/);
  const wrong = textOf(await say(otherDeps, OWNER, calls(["prepare_charge", { amount: 400, concept: "uñas", payerName: "Lupita" }]), "cóbrale a Lupita lo que me debe"));
  starts(wrong, "Me falta el monto.");

  // "Cobra un corte" es una venta a un cliente: aunque el modelo diga "yo", sale QR.
  const shop = memoryStore();
  const shopDeps = flow(shop, pey);
  const sale = await say(shopDeps, OWNER, calls(["prepare_charge", { amount: 150, concept: "corte", payerName: "yo", method: "push" }]), "cobra 150 de un corte");
  assert.match(textOf(sale), /quien escanee el QR/);
  assert.equal(shop.listCharges(OWNER)[0]?.method, "qr");
  assert.equal(shop.listCharges(OWNER)[0]?.payerPhone, null);
  // Si él lo pide, sí le llega a su celular.
  const own = await say(shopDeps, OWNER, calls(["prepare_charge", { amount: 150, concept: "corte", payerName: "yo" }]), "cóbrame 150 a mí, es una prueba");
  assert.match(textOf(own), /tu celular 55 1111 1111/);

  // Repetir un cobro usa sus propios montos, no los del modelo.
  const again = await say(deps, OWNER, calls(["repeat_charge", {}]), "otra igual");
  assert.equal(again[0]?.kind, "buttons");
});

test("modo de prueba: la cuenta de pruebas de pey y su tope", async () => {
  // La cuenta que recibe viaja en cada cobro CoDi; sin ella, pey usa la ligada a la llave.
  const sent: Record<string, unknown>[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ id: "01JBAVWE4NS5TGXHWGMX3KH23Q", codiStatus: "PENDING", qrString: "{}", transactionId: "t" }), { status: 200 });
  };
  const receiver = new PeyClient("https://api.pey.mx", "k", fakeFetch, { bankAccountId: "01JBAVWE4NS5TGXHWGMX3KH23Q" });
  await receiver.qr({ amountCents: 1, concept: "x", numRef: "1", chargeId: "c", expirationSec: 360 });
  await receiver.push({ amountCents: 1, phone: "5512345678", concept: "x", numRef: "1", chargeId: "c", expirationSec: 360 });
  assert.equal(sent[0]?.bankAccountId, "01JBAVWE4NS5TGXHWGMX3KH23Q");
  assert.equal(sent[1]?.bankAccountId, "01JBAVWE4NS5TGXHWGMX3KH23Q");
  const plain = new PeyClient("https://api.pey.mx", "k", fakeFetch);
  await plain.qr({ amountCents: 1, concept: "x", numRef: "1", chargeId: "c", expirationSec: 360 });
  assert.equal("bankAccountId" in (sent[2] ?? {}), false);
  const account = await plain.registerBankAccount({ alias: "a", name: "n", clabe: "012180015826225713", entity: "PERSON" });
  assert.deepEqual(account, { id: "01JBAVWE4NS5TGXHWGMX3KH23Q", codiStatus: "PENDING" });
  assert.deepEqual(sent[3], { alias: "a", name: "n", clabe: "012180015826225713", entity: "PERSON" });

  // En modo de prueba nadie cobra de más: ese dinero no se devuelve.
  const store = memoryStore();
  const deps = flow(store, fakePey(), { testMaxCents: 100 });
  // El aviso lo da la caja tal cual: el modelo no vuelve a opinar.
  let asked = 0;
  const big = textOf(
    await say(deps, OWNER, async () => {
      asked += 1;
      if (asked > 1) return { content: "¿A qué celular te lo mando?", toolCalls: [] };
      return { content: null, toolCalls: [call("prepare_charge", { amount: 150, concept: "uñas" })] };
    }),
  );
  assert.equal(asked, 1);
  starts(big, "Esta caja está en modo de prueba: por ahora cobro máximo $1.00 por cobro");
  assert.equal(store.listCharges(OWNER).length, 0);
  const small = textOf(await say(deps, OWNER, calls(["prepare_charge", { amount: 0.01, concept: "prueba" }])));
  starts(small, "Cobro por $0.01");
  assert.match(small, /Modo de prueba: el pago va a la cuenta de pruebas de pey, no a tu banco, y no se devuelve\. Para recibir en tu banco dime "registrar mi cuenta"\.$/);

  // Fuera del modo de prueba, ni tope ni aviso.
  const normal = textOf(await say(flow(memoryStore(), fakePey()), OWNER, calls(["prepare_charge", { amount: 150, concept: "uñas" }])));
  starts(normal, "Cobro por $150.00");
  assert.ok(!normal.includes("Modo de prueba"));
});

test("confirmar y cancelar los resuelve la caja, no el modelo", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  await say(deps, OWNER, calls(["add_note", { kind: "deuda", amount: 350, concept: "uñas", who: "Lupita" }]));
  const never: Completer = async () => {
    throw new Error("el modelo no debió participar");
  };

  // Sin cobro pendiente, "cancelar" no llega al modelo ni borra nada.
  assert.match(textOf(await say(deps, OWNER, never, "Cancelar")), /No hay ningún cobro esperando confirmación/);
  assert.match(textOf(await say(deps, OWNER, never, "confirmar")), /No hay ningún cobro esperando confirmación/);
  assert.equal(store.listNotes(OWNER).length, 1);

  // Con cobro pendiente, la palabra hace de botón.
  await say(deps, OWNER, calls(["prepare_charge", { amount: 150, concept: "uñas" }]));
  assert.match(textOf(await say(deps, OWNER, never, "cancelar")), /Cancelé el cobro de \$150\.00/);
  assert.equal(pey.qrs.length, 0);
  await say(deps, OWNER, calls(["prepare_charge", { amount: 150, concept: "uñas" }]));
  const image = await say(deps, OWNER, never, "Sí");
  assert.equal(image[0]?.kind, "image");
  assert.equal(pey.qrs.length, 1);

  // Un "no" o un "sí" sueltos, sin cobro pendiente, son plática normal.
  let asked = 0;
  await say(deps, OWNER, async () => {
    asked += 1;
    return { content: "Va.", toolCalls: [] };
  }, "no");
  assert.equal(asked, 1);
});

test("el modelo recuerda sus herramientas como llamadas, no como texto", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());
  await say(deps, OWNER, calls(["add_note", { kind: "ingreso", amount: 200, concept: "corte" }]), "me pagaron 200 de un corte");
  await say(deps, OWNER, calls(["prepare_charge", { amount: 150, concept: "uñas" }]), "cobra 150 de uñas");

  let seen: ChatMessage[] = [];
  await say(
    deps,
    OWNER,
    async ({ messages }) => {
      seen = messages;
      return { content: "Va.", toolCalls: [] };
    },
    "gracias",
  );
  const shape = seen.slice(1).map((message) => (message.tool_calls ? `call:${message.tool_calls[0]?.function.name}` : message.role));
  assert.deepEqual(shape, [
    "user",
    "call:add_note",
    "tool",
    "user",
    "call:prepare_charge",
    "tool",
    "assistant", // la tarjeta que vio la persona
    "user",
  ]);
  // El "Apuntado" vive en el resultado de la herramienta, nunca como texto del asistente.
  const assistantTexts = seen.filter((message) => message.role === "assistant" && message.content).map((message) => message.content ?? "");
  assert.equal(assistantTexts.filter((text) => text.startsWith("Apuntado")).length, 0);
  const toolIds = seen.filter((message) => message.role === "tool").map((message) => message.tool_call_id);
  const callIds = seen.flatMap((message) => message.tool_calls?.map((item) => item.id) ?? []);
  assert.deepEqual(toolIds, callIds);
});

test("un libro de antes (sin catálogo ni perfiles) se abre igual", () => {
  const dir = mkdtempSync(join(tmpdir(), "zaldo-viejo-"));
  const path = join(dir, "zaldo.json");
  writeFileSync(
    path,
    JSON.stringify({
      charges: [],
      notes: [{ id: "n1", owner: OWNER, kind: "deuda", amountCents: 8000, concept: "Luis", who: "Luis", createdAt: NOW }],
      contacts: [],
      turns: { [OWNER]: [{ role: "user", content: "hola", at: NOW }] },
      claims: {},
    }),
  );
  const store = fileStore(path);
  assert.deepEqual(store.listProducts(OWNER), []);
  assert.equal(store.getProfile(OWNER).name, null);
  assert.match(corteText(store, OWNER, "hoy", NOW), /Fiado: \$80\.00 \(Luis \$80\.00\)/);
  store.setProduct({ owner: OWNER, name: "corte", priceCents: 15_000 });
  store.setProfile({ owner: OWNER, name: "Toro", phone: null });
  const reopened = fileStore(path);
  assert.equal(reopened.getProfile(OWNER).name, "Toro");
  assert.equal(reopened.findProduct(OWNER, "Cortes")?.priceCents, 15_000);
});

test("la tarjeta dice claro a quién le llega el cobro", () => {
  const base = {
    id: "c",
    owner: OWNER,
    amountCents: 15000,
    concept: "uñas",
    status: "awaiting_confirm" as const,
    numRef: null,
    peyTransactionId: null,
    peyExternalId: null,
    linkUrl: null,
    createdAt: NOW,
    confirmBy: NOW,
    expiresAt: null,
    paidAt: null,
    expiryNotified: false,
    paidNoticeSent: false,
  };
  const push = chargeCard({ ...base, payerName: "Ana", payerPhone: "5522223333", method: "push" });
  assert.equal(
    push,
    "Cobro por $150.00\nConcepto: uñas\nLe llega a: Ana · 55 2222 3333, en la app de su banco\nPor: notificación CoDi",
  );
  const link = chargeCard({ ...base, payerName: "quien pague", payerPhone: null, method: "link" });
  assert.match(link, /quien abra el link \(CoDi o tarjeta\)/);
});
