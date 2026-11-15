/**
 * Cuando Zaldo duda, pregunta con botones: una pregunta corta y dos o tres
 * respuestas que se tocan. Tocar una es como escribirla.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Completer, ToolCall } from "../src/agent.js";
import type { AppConfig } from "../src/config.js";
import { asReplies } from "../src/core.js";
import { ackInbound, handleInbound, type FlowDeps, type PeyPort } from "../src/flows.js";
import type { Inbound, Outbound } from "../src/inbound.js";
import { memoryStore, type Store } from "../src/store.js";

const OWNER = "5215511111111";
const NOW = Date.parse("2026-11-14T18:00:00.000Z");

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

function fakePey(): PeyPort & { qrs: number[] } {
  return {
    qrs: [],
    async push() {
      return { transactionId: "txn_1", codiId: "codi" };
    },
    async qr(input) {
      this.qrs.push(input.amountCents);
      return { id: `idc_${this.qrs.length}`, qrString: "{}" };
    },
    async link() {
      return { id: "link_1", url: "https://app.mipey.mx/payment-link/x" };
    },
    async transaction(id) {
      return {
        id,
        status: "PENDING",
        amountCents: 0,
        breakdown: null,
        currency: "MXN",
        paymentMethod: "CODI",
        payableType: "API_CODI_QR",
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

function flow(store: Store, pey: PeyPort): FlowDeps {
  return {
    store,
    config: config(),
    pey,
    complete: async () => ({ content: "hola", toolCalls: [] }),
    transcribe: async () => "",
    now: () => NOW,
    renderQr: async () => Buffer.from("qr"),
  };
}

let seq = 0;
type Loose = { type: "text"; text: string } | { type: "button"; buttonId: string };
async function send(deps: FlowDeps, inbound: Loose, complete?: Completer): Promise<Outbound[]> {
  if (complete) deps.complete = complete;
  const messageId = `b${++seq}`;
  const handled = await handleInbound(deps, { ...inbound, owner: OWNER, messageId } as Inbound);
  if (handled.claimed) ackInbound(deps.store, messageId);
  return handled.messages;
}

const say = (deps: FlowDeps, text: string, complete: Completer) => send(deps, { type: "text", text }, complete);

function choiceIn(messages: Outbound[]): Extract<Outbound, { kind: "choice" }> {
  for (const message of messages) if (message.kind === "choice") return message;
  throw new Error(`esperaba una pregunta con botones: ${JSON.stringify(messages.map((message) => message.kind))}`);
}

test("la duda de la caja sale con botones, y tocar uno es como escribirlo", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const deps = flow(store, pey);

  const asked = choiceIn(await say(deps, "cobra 100 o 150, no me acuerdo", calls(["prepare_charge", { amount: 100 }])));
  assert.equal(asked.text, "¿Cuál de los dos cobro?");
  assert.deepEqual(
    asked.options.map((option) => option.label),
    ["$100.00", "$150.00"],
  );
  assert.equal(store.listCharges(OWNER).length, 0, "con la duda abierta no hay tarjeta");

  // Toca "$150.00": le llega al modelo como si lo hubiera escrito, y ese monto ya consta.
  const tapped = await send(deps, { type: "button", buttonId: asked.options[1]!.id }, calls(["prepare_charge", { amount: 150 }]));
  const card = tapped.find((message) => message.kind === "buttons");
  assert.equal(card?.kind, "buttons");
  assert.equal(store.listCharges(OWNER)[0]?.amountCents, 15_000);
  assert.equal(store.recentTurns(OWNER).filter((turn) => turn.role === "user").at(-1)?.content, "$150.00");
});

test("las preguntas de la caja nunca traen más de tres opciones ni etiquetas largas", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());

  const daily = choiceIn(
    await say(deps, "cóbrale 100 a Ana cada día, su cel es 5522223333", calls(["prepare_charge", { amount: 100, payerName: "Ana", payerPhone: "5522223333", every: "semanal" }])),
  );
  assert.deepEqual(
    daily.options.map((option) => option.label),
    ["Cada semana", "Cada quincena", "Cada mes"],
  );

  const phone = choiceIn(await say(deps, "cóbrale 80 a Beto", calls(["prepare_charge", { amount: 80, payerName: "Beto" }])));
  assert.equal(phone.text.startsWith("No tengo el celular de Beto."), true);
  assert.deepEqual(
    phone.options.map((option) => option.label),
    ["Dame un QR", "Mejor por link"],
  );
  for (const question of [daily, phone]) {
    assert.equal(question.options.length <= 3, true);
    for (const option of question.options) assert.equal(option.label.length <= 20, true, option.label);
  }
});

test("el modelo pregunta con botones solo si son dos o tres respuestas cortas", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());

  const good = choiceIn(
    await say(deps, "cobra un corte", calls(["ask_choice", { question: "¿Cuál corte cobro?", options: ["Dama", "Caballero"] }])),
  );
  assert.equal(good.text, "¿Cuál corte cobro?");
  assert.deepEqual(
    good.options.map((option) => option.id),
    ["o:Dama", "o:Caballero"],
  );

  const output = () => store.recentTurns(OWNER).filter((turn) => turn.role === "assistant").at(-1)?.tools?.[0]?.output ?? "";

  // Un menú de cinco cosas no sale.
  const menu = await say(deps, "no sé por dónde empezar", calls(["ask_choice", { question: "¿Qué hacemos?", options: ["Cobrar", "Corte", "Catálogo", "Fiado", "Ayuda"] }]));
  assert.equal(menu.some((message) => message.kind === "choice"), false);
  assert.equal(output().startsWith("ERROR: son dos o tres opciones"), true);

  // Tampoco una opción que no cabe en un botón, ni una sola opción, ni una pregunta que pide secretos.
  await say(deps, "cobra", calls(["ask_choice", { question: "¿Cómo?", options: ["Con un QR para que lo escanee el cliente", "Link"] }]));
  assert.equal(output().startsWith("ERROR: cada opción cabe en 20"), true);
  await say(deps, "cobra", calls(["ask_choice", { question: "¿Seguro?", options: ["Sí", "sí"] }]));
  assert.equal(output().startsWith("ERROR: son dos o tres opciones"), true);
  const secret = await say(deps, "cobra", calls(["ask_choice", { question: "¿Me das tu NIP o tu contraseña?", options: ["Sí", "No"] }]));
  assert.equal(secret.some((message) => message.kind === "choice"), false);
});

test("por el puente: botones si esa persona ya comprobó que los ve; si no, opciones que siempre se ven", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());
  const styleFor = (owner: string) => store.getProfile(owner).choiceStyle ?? "poll";

  const card = await say(deps, "cobra 150", calls(["prepare_charge", { amount: 150 }]));
  // El puente viejo no entiende botones: recibe el texto de siempre.
  const old = asReplies(card, false, styleFor);
  assert.equal(typeof old[0], "string");
  assert.equal(String(old[0]).endsWith("Responde *CONFIRMAR* o *CANCELAR*"), true);
  assert.equal(String(old[0]).startsWith("🧾 *Cobro por $150.00*\n> Lo paga:"), true);
  // El puente nuevo, sin haber probado botones: la tarjeta como mensaje y abajo la pregunta con dos opciones.
  const poll = asReplies(card, true, styleFor);
  assert.equal(poll.length, 2);
  assert.equal(typeof poll[0], "string");
  const question = poll[1] as { choice: { text: string; style: string; options: { id: string; label: string }[] } };
  assert.equal(question.choice.style, "poll");
  assert.equal(question.choice.text, "¿Mando este cobro?");
  assert.deepEqual(
    question.choice.options.map((option) => option.label),
    ["Confirmar", "Cancelar"],
  );
  assert.equal(/^c:[0-9a-f-]{36}$/.test(question.choice.options[0]!.id), true);

  // "probar botones": sale la prueba con botones de verdad; si los ve y toca, se quedan.
  const trial = await say(deps, "probar botones", calls());
  assert.equal(trial[0]?.kind, "text");
  const probe = choiceIn(trial);
  assert.equal(probe.style, "buttons");
  const sent = asReplies(trial, true, styleFor)[1] as { choice: { style: string } };
  assert.equal(sent.choice.style, "buttons", "la prueba sale con botones aunque su chat todavía no los use");
  await send(deps, { type: "button", buttonId: probe.options[0]!.id });
  assert.equal(store.getProfile(OWNER).choiceStyle, "buttons");

  const again = await say(deps, "cobra 200", calls(["prepare_charge", { amount: 200 }]));
  const native = asReplies(again, true, styleFor);
  assert.equal(native.length, 1, "con botones, la tarjeta y sus dos botones son un solo mensaje");
  assert.equal((native[0] as { choice: { style: string } }).choice.style, "buttons");

  // Y si un día no los ve: "sin botones".
  await say(deps, "sin botones", calls());
  assert.equal(store.getProfile(OWNER).choiceStyle, "poll");
});

test("si lo que piden cabe en dos productos del catálogo, la caja pregunta cuál", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());
  store.setProduct({ owner: OWNER, name: "corte dama", priceCents: 20_000 });
  store.setProduct({ owner: OWNER, name: "corte caballero", priceCents: 12_000 });
  store.setProduct({ owner: OWNER, name: "tinte", priceCents: 45_000 });

  // El modelo escoge uno al azar: la caja no lo deja adivinar.
  const asked = choiceIn(await say(deps, "cobra un corte", calls(["prepare_charge", { items: [{ name: "corte dama", qty: 1 }] }])));
  assert.equal(asked.text, "¿Cuál de estos cobro?");
  assert.deepEqual(
    asked.options.map((option) => option.label),
    ["corte dama", "corte caballero"],
  );
  assert.equal(store.listCharges(OWNER).length, 0);

  // Toca "corte caballero" y ya no hay duda.
  const tapped = await send(deps, { type: "button", buttonId: asked.options[1]!.id }, calls(["prepare_charge", { items: [{ name: "corte caballero", qty: 1 }] }]));
  assert.equal(tapped.some((message) => message.kind === "buttons"), true);
  assert.equal(store.listCharges(OWNER)[0]?.amountCents, 12_000);

  // Con el nombre completo, o con un producto que no se parece a otro, no pregunta.
  const full = await say(deps, "cobra 2 cortes dama", calls(["prepare_charge", { items: [{ name: "corte dama", qty: 2 }] }]));
  assert.equal(full.some((message) => message.kind === "buttons"), true);
  const plain = await say(deps, "cobra un tinte", calls(["prepare_charge", { items: [{ name: "tinte", qty: 1 }] }]));
  assert.equal(plain.some((message) => message.kind === "buttons"), true);
});
