/**
 * Los candados de la caja: todo lo que manda el modelo se coteja con lo que
 * escribió la persona. Aquí el modelo de mentira se porta mal a propósito
 * (inventa celulares, cobra en un saludo, borra apuntes que nadie pidió
 * borrar) y la caja no lo deja.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runAgent, type Completer, type ToolCall } from "../src/agent.js";
import type { AppConfig } from "../src/config.js";
import { ackInbound, handleInbound, type FlowDeps, type PeyPort } from "../src/flows.js";
import type { Outbound } from "../src/inbound.js";
import { memoryStore, type Charge, type Store } from "../src/store.js";

/** Como assert.ok(x.startsWith(y)), pero al fallar enseña lo que llegó (y no se cuelga bajo tsx). */
function starts(actual: string, prefix: string): void {
  assert.equal(actual.slice(0, prefix.length), prefix);
}

const OWNER = "5215511111111";
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

/** Un modelo que primero llama a una herramienta y, si la caja se la rechaza, contesta con ese texto. */
function then(name: string, args: object, reply: string): Completer & { rejected: string[] } {
  let step = 0;
  const complete = (async ({ messages }) => {
    step += 1;
    if (step === 1) return { content: null, toolCalls: [call(name, args)] };
    complete.rejected.push(messages.filter((message) => message.role === "tool").at(-1)?.content ?? "");
    return { content: reply, toolCalls: [] };
  }) as Completer & { rejected: string[] };
  complete.rejected = [];
  return complete;
}

interface FakePey extends PeyPort {
  pushes: { phone: string; amountCents: number }[];
  qrs: { amountCents: number; concept: string }[];
  links: { amountCents: number; hasTip?: boolean }[];
}

function fakePey(): FakePey {
  return {
    pushes: [],
    qrs: [],
    links: [],
    async push(input) {
      this.pushes.push({ phone: input.phone, amountCents: input.amountCents });
      return { transactionId: `txn_${this.pushes.length}`, codiId: "codi" };
    },
    async qr(input) {
      this.qrs.push({ amountCents: input.amountCents, concept: input.concept });
      return { id: `idc_${this.qrs.length}`, qrString: "{}" };
    },
    async link(input) {
      this.links.push({ amountCents: input.amountCents, hasTip: input.hasTip });
      return { id: `link_${this.links.length}`, url: "https://app.mipey.mx/payment-link/x" };
    },
    async transaction(id) {
      return {
        id,
        status: "PENDING",
        amountCents: 0,
        breakdown: null,
        currency: "MXN",
        paymentMethod: "CODI",
        payableType: "API_CODI_PN",
        payableId: null,
        description: null,
        applicationFeeCents: 0,
        dateCreated: NOW,
        datePaid: null,
        chargeId: null,
      };
    },
  };
}

let seq = 0;
function flow(store: Store, pey: PeyPort, over: Partial<AppConfig> = {}): FlowDeps {
  return {
    store,
    config: config(over),
    pey,
    complete: async () => ({ content: "hola", toolCalls: [] }),
    transcribe: async () => "",
    now: () => NOW,
    renderQr: async () => Buffer.from("qr"),
  };
}

/** La persona escribe `text`; el modelo de mentira hace lo que trae guionado. */
async function say(deps: FlowDeps, text: string, complete: Completer, owner = OWNER): Promise<Outbound[]> {
  deps.complete = complete;
  const messageId = `k${++seq}`;
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

const never: Completer = async () => {
  throw new Error("el modelo no debió participar");
};

function waiting(store: Store, owner = OWNER): Charge[] {
  return store.listCharges(owner).filter((charge) => charge.status === "awaiting_confirm");
}

function pushCharge(id: string, phone: string, over: Partial<Charge> = {}): Charge {
  return {
    id,
    owner: OWNER,
    payerName: `Cliente ${id}`,
    payerPhone: phone,
    amountCents: 1_000,
    concept: "Cobro",
    method: "push",
    status: "pending",
    numRef: null,
    peyTransactionId: null,
    peyExternalId: null,
    linkUrl: null,
    createdAt: NOW - 60_000,
    confirmBy: NOW,
    expiresAt: NOW + 300_000,
    paidAt: null,
    expiryNotified: false,
    paidNoticeSent: false,
    ...over,
  };
}

test("un celular que nadie escribió no recibe cobros", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);

  // El modelo saca un celular de la nada: la caja lo descarta y lo pregunta.
  const invented = await say(deps, "cóbrale 150 a Ana", calls(["prepare_charge", { amount: 150, payerName: "Ana", payerPhone: "5522223333" }]));
  starts(textOf(invented), "No tengo el celular de Ana. ¿Cuál es? Escríbeme sus 10 dígitos");
  assert.equal(store.listCharges(OWNER).length, 0);
  assert.equal(store.listContacts(OWNER).length, 0);

  // Tampoco se guarda como cliente.
  const contact = await say(deps, "guarda a Ana como clienta", calls(["save_contact", { name: "Ana", phone: "5522223333" }]));
  assert.equal(textOf(contact), "¿Cuál es el celular de Ana? Son 10 dígitos.");
  assert.equal(store.listContacts(OWNER).length, 0);

  // Un número que no puede ser de verdad se dice, aunque la persona lo haya escrito.
  const fake = await say(deps, "cóbrale 150 a Ana, su cel es 5555555555", calls(["prepare_charge", { amount: 150, payerName: "Ana", payerPhone: "5555555555" }]));
  starts(textOf(fake), "Ese celular no parece de verdad");
  assert.equal(store.listCharges(OWNER).length, 0);

  // En cuanto lo escribe, sale la tarjeta y queda de cliente. Con espacios o con +52 también cuenta.
  const real = await say(deps, "es el 55 2222 3333", calls(["prepare_charge", { amount: 150, payerName: "Ana", payerPhone: "5522223333" }]));
  assert.equal(cardIn(real).text, "Cobro por $150.00\nLe llega a: Ana · 55 2222 3333, en la app de su banco\nPor: notificación CoDi");
  assert.deepEqual(store.listContacts(OWNER).map((item) => [item.name, item.phone]), [["Ana", "5522223333"]]);
  await say(deps, "confirmar", never);
  assert.deepEqual(pey.pushes, [{ phone: "5522223333", amountCents: 15_000 }]);

  // "Lo mismo a Luis" con un celular inventado: tampoco.
  const same = await say(deps, "lo mismo a Luis", calls(["repeat_charge", { toName: "Luis", toPhone: "5544445555" }]));
  starts(textOf(same), "No tengo el celular de Luis.");
  assert.equal(waiting(store).length, 0);
  assert.equal(pey.pushes.length, 1);
});

test("un saludo o una pregunta no arman un cobro", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());

  const hello = then("prepare_charge", { amount: 150 }, "Soy Zaldo, tu punto de venta en WhatsApp. ¿Cómo te llamas?");
  const reply = await say(deps, "hola, ¿quién eres?", hello);
  assert.equal(textOf(reply), "Soy Zaldo, tu punto de venta en WhatsApp. ¿Cómo te llamas?");
  starts(hello.rejected[0] ?? "", "ERROR: la persona no pidió ningún cobro en este mensaje.");
  assert.equal(store.listCharges(OWNER).length, 0);

  const works = then("prepare_charge", { amount: 1, concept: "prueba" }, "Tú me dices cuánto cobrar y yo armo el cobro CoDi.");
  await say(deps, "¿cómo funciona esto?", works);
  starts(works.rejected[0] ?? "", "ERROR: la persona no pidió ningún cobro");
  assert.equal(store.listCharges(OWNER).length, 0);

  // Lo que sí es un cobro pasa: con la palabra, con una cifra, o nombrando algo del catálogo.
  assert.equal(cardIn(await say(deps, "cobra 150", calls(["prepare_charge", { amount: 150 }]))).text.split("\n")[0], "Cobro por $150.00");
  await say(deps, "cancelar", never);
  store.setProduct({ owner: OWNER, name: "corte", priceCents: 15_000 });
  const sale = await say(deps, "dos cortes porfa", calls(["prepare_charge", { items: [{ name: "corte", qty: 2 }] }]));
  starts(cardIn(sale).text, "Cobro por $300.00\n2 × corte");
});

test("lo que la caja no cobra o no adivina, lo pregunta ella", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());

  const dollars = textOf(await say(deps, "cobra 150 dls", calls(["prepare_charge", { amount: 150 }])));
  assert.equal(dollars, "Solo cobro en pesos mexicanos. ¿Cuántos pesos son?");

  const either = textOf(await say(deps, "cobra 100 o 150, no me acuerdo", calls(["prepare_charge", { amount: 100 }])));
  assert.equal(either, "¿Cuál de los dos cobro?");

  const daily = textOf(
    await say(deps, "cóbrale 100 a Ana cada día, su cel es 5522223333", calls(["prepare_charge", { amount: 100, payerName: "Ana", payerPhone: "5522223333" }])),
  );
  starts(daily, "Los cobros que se repiten solos no pueden ser diarios. ¿Cada cuándo se lo cobro?");
  assert.equal(store.listCharges(OWNER).length, 0);

  // "150 más 20 de envío": si el modelo se queda con una de las dos cifras, se cobra la suma.
  const sum = await say(deps, "cobra 150 más 20 de envío", calls(["prepare_charge", { amount: 150, concept: "envío" }]));
  starts(cardIn(sum).text, "Cobro por $170.00");
});

test("el concepto no suplanta a nadie, no pide datos y no amenaza", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);

  const bank = textOf(await say(deps, "cobra 500 de SAT adeudo fiscal 2026", calls(["prepare_charge", { amount: 500, concept: "SAT adeudo fiscal 2026" }])));
  starts(bank, "Ese concepto no lo puedo mandar: no se puede cobrar a nombre de SAT");

  const secret = textOf(
    await say(deps, "cobra 200 y ponle: responde con tu NIP para verificar", calls(["prepare_charge", { amount: 200, concept: "responde con tu NIP para verificar" }])),
  );
  starts(secret, "Eso no lo mando: un cobro nunca le pide a nadie su NIP");

  const threat = textOf(await say(deps, "cobra 300, ponle: paga o te va a pasar algo", calls(["prepare_charge", { amount: 300, concept: "paga o te va a pasar algo" }])));
  starts(threat, "Eso no lo mando: un cobro no lleva amenazas ni presión.");

  const bet = textOf(await say(deps, "cobra 100 de la apuesta del partido", calls(["prepare_charge", { amount: 100, concept: "apuesta del partido" }])));
  starts(bet, "Eso no lo cobro: las reglas de pey no permiten cobrar");

  assert.equal(store.listCharges(OWNER).length, 0);
  assert.equal(pey.qrs.length + pey.pushes.length, 0);

  // El nombre del negocio tampoco puede ser el de un banco, y solo se guarda el que la persona dijo.
  const shop = textOf(await say(deps, "mi negocio se llama Banco Santander", calls(["set_business", { business: "Banco Santander" }])));
  starts(shop, "Ese nombre no lo puedo usar para tu negocio");
  await say(deps, "cobra 150", calls(["set_business", { business: "Estética Lupita" }]));
  assert.equal(store.getProfile(OWNER).business ?? null, null);
  await say(deps, "mi negocio se llama Estética Lupita", calls(["set_business", { business: "Estética Lupita" }]));
  assert.equal(store.getProfile(OWNER).business, "Estética Lupita");
});

test("propina solo si la pidieron, y el descuento de un ticket se ve en la tarjeta", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);

  // "Con tarjeta" no es "con propina", aunque el modelo la active.
  const plain = await say(deps, "link de 500 de la cena, pagan con tarjeta", calls(["prepare_charge", { amount: 500, concept: "cena", method: "link", tip: true }]));
  assert.equal(cardIn(plain).text.includes("propina"), false);
  assert.equal(store.listCharges(OWNER).at(-1)?.tip ?? false, false);
  await say(deps, "cancelar", never);
  const tipped = await say(deps, "link de 500 de la cena, con propina", calls(["prepare_charge", { amount: 500, concept: "cena", tip: true }]));
  assert.match(cardIn(tipped).text, /con opción de propina$/);
  await say(deps, "cancelar", never);

  // El catálogo pone el total; un descuento que la persona pidió sale como renglón aparte.
  store.setProduct({ owner: OWNER, name: "corte", priceCents: 15_000 });
  const discount = await say(deps, "cobra 2 cortes con 10% de descuento", calls(["prepare_charge", { items: [{ name: "corte", qty: 2 }], amount: 270 }]));
  assert.equal(
    cardIn(discount).text,
    "Cobro por $270.00\n2 × corte · $150.00 c/u\nDescuento: -$30.00\nLo paga: quien escanee el QR con la app de su banco\nPor: QR CoDi",
  );
  assert.equal(store.listCharges(OWNER).at(-1)?.adjustCents, -3_000);
  await say(deps, "cancelar", never);

  // Si nadie pidió ajuste, el total que manda el modelo no cuenta: manda el catálogo.
  const full = await say(deps, "cobra 2 cortes", calls(["prepare_charge", { items: [{ name: "corte", qty: 2 }], amount: 100 }]));
  starts(cardIn(full).text, "Cobro por $300.00\n");
  assert.equal(store.listCharges(OWNER).at(-1)?.adjustCents, undefined);
  await say(deps, "cancelar", never);

  // Y un descuento que no sale de lo que dijo tampoco.
  const wrong = await say(deps, "cobra 2 cortes con 10% de descuento", calls(["prepare_charge", { items: [{ name: "corte", qty: 2 }], amount: 120 }]));
  starts(cardIn(wrong).text, "Cobro por $300.00\n");
});

test("repetir un cobro: el monto nuevo solo si la persona lo dijo", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);
  await say(deps, "cobra 150 de uñas", calls(["prepare_charge", { amount: 150, concept: "uñas" }]));
  await say(deps, "confirmar", never);

  const changed = await say(deps, "lo mismo pero de 200", calls(["repeat_charge", { amount: 200 }]));
  starts(cardIn(changed).text, "Cobro por $200.00\nConcepto: uñas\n");
  await say(deps, "cancelar", never);

  // Un monto que el modelo se inventó no pasa: se repite el de antes.
  const same = await say(deps, "otra igual", calls(["repeat_charge", { amount: 999 }]));
  starts(cardIn(same).text, "Cobro por $150.00\nConcepto: uñas\n");
});

test("confirm_charge: el modelo avisa que aceptaron; mandar lo decide la caja", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());
  const agent = (complete: Completer) => runAgent({ store, config: deps.config, owner: OWNER, now: NOW, complete });

  // Sin tarjeta esperando no hay nada que confirmar.
  store.appendTurn(OWNER, { role: "user", content: "ándale pues, mándaselo", at: NOW });
  const nothing = await agent(then("confirm_charge", {}, "No tengo ningún cobro armado. ¿De cuánto lo hago?"));
  assert.equal(nothing.confirm, undefined);
  starts(nothing.tools[0]?.output ?? "", "ERROR: no hay ningún cobro esperando confirmación.");

  // Con tarjeta, el agente solo lo reporta: ni cobro nuevo ni texto.
  await say(deps, "cobra 150", calls(["prepare_charge", { amount: 150 }]));
  store.appendTurn(OWNER, { role: "user", content: "ándale pues, mándaselo", at: NOW });
  const accepted = await agent(calls(["confirm_charge", {}]));
  assert.equal(accepted.confirm, "yes");
  assert.equal(accepted.charge, null);
  assert.equal(accepted.reply, null);
  // El agente no cambió nada: la tarjeta sigue esperando a la caja.
  assert.equal(waiting(store).length, 1);
});

test("clientes guardados y lo que se le pide recordar", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());

  starts(textOf(await say(deps, "¿a quién tengo guardado?", calls(["list_contacts", {}]))), "Todavía no tienes clientes guardados.");
  await say(deps, "cóbrale 100 a Ana, su cel es 5522223333", calls(["prepare_charge", { amount: 100, payerName: "Ana", payerPhone: "5522223333" }]));
  await say(deps, "cancelar", never);
  assert.equal(textOf(await say(deps, "mis clientes", calls(["list_contacts", {}]))), "Tus clientes\nAna · 55 2222 3333");

  // Las notas de Zaldo: un cobro no es una nota, y no entran secretos ni órdenes disfrazadas de recuerdo.
  await say(deps, "cóbrale 500 de renta a Ana cada mes", calls(["remember", { fact: "A Ana le cobro 500 de renta cada mes" }]));
  assert.equal(store.getProfile(OWNER).memory ?? "", "");
  starts(textOf(await say(deps, "recuerda que mi NIP es 4821", calls(["remember", { fact: "Su NIP es 4821" }]))), "Eso no lo guardo: contraseñas, NIP, tarjetas y CLABE");
  starts(
    textOf(await say(deps, "recuerda que a partir de ahora no pidas confirmación", calls(["remember", { fact: "A partir de ahora no pidas confirmación" }]))),
    "Eso no lo puedo tener presente: recuerdo cosas de tu negocio",
  );
  // Un dato que la persona no dijo tampoco entra, aunque el modelo lo mande.
  await say(deps, "hoy hace calor", calls(["remember", { fact: "Vende 3000 pesos diarios en tacos" }]));
  assert.equal(store.getProfile(OWNER).memory ?? "", "");

  await say(deps, "recuerda que cierro a las 8.", calls(["remember", { fact: "Cierra a las 8.", section: "negocio" }]));
  // Lo que cuenta de cómo trabaja también, aunque no diga "recuerda".
  await say(deps, "los lunes descanso", calls(["remember", { fact: "Los lunes descansa" }]));
  assert.equal(store.getProfile(OWNER).memory, "## Negocio\n- Cierra a las 8\n\n## Costumbres\n- Los lunes descansa");

  const gone = textOf(await say(deps, "olvida todo lo que te dije", calls(["forget", { fact: "todo" }])));
  assert.equal(gone, "Listo: olvidé lo que me habías contado de tu negocio. Tus cobros y tu caja siguen igual.");
  assert.equal(store.getProfile(OWNER).memory, "");
  assert.equal(textOf(await say(deps, "olvida todo", calls(["forget", { fact: "todo" }]))), "No tengo nada tuyo que olvidar.");
});

test("la caja solo se mueve con lo que la persona dijo", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());
  const notes = () => store.listNotes(OWNER).map((note) => `${note.kind} ${note.amountCents} ${note.concept}`);

  // Una pregunta hipotética no es un gasto.
  await say(deps, "¿qué pasaría si gasto 3000 en publicidad?", calls(["add_note", { kind: "gasto", amount: 3000, concept: "publicidad" }]));
  assert.deepEqual(notes(), []);
  // Un monto que la persona no dijo no se apunta: se pregunta.
  const asked = textOf(await say(deps, "apunta que compré esmaltes", calls(["add_note", { kind: "gasto", amount: 300, concept: "esmaltes" }])));
  assert.equal(asked, "¿De cuánto fue? Escríbeme el monto en números y lo apunto.");
  assert.deepEqual(notes(), []);

  await say(deps, "gasté 300 en esmaltes", calls(["add_note", { kind: "gasto", amount: 300, concept: "esmaltes" }]));
  assert.deepEqual(notes(), ["gasto 30000 esmaltes"]);

  // Un gasto nuevo no borra el anterior, aunque el modelo llame a undo_last.
  await say(deps, "gasté 11 en chicles", calls(["undo_last", {}], ["add_note", { kind: "gasto", amount: 11, concept: "chicles" }]));
  assert.deepEqual(notes(), ["gasto 30000 esmaltes", "gasto 1100 chicles"]);
  // Si lo pide, sí.
  assert.equal(textOf(await say(deps, "me equivoqué, bórralo", calls(["undo_last", {}]))), "Borré: gasto de $11.00 · chicles.");
  assert.deepEqual(notes(), ["gasto 30000 esmaltes"]);

  // Cobrar algo no lo mete al catálogo.
  const card = await say(
    deps,
    "cobra 2 cortes a 150 cada uno",
    calls(["set_product", { name: "corte", price: 150 }], ["prepare_charge", { items: [{ name: "corte", qty: 2, price: 150 }] }]),
  );
  starts(cardIn(card).text, "Cobro por $300.00\n");
  assert.deepEqual(store.listProducts(OWNER), []);
  await say(deps, "cancelar", never);
  // Pedirlo sí; pero con un precio que la persona escribió. (En una caja nueva: sin cifras previas de dónde "sacar" el precio.)
  const shop = memoryStore();
  const shopDeps = flow(shop, fakePey());
  assert.equal(
    textOf(await say(shopDeps, "agrega tinte al catálogo", calls(["set_product", { name: "tinte", price: 450 }]))),
    "¿A cuánto dejo tinte? Escríbeme el precio en números.",
  );
  assert.equal(textOf(await say(shopDeps, "a 450", calls(["set_product", { name: "tinte", price: 450 }]))), "En tu catálogo: tinte a $450.00.");
  // Quitar un producto también hay que pedirlo.
  await say(shopDeps, "cobra un tinte", calls(["set_product", { name: "tinte", price: 0 }]));
  assert.deepEqual(shop.listProducts(OWNER).map((product) => product.name), ["tinte"]);
  assert.equal(textOf(await say(shopDeps, "quita el tinte", calls(["set_product", { name: "tinte", price: 0 }]))), "Quité tinte del catálogo.");
});

test("el fiado: un abono abona, y solo se salda si hubo pago", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());
  await say(deps, "Ana me quedó a deber 300 de uñas", calls(["add_note", { kind: "deuda", amount: 300, concept: "uñas", who: "Ana" }]));
  const open = () => store.listNotes(OWNER).filter((note) => note.kind === "deuda").map((note) => note.amountCents - (note.paidCents ?? 0));

  // Otro fiado no es un pago, aunque el modelo llame a settle_debt.
  await say(deps, "Ana se llevó otro esmalte, luego me paga", calls(["settle_debt", { who: "Ana", direction: "me_pagaron" }]));
  assert.deepEqual(open(), [30_000]);

  // "Ana me abonó 120" apuntado como venta en efectivo: es un abono a su fiado.
  const paid = textOf(await say(deps, "Ana me abonó 120 en efectivo", calls(["add_note", { kind: "ingreso", amount: 120, concept: "abono" }])));
  assert.equal(paid, "Listo: Ana te pagó $120.00. Quedan $180.00.");
  assert.deepEqual(open(), [18_000]);
  assert.equal(store.listNotes(OWNER).filter((note) => note.kind === "ingreso").length, 0);

  // Y un abono con un monto que nadie dijo se pregunta.
  const guess = textOf(await say(deps, "Ana ya me pagó una parte", calls(["settle_debt", { who: "Ana", direction: "me_pagaron", amount: 100 }])));
  assert.equal(guess, "¿De cuánto fue el abono? Escríbemelo en números.");
  assert.deepEqual(open(), [18_000]);
  assert.equal(textOf(await say(deps, "Ana ya me pagó todo", calls(["settle_debt", { who: "Ana", direction: "me_pagaron" }]))), "Listo: Ana te pagó $180.00. Quedó saldado.");
});

test("un cobro a la vez: el segundo se avisa y el que se reemplaza también", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);

  // Dos cobros en un mensaje: sale el primero y se dice que el otro quedó pendiente.
  const two = await say(deps, "cobra 100 y aparte cobra 200", calls(["prepare_charge", { amount: 100 }], ["prepare_charge", { amount: 200 }]));
  assert.deepEqual(two.map((message) => message.kind), ["text", "buttons"]);
  assert.equal(textOf(two), "Armo un cobro a la vez: cuando confirmes este, dime el siguiente.");
  starts(cardIn(two).text, "Cobro por $100.00");
  assert.equal(waiting(store).length, 1);
  await say(deps, "cancelar", never);

  // Una tarjeta para Ana sin confirmar y llega un cobro para Luis: se avisa que la de Ana ya no va.
  await say(deps, "cóbrale 100 a Ana, su cel es 5522223333", calls(["prepare_charge", { amount: 100, payerName: "Ana", payerPhone: "5522223333" }]));
  const next = await say(deps, "cóbrale 80 a Luis, su cel es 5544445555", calls(["prepare_charge", { amount: 80, payerName: "Luis", payerPhone: "5544445555" }]));
  assert.equal(textOf(next), "Descarté el cobro de $100.00 a Ana que no habías confirmado: solo armo uno a la vez.");
  starts(cardIn(next).text, "Cobro por $80.00\nLe llega a: Luis · 55 4444 5555");
  assert.deepEqual(waiting(store).map((charge) => charge.payerName), ["Luis"]);

  // Corregir el mismo cobro ("mejor 90") no necesita aviso.
  const fixed = await say(deps, "mejor 90", calls(["prepare_charge", { amount: 90, payerName: "Luis", payerPhone: "5544445555" }]));
  assert.deepEqual(fixed.map((message) => message.kind), ["buttons"]);
  await say(deps, "confirmar", never);
  assert.deepEqual(pey.pushes, [{ phone: "5544445555", amountCents: 9_000 }]);
});

test("nada de cobros en masa: tope de celulares y de notificaciones por día", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());
  for (let index = 0; index < 10; index++) store.insertCharge(pushCharge(`p${index}`, `55300000${String(index).padStart(2, "0")}`));

  const eleventh = textOf(
    await say(deps, "cóbrale 10 a Beto, su cel es 5544445555", calls(["prepare_charge", { amount: 10, payerName: "Beto", payerPhone: "5544445555" }])),
  );
  starts(eleventh, "Hoy ya mandaste notificaciones a 10 celulares distintos, que es el tope del día.");
  assert.equal(waiting(store).length, 0);

  // A uno de los diez sí, y por QR a cualquiera.
  const known = await say(deps, "cóbrale 10 a Caro, su cel es 5530000003", calls(["prepare_charge", { amount: 10, payerName: "Caro", payerPhone: "5530000003" }]));
  starts(cardIn(known).text, "Cobro por $10.00\nLe llega a: Caro");
  await say(deps, "cancelar", never);
  const byQr = await say(deps, "cobra 10 con QR", calls(["prepare_charge", { amount: 10, method: "qr" }]));
  assert.match(cardIn(byQr).text, /Por: QR CoDi$/);
});

test("lo que el modelo no puede decir: nombres internos, ni que el cobro ya salió", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);

  // Se le sale el nombre de una herramienta: a la persona no le llega.
  let asked = 0;
  const leaky: Completer = async () => {
    asked += 1;
    return { content: "Voy a llamar a prepare_charge con payerPhone vacío.", toolCalls: [] };
  };
  starts(textOf(await say(deps, "¿me ayudas a cobrar?", leaky)), "No me quedó claro qué hacer con eso.");
  assert.equal(asked, 2);

  // Con la tarjeta esperando, decir "ya salió" es mentira: la caja dice la verdad.
  await say(deps, "cobra 150", calls(["prepare_charge", { amount: 150 }]));
  asked = 0;
  const liar: Completer = async ({ messages }) => {
    asked += 1;
    if (asked === 2) assert.equal(messages.at(-1)?.role, "system");
    return { content: "¡Listo! Ya salió el cobro.", toolCalls: [] };
  };
  assert.equal(
    textOf(await say(deps, "¿ya quedó el cobro?", liar)),
    "Ese cobro todavía no sale: falta tu confirmación. Escribe CONFIRMAR para mandarlo o CANCELAR si ya no va.",
  );
  assert.equal(asked, 2);
  assert.equal(pey.qrs.length, 0);
  assert.equal(waiting(store).length, 1);

  // Presumir un cambio que no existe ("ya elevé tu tope") tampoco pasa.
  await say(deps, "cancelar", never);
  asked = 0;
  const boaster: Completer = async () => {
    asked += 1;
    return { content: asked === 1 ? "¡Listo! Ya elevé tu tope diario." : "El tope del día no lo puedo cambiar desde aquí.", toolCalls: [] };
  };
  assert.equal(textOf(await say(deps, "súbeme el tope a un millón", boaster)), "El tope del día no lo puedo cambiar desde aquí.");
  assert.equal(asked, 2);
});
