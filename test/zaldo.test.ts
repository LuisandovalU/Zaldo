import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Completer } from "../src/agent.js";
import type { AppConfig } from "../src/config.js";
import { fileStore } from "../src/fileStore.js";
import { loadEnvFile } from "../src/envFile.js";
import { ackInbound, applyPeyEvent, handleInbound, takeExpired, type FlowDeps, type PeyPort } from "../src/flows.js";
import type { Outbound } from "../src/inbound.js";
import { formatMxn, mexicoDayStart, parsePesosToCents } from "../src/money.js";
import { isAllowed, toTenDigits } from "../src/phone.js";
import { memoryStore, type Store } from "../src/store.js";
import { parseWhatsAppPayload, verifyMetaSignature } from "../src/whatsapp.js";

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

function tool(name: string, args: object): Completer {
  return async () => ({
    content: null,
    toolCalls: [
      {
        id: "call_1",
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
}

function toolOnce(name: string, args: object): Completer {
  let step = 0;
  return async ({ messages: history }) => {
    step += 1;
    if (step === 1) {
      return {
        content: null,
        toolCalls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
      };
    }
    const last = history.at(-1);
    return { content: last?.content ?? "listo", toolCalls: [] };
  };
}

function deps(store: Store, pey: PeyPort, complete: Completer, over: Partial<AppConfig> = {}): FlowDeps {
  return {
    store,
    config: config(over),
    pey,
    complete,
    transcribe: async () => "cóbrame un centavo de prueba",
    now: () => NOW,
    renderQr: async () => Buffer.from("qr"),
  };
}

function fakePey(): PeyPort & { pushes: unknown[]; qrs: unknown[]; links: unknown[] } {
  return {
    pushes: [],
    qrs: [],
    links: [],
    async push(input) {
      this.pushes.push(input);
      return { transactionId: "txn_1", codiId: "codi_1" };
    },
    async qr(input) {
      this.qrs.push(input);
      return { id: "qr_1", qrString: "{\"TYP\":20}" };
    },
    async link(input) {
      this.links.push(input);
      return { id: "link_1", url: "https://pay.example/abc" };
    },
  };
}

async function messages(flow: FlowDeps, inbound: Parameters<typeof handleInbound>[1]): Promise<Outbound[]> {
  const handled = await handleInbound(flow, inbound);
  if (handled.claimed) ackInbound(flow.store, inbound.messageId);
  return handled.messages;
}

test("pesos, celular y el día en México", () => {
  assert.equal(parsePesosToCents("150"), 15000);
  assert.equal(parsePesosToCents("$1,500.50"), 150050);
  assert.equal(parsePesosToCents("0.01"), 1);
  assert.equal(parsePesosToCents("150,50"), 15050);
  assert.equal(parsePesosToCents("abc"), null);
  assert.equal(parsePesosToCents("0"), null);
  assert.equal(formatMxn(15050), "$150.50");
  assert.equal(toTenDigits("+52 1 55 1234 5678"), "5512345678");
  assert.equal(toTenDigits("525512345678"), "5512345678");
  assert.equal(isAllowed("5215512345678", ["5512345678"]), true);
  assert.equal(isAllowed("5215500000000", ["5512345678"]), false);
  assert.equal(mexicoDayStart(NOW), Date.parse("2026-11-14T06:00:00.000Z"));
  assert.equal(mexicoDayStart(Date.parse("2026-11-14T05:00:00.000Z")), Date.parse("2026-11-13T06:00:00.000Z"));
});

test("preparar un cobro no llama a Pey y el botón sí lo envía una sola vez", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const flow = deps(store, pey, tool("prepare_charge", { amount: 150, concept: "Pedido", payerName: "Ana", payerPhone: "55 2222 3333" }));
  const card = await messages(flow, { type: "text", owner: OWNER, messageId: "m1", text: "cóbrale 150 a Ana" });
  assert.equal(pey.pushes.length, 0);
  assert.equal(card[0]?.kind, "buttons");
  if (card[0]?.kind !== "buttons") return;
  assert.match(card[0].text, /\$150\.00/);
  assert.match(card[0].text, /Ana/);
  assert.equal(store.listCharges(OWNER)[0]?.status, "awaiting_confirm");

  const sent = await messages(flow, { type: "button", owner: OWNER, messageId: "m2", buttonId: card[0].yesId });
  assert.equal(pey.pushes.length, 1);
  const push = pey.pushes[0] as { phone: string; amountCents: number; numRef: string };
  assert.equal(push.phone, "5522223333");
  assert.equal(push.amountCents, 15000);
  assert.match(push.numRef, /^\d{7}$/);
  assert.equal(sent[0]?.kind, "text");
  assert.equal(store.listCharges(OWNER)[0]?.status, "pending");

  await messages(flow, { type: "button", owner: OWNER, messageId: "m3", buttonId: card[0].yesId });
  assert.equal(pey.pushes.length, 1);

  const paid = applyPeyEvent(
    store,
    { type: "codi.pn.payment_received", numRef: push.numRef, transactionId: "txn_1", amount: 150, datePaid: 1_790_724_758 },
    NOW,
  );
  assert.match(paid?.text ?? "", /Ya cayó/);
  assert.equal(store.listCharges(OWNER)[0]?.status, "paid");
  const retry = applyPeyEvent(store, { type: "codi.pn.payment_received", numRef: push.numRef, transactionId: "txn_1" }, NOW);
  assert.match(retry?.text ?? "", /Ya cayó/);
  const paidCharge = store.getCharge(paid?.chargeId ?? "");
  if (!paidCharge) throw new Error("falta el cobro");
  store.updateCharge({ ...paidCharge, paidNoticeSent: true });
  assert.equal(applyPeyEvent(store, { type: "codi.pn.payment_received", numRef: push.numRef, transactionId: "txn_1" }, NOW), null);
});

test("cancelar no llama a Pey y el mismo mensaje no se procesa dos veces", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const flow = deps(store, pey, tool("prepare_charge", { amount: 80, concept: "Tacos", payerName: "yo" }));
  const card = await messages(flow, { type: "text", owner: OWNER, messageId: "m1", text: "cóbrame 80 de tacos" });
  if (card[0]?.kind !== "buttons") throw new Error("esperaba botones");
  assert.equal(store.listCharges(OWNER)[0]?.payerPhone, "5511111111");
  const cancelled = await messages(flow, { type: "button", owner: OWNER, messageId: "m2", buttonId: card[0].noId });
  assert.equal(pey.pushes.length, 0);
  assert.match(cancelled[0] && cancelled[0].kind === "text" ? cancelled[0].text : "", /Cancelé/);
  assert.equal(store.listCharges(OWNER)[0]?.status, "cancelled");
  const again = await messages(flow, { type: "text", owner: OWNER, messageId: "m1", text: "otra vez" });
  assert.equal(again.length, 0);
  assert.equal(store.listCharges(OWNER).length, 1);
});

test("el tope, la lista blanca, la nota de voz, el QR y el link", async () => {
  const blocked = memoryStore();
  const pey = fakePey();
  const quiet = await messages(
    deps(blocked, pey, tool("prepare_charge", { amount: 10, concept: "X" }), { allowedPhones: ["5599999999"] }),
    { type: "text", owner: OWNER, messageId: "b1", text: "cobra" },
  );
  assert.equal(quiet.length, 0);
  assert.equal(blocked.listCharges().length, 0);

  const capped = memoryStore();
  let step = 0;
  const complete: Completer = async ({ messages: history }) => {
    step += 1;
    if (step === 1) {
      return {
        content: null,
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "prepare_charge", arguments: JSON.stringify({ amount: 150, concept: "Pedido" }) },
          },
        ],
      };
    }
    const last = history.at(-1);
    return { content: last?.content ?? null, toolCalls: [] };
  };
  const over = await messages(
    deps(capped, pey, complete, { dailyCapCents: 10_000 }),
    { type: "text", owner: OWNER, messageId: "c1", text: "cobra 150" },
  );
  assert.equal(pey.pushes.length, 0);
  assert.match(over[0] && over[0].kind === "text" ? over[0].text : "", /tope/);

  const voice = memoryStore();
  let heard = "";
  const voiceFlow = deps(voice, pey, tool("prepare_charge", { amount: 0.01, concept: "Prueba" }));
  voiceFlow.transcribe = async (mediaId) => {
    heard = mediaId;
    return "cóbame un centavo de prueba";
  };
  const heardCard = await messages(voiceFlow, {
    type: "audio",
    owner: OWNER,
    messageId: "v1",
    mediaId: "media-1",
    mime: "audio/ogg; codecs=opus",
  });
  assert.equal(heard, "media-1");
  assert.equal(heardCard[0]?.kind, "buttons");

  const images = memoryStore();
  const qrFlow = deps(images, pey, tool("prepare_charge", { amount: 40, concept: "QR", method: "qr" }));
  const qrCard = await messages(qrFlow, { type: "text", owner: OWNER, messageId: "q1", text: "manda qr de 40" });
  if (qrCard[0]?.kind !== "buttons") throw new Error("esperaba botones");
  const image = await messages(qrFlow, { type: "button", owner: OWNER, messageId: "q2", buttonId: qrCard[0].yesId });
  assert.equal(pey.qrs.length, 1);
  assert.equal(image[0]?.kind, "image");

  const links = memoryStore();
  const linkFlow = deps(links, pey, tool("prepare_charge", { amount: 90, concept: "Tarjeta", method: "link" }));
  const linkCard = await messages(linkFlow, { type: "text", owner: OWNER, messageId: "l1", text: "manda link de 90" });
  if (linkCard[0]?.kind !== "buttons") throw new Error("esperaba botones");
  const link = await messages(linkFlow, { type: "button", owner: OWNER, messageId: "l2", buttonId: linkCard[0].yesId });
  assert.equal(pey.links.length, 1);
  const created = pey.links[0] as { successUrl: string; chargeId: string };
  assert.equal(created.successUrl, "https://zaldo.example/pago/listo");
  assert.match(link[0] && link[0].kind === "text" ? link[0].text : "", /https:\/\/pay\.example\/abc/);
  const paidLink = applyPeyEvent(
    links,
    { type: "payment_link.status_updated", status: "paid", clientReferenceId: created.chargeId, paymentLinkId: "link_1" },
    NOW,
  );
  assert.match(paidLink?.text ?? "", /Ya cayó/);
});

test("repetir, apuntar y el saldo no mueven dinero", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const flow = deps(store, pey, tool("prepare_charge", { amount: 20, concept: "Pan", payerName: "Luis", payerPhone: "5510000000" }));
  await messages(flow, { type: "text", owner: OWNER, messageId: "r1", text: "cobra 20 de pan" });
  flow.complete = tool("repeat_charge", { payerName: "Luis" });
  const again = await messages(flow, { type: "text", owner: OWNER, messageId: "r2", text: "otra vez" });
  assert.equal(again[0]?.kind, "buttons");
  assert.equal(store.listCharges(OWNER).filter((charge) => charge.status === "awaiting_confirm").length, 1);
  assert.equal(pey.pushes.length, 0);

  flow.complete = toolOnce("add_note", { kind: "gasto", amount: 200, concept: "gasolina" });
  const note = await messages(flow, { type: "text", owner: OWNER, messageId: "n1", text: "apunta" });
  assert.match(note[0] && note[0].kind === "text" ? note[0].text : "", /Apuntado/);
  flow.complete = toolOnce("get_balance", {});
  const balance = await messages(flow, { type: "text", owner: OWNER, messageId: "n2", text: "zaldo" });
  assert.match(balance[0] && balance[0].kind === "text" ? balance[0].text : "", /Gastos: \$200\.00/);
});

test("un cobro pendiente vence y un archivo guarda el libro", async () => {
  const store = memoryStore();
  const pey = fakePey();
  const flow = deps(store, pey, tool("prepare_charge", { amount: 5, concept: "Agua", payerName: "yo" }));
  const card = await messages(flow, { type: "text", owner: OWNER, messageId: "e1", text: "cóbrame 5 de agua" });
  if (card[0]?.kind !== "buttons") throw new Error("esperaba botones");
  await messages(flow, { type: "button", owner: OWNER, messageId: "e2", buttonId: card[0].yesId });
  const notices = takeExpired(store, NOW + 360 * 1000);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /venció/);
  assert.equal(takeExpired(store, NOW + 360 * 1000).length, 0);

  const dir = mkdtempSync(join(tmpdir(), "zaldo-"));
  const disk = fileStore(join(dir, "zaldo.json"));
  disk.insertNote({
    id: "n",
    owner: OWNER,
    kind: "deuda",
    amountCents: 8000,
    concept: "Luis",
    who: "Luis",
    createdAt: NOW,
  });
  const reopened = fileStore(join(dir, "zaldo.json"));
  assert.equal(reopened.listNotes(OWNER)[0]?.amountCents, 8000);
});

test("el .env no pisa una variable que ya existe", () => {
  const dir = mkdtempSync(join(tmpdir(), "zaldo-env-"));
  const path = join(dir, ".env");
  writeFileSync(path, "PEY_API_KEY=desde-archivo\nOPENROUTER_API_KEY=sk\n# comentario\n");
  const env: NodeJS.ProcessEnv = { PEY_API_KEY: "ya-puesta" };
  loadEnvFile(path, env);
  assert.equal(env.PEY_API_KEY, "ya-puesta");
  assert.equal(env.OPENROUTER_API_KEY, "sk");
});

test("WhatsApp: la firma y una nota de voz", () => {
  const raw = Buffer.from('{"ok":true}');
  const sig = "sha256=" + createHmac("sha256", "appsecret").update(raw).digest("hex");
  assert.equal(verifyMetaSignature("appsecret", raw, sig), true);
  assert.equal(verifyMetaSignature("appsecret", raw, "sha256=00"), false);
  const parsed = parseWhatsAppPayload({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: OWNER, id: "a1", type: "audio", audio: { id: "mid", mime_type: "audio/ogg" } },
                {
                  from: OWNER,
                  id: "a2",
                  type: "interactive",
                  interactive: { type: "button_reply", button_reply: { id: "c:11111111-1111-1111-1111-111111111111" } },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  assert.equal(parsed[0]?.type, "audio");
  assert.equal(parsed[1]?.type, "button");
});
