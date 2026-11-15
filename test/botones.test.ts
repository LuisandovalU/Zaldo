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
  assert.equal(store.getProfile(OWNER).choiceStyle, "text");
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

test("un chat que no ha tocado ningún botón recibe el texto de siempre y, además, los botones", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());
  const both = () => "both" as const;

  const card = asReplies(await say(deps, "cobra 150", calls(["prepare_charge", { amount: 150 }])), true, both);
  assert.equal(card.length, 2);
  assert.equal(String(card[0]).endsWith("Responde *CONFIRMAR* o *CANCELAR*"), true, "si su WhatsApp no pinta botones, igual sabe qué contestar");
  const buttons = card[1] as { choice: { text: string; style: string; options: { label: string }[] } };
  assert.equal(buttons.choice.style, "buttons");
  assert.equal(buttons.choice.text, "¿Mando este cobro?");
  assert.deepEqual(
    buttons.choice.options.map((option) => option.label),
    ["Confirmar", "Cancelar"],
  );

  const asked = asReplies(await say(deps, "cobra 100 o 150, no me acuerdo", calls(["prepare_charge", { amount: 100 }])), true, both);
  assert.equal(asked[0], "¿Cuál de los dos cobro?\n\n- *$100.00*\n- *$150.00*");
  assert.equal((asked[1] as { choice: { style: string } }).choice.style, "buttons");
});

test("quien llega dice su nombre y se le explica el modo demo, con dos caminos", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());
  deps.config = { ...deps.config, peyBankAccountId: "acct_pruebas", testMaxCents: 100 };

  await say(deps, "hola", async () => ({ content: "¡Qué onda! Soy Zaldo. ¿Cómo te llamas?", toolCalls: [] }));
  const welcome = choiceIn(await say(deps, "Alejandro", calls(["set_profile", { name: "Alejandro" }])));
  assert.equal(welcome.text.startsWith("¡Mucho gusto, Alejandro!"), true);
  assert.match(welcome.text, /Estás en \*modo demo\*: puedes probar todo, con cobros de hasta \*\$1\.00\*/);
  assert.match(welcome.text, /¿Cómo seguimos\?$/);
  assert.deepEqual(
    welcome.options.map((option) => option.label),
    ["Registrar mi cuenta", "Seguir en demo"],
  );
  assert.equal(store.getProfile(OWNER).onboarded, true);

  // "Seguir en demo": el siguiente paso, también con botones.
  const next = choiceIn(await send(deps, { type: "button", buttonId: welcome.options[1]!.id }));
  assert.match(next.text, /^Va, seguimos en \*modo demo\*\./);
  assert.deepEqual(
    next.options.map((option) => option.label),
    ["Cobrarme 1 centavo", "¿Qué puedes hacer?"],
  );
  // "Cobrarme 1 centavo" es un cobro a su propio celular, por un centavo.
  const card = await send(deps, { type: "button", buttonId: next.options[0]!.id }, calls(["prepare_charge", { amount: 1 }]));
  const charge = store.listCharges(OWNER)[0];
  assert.equal(card.some((message) => message.kind === "buttons"), true);
  assert.equal(charge?.amountCents, 1);
  assert.equal(charge?.method, "push");

  // La bienvenida sale una sola vez, y nunca a quien ya recibe en su propio banco.
  const again = await say(deps, "me llamo Alex", calls(["set_profile", { name: "Alex" }]));
  assert.equal(again.some((message) => message.kind === "choice"), false);
  const real = memoryStore();
  const realDeps = flow(real, fakePey());
  const plain = await say(realDeps, "Alejandro", calls(["set_profile", { name: "Alejandro" }]));
  assert.equal(plain.some((message) => message.kind === "choice"), false);
});

test("borrar mi cuenta: pregunta una vez y deja el chat como nuevo", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());
  deps.config = { ...deps.config, peyBankAccountId: "acct_pruebas", testMaxCents: 100 };
  await say(deps, "Alejandro", calls(["set_profile", { name: "Alejandro" }]));
  store.setProduct({ owner: OWNER, name: "corte", priceCents: 15_000 });
  assert.equal(store.getProfile(OWNER).name, "Alejandro");

  // Un "sí, borrar todo" suelto, sin que se haya preguntado, no borra nada.
  await say(deps, "Sí, borrar todo", async () => ({ content: "¿Qué quieres borrar?", toolCalls: [] }));
  assert.equal(store.getProfile(OWNER).name, "Alejandro");

  const asked = choiceIn(await say(deps, "borrar mi cuenta", calls()));
  assert.equal(asked.text.startsWith("¿Borro todo lo de este chat?"), true);
  assert.deepEqual(
    asked.options.map((option) => option.label),
    ["Sí, borrar todo", "No, dejarlo así"],
  );
  const done = await send(deps, { type: "button", buttonId: asked.options[0]!.id });
  assert.equal(done[0]?.kind, "text");
  assert.equal(store.getProfile(OWNER).name, null);
  assert.equal(store.getProfile(OWNER).onboarded, undefined);
  assert.equal(store.listProducts(OWNER).length, 0);
  assert.equal(store.recentTurns(OWNER).length, 0);

  // Y vuelve a recibir la bienvenida, como cualquiera que llega.
  const welcome = choiceIn(await say(deps, "Alejandro", calls(["set_profile", { name: "Alejandro" }])));
  assert.equal(welcome.text.startsWith("¡Mucho gusto, Alejandro!"), true);
});

test("probar botones: cuatro formatos, y el que la persona ve se queda para ella y para los demás", async () => {
  const store = memoryStore();
  const deps = flow(store, fakePey());
  const variantOf = (owner: string) => (store.getProfile(owner).choiceVariant ?? store.getProfile("zaldo:botones").choiceVariant ?? "A") as "A" | "B" | "C" | "D";
  const styleFor = (owner: string) => (store.getProfile(owner).choiceStyle === "buttons" ? ("buttons" as const) : ("both" as const));

  const trial = await say(deps, "probar botones", calls());
  assert.equal(trial.length, 5);
  const sent = asReplies(trial, true, styleFor, variantOf) as ({ raw?: { content: Record<string, unknown>; options: { id: string }[] } } | string)[];
  assert.equal(typeof sent[0], "string");
  const kinds = sent.slice(1).map((item) => Object.keys((item as { raw: { content: Record<string, unknown> } }).raw.content).filter((key) => key !== "messageContextInfo")[0]);
  assert.deepEqual(kinds, ["interactiveMessage", "buttonsMessage", "buttonsMessage", "listMessage"]);
  assert.equal((sent[2] as { raw: { options: { id: string }[] } }).raw.options[0]?.id, "o:Veo la B");

  // Toca "Veo la B": su chat y los que lleguen después usan ese formato.
  await send(deps, { type: "button", buttonId: "o:Veo la B" });
  assert.equal(store.getProfile(OWNER).choiceVariant, "B");
  assert.equal(store.getProfile(OWNER).choiceStyle, "buttons");
  assert.equal(variantOf("5219999999999"), "B");

  const card = asReplies(await say(deps, "cobra 150", calls(["prepare_charge", { amount: 150 }])), true, styleFor, variantOf);
  assert.equal(card.length, 1);
  const content = (card[0] as unknown as { raw: { content: { buttonsMessage: { contentText: string; buttons: { buttonText: { displayText: string } }[] } } } }).raw.content;
  assert.equal(content.buttonsMessage.contentText.startsWith("🧾 *Cobro por $150.00*"), true);
  assert.deepEqual(
    content.buttonsMessage.buttons.map((button) => button.buttonText.displayText),
    ["Confirmar", "Cancelar"],
  );
});
