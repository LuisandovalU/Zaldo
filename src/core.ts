/**
 * El núcleo de Zaldo que se publica en producción sin push ni deploy.
 *
 * Todo lo que Zaldo contesta en zaldo.ih0st.app sale de aquí: el puente de
 * WhatsApp, los webhooks de Meta y de pey, /vincular, las páginas de pago y
 * los avisos. `npm run zaldo:publish` lo empaqueta en un solo archivo y lo
 * sube; el servidor que lo hospeda (ih0st.app) solo sabe
 * hacer tres cosas: cargarlo, pasarle cada petición y pararlo al cambiarlo.
 *
 * Por eso esta interfaz es chica y estable. Cambiarla obliga a tocar el
 * servidor; cambiar lo de adentro, no.
 */
import { buttonMessage, isVariant, type RawMessage, type Variant } from "./botones.js";
import { optionList, whatsappStyle } from "./estilo.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import { applyBankEvent, checkAccounts, handleAccountPage, takeNewAccounts, type AccountDeps } from "./cuenta.js";
import { fileStore } from "./fileStore.js";
import {
  ackInbound,
  applyPeyEvent,
  BUTTON_CONFIG,
  handleInbound,
  reconcilePending,
  releaseInbound,
  runRecurring,
  takeExpired,
  type FlowDeps,
} from "./flows.js";
import type { Outbound } from "./inbound.js";
import { openRouterCompleter, transcribeWithOpenRouter } from "./openrouter.js";
import { PeyClient } from "./pey.js";
import { verifyPeyWebhook } from "./peyWebhook.js";
import { toTenDigits } from "./phone.js";
import { parseWhatsAppPayload, verifyMetaSignature, WhatsApp } from "./whatsapp.js";

/** Versión de esta interfaz. El servidor rechaza un núcleo que no la hable. */
export const CORE_API = 1;

declare const __ZALDO_BUILD__: string | undefined;
/** Qué versión es esta: la pone `zaldo:publish` al empaquetar. */
export const CORE_BUILD = typeof __ZALDO_BUILD__ === "string" ? __ZALDO_BUILD__ : "integrado";

export interface CoreRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  /** El cuerpo crudo: las firmas de Meta y de pey se verifican sobre estos bytes. */
  body: () => Promise<Buffer>;
}

export interface CoreReply {
  status: number;
  type: string;
  body: string | Buffer;
}

export interface CoreHost {
  env: NodeJS.ProcessEnv;
  /** https://zaldo.<dominio>, por si PUBLIC_BASE_URL no viene en el entorno. */
  publicBaseUrl?: string | null;
}

export interface ZaldoCore {
  api: number;
  build: string;
  /** Carpeta de datos: ahí deja su estado el puente de WhatsApp. */
  dataDir: string;
  handle(request: CoreRequest): Promise<CoreReply>;
  /** Para los relojes. Se llama antes de cambiar a otra versión. */
  stop(): void;
}

const TEXT = "text/plain; charset=utf-8";
const HTML = "text/html; charset=utf-8";
const JSON_TYPE = "application/json";

const PAGE_OK = `<!doctype html><meta charset="utf-8"><title>Zaldo</title><body style="font-family:sans-serif;padding:2rem"><h1>Listo</h1><p>Si ya pagaste, Zaldo te avisa por WhatsApp.</p>`;
const PAGE_BACK = `<!doctype html><meta charset="utf-8"><title>Zaldo</title><body style="font-family:sans-serif;padding:2rem"><h1>Volviste</h1><p>El pago sigue pendiente. Puedes cerrar esta página.</p>`;

/**
 * Cómo se enseñan las opciones en WhatsApp por el puente: "buttons" (botones de
 * respuesta rápida), "poll" (encuesta, se ve en cualquier WhatsApp) o "text".
 * Se cambia aquí y se publica: no hace falta tocar el servidor.
 */
/**
 * "both": el texto de siempre y, además, los botones. Es lo que recibe un chat
 * que todavía no ha tocado ninguno: si su WhatsApp no pinta botones, no pierde
 * nada. En cuanto toca uno, ese chat pasa a "buttons": un solo mensaje, limpio.
 */
type ChoiceStyle = "buttons" | "poll" | "text" | "both";
const CHOICE_STYLE: ChoiceStyle =
  process.env.ZALDO_CHOICE_STYLE === "buttons" || process.env.ZALDO_CHOICE_STYLE === "poll" || process.env.ZALDO_CHOICE_STYLE === "text"
    ? process.env.ZALDO_CHOICE_STYLE
    : "both";

interface BridgeChoice {
  text: string;
  options: { id: string; label: string }[];
  style: "buttons" | "poll" | "text";
  /** Lo que se manda como texto si el WhatsApp de la persona no puede enseñar botones. */
  fallback: string;
}

/** Lo que el puente manda por WhatsApp: texto, el QR como imagen con su pie, o una pregunta con botones. */
type BridgeReply = string | { image: string; caption: string } | { choice: BridgeChoice } | { raw: RawMessage };

/** Lo que se pregunta bajo la tarjeta cuando las opciones van aparte. */
const CARD_QUESTION = "¿Mando este cobro?";

export function asReplies(
  messages: Outbound[],
  canChoose = false,
  styleFor: (owner: string) => ChoiceStyle = () => CHOICE_STYLE,
  /** Si el puente sabe reenviar mensajes armados aquí: con qué formato de botones se le escribe a cada quien. */
  variantFor: ((owner: string) => Variant) | null = null,
): BridgeReply[] {
  // Un mensaje con botones: armado aquí si el puente lo reenvía, o descrito para que lo arme él.
  const tappable = (owner: string, text: string, options: { id: string; label: string }[], fallback: string, variant?: string): BridgeReply =>
    variantFor
      ? { raw: buttonMessage(isVariant(variant) ? variant : variantFor(owner), text, options, fallback) }
      : { choice: { text, options, style: "buttons", fallback } };
  return messages.flatMap((message): BridgeReply[] => {
    if (message.kind === "text") return [whatsappStyle(message.text)];
    if (message.kind === "buttons") {
      const card = whatsappStyle(message.text);
      const fallback = `${card}\n\nResponde *CONFIRMAR* o *CANCELAR*`;
      const style = styleFor(message.to);
      if (!canChoose || style === "text") return [fallback];
      const options = [
        { id: message.yesId, label: "Confirmar" },
        { id: message.noId, label: "Cancelar" },
      ];
      // Texto y botones: la tarjeta completa como siempre, y debajo los dos botones.
      if (style === "both") return [fallback, tappable(message.to, CARD_QUESTION, options, "")];
      // En encuesta, la tarjeta va como mensaje y abajo solo la pregunta con sus dos opciones.
      if (style === "poll") {
        return [card, { choice: { text: CARD_QUESTION, options, style, fallback: "Responde *CONFIRMAR* o *CANCELAR*" } }];
      }
      return [tappable(message.to, card, options, fallback)];
    }
    if (message.kind === "choice") {
      const question = whatsappStyle(message.text);
      // Sin botones, las opciones van como lista: una por renglón, para contestar con cualquiera.
      const fallback = `${question}\n\n${optionList(message.options.map((option) => option.label))}`;
      const style = message.style ?? styleFor(message.to);
      if (!canChoose || style === "text") return [fallback];
      if (style === "both") {
        return [fallback, tappable(message.to, "Toca una opción:", message.options, "", message.variant)];
      }
      if (style === "buttons") return [tappable(message.to, question, message.options, fallback, message.variant)];
      // El título de una encuesta no admite formato: va el texto tal cual.
      return [{ choice: { text: style === "poll" ? message.text : question, options: message.options, style, fallback } }];
    }
    return [{ image: message.png.toString("base64"), caption: whatsappStyle(message.caption) }];
  });
}

function reply(status: number, body: string | Buffer, type = TEXT): CoreReply {
  return { status, type, body };
}

function json(status: number, value: unknown): CoreReply {
  return { status, type: JSON_TYPE, body: JSON.stringify(value) };
}

interface OutboxItem {
  id: string;
  to: string;
  text: string;
}

/**
 * Arranca Zaldo con las llaves del entorno. Si falta alguna, lanza el motivo:
 * el servidor contesta 503 y sigue sirviendo la landing.
 */
/**
 * ¿Es el secreto esperado? Se comparan los sha256 en tiempo constante: lo que
 * tarda la respuesta no le dice a nadie cuántos caracteres atinó.
 */
export function sameSecret(given: unknown, expected: string | null | undefined): boolean {
  if (typeof given !== "string" || !given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** "hace un momento", "hace 3 min", "hace 2 h", "hace 4 días". */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "hace un momento";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `hace ${hours} h`;
  return `hace ${Math.round(hours / 24)} días`;
}

/**
 * Lo que el puente de WhatsApp dejó anotado: cuándo llegó el último mensaje y
 * cuándo salió la última respuesta. Solo fechas; nunca quién escribió ni qué.
 */
export function bridgeActivity(dataDir: string, now: number): string {
  let stats: Record<string, unknown>;
  try {
    stats = JSON.parse(readFileSync(join(dataDir, "zaldo-wa-stats.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return "";
  }
  const when = (key: string): number => {
    const value = Number(stats[key]);
    return Number.isFinite(value) && value > 0 && value <= now + 60_000 ? value : 0;
  };
  const inbound = when("lastInboundAt");
  const replied = when("lastReplyAt");
  const failed = when("lastErrorAt");
  if (!inbound && !replied) return "Todavía no llega ningún mensaje a este número.";
  const parts = [
    inbound ? `Último mensaje recibido: ${ago(inbound, now)}` : "Sin mensajes recibidos",
    replied ? `última respuesta: ${ago(replied, now)}` : "sin respuestas todavía",
  ];
  // Un tropiezo más nuevo que la última respuesta es justo lo que hay que ver aquí.
  if (failed && failed > replied) parts.push(`último tropiezo: ${ago(failed, now)}`);
  return parts.join(" · ");
}

export function createZaldo(host: CoreHost): ZaldoCore {
  const config: AppConfig = loadConfig(host.env);
  if (!config.publicBaseUrl && host.publicBaseUrl) config.publicBaseUrl = host.publicBaseUrl.replace(/\/$/, "");
  const dataDir = dirname(config.dataPath);
  const store = fileStore(config.dataPath);
  const pey = new PeyClient(config.peyApiBase, config.peyKey, fetch, { bankAccountId: config.peyBankAccountId });
  const whatsapp = new WhatsApp(config.whatsappToken, config.whatsappPhoneNumberId);
  const flows: FlowDeps = {
    store,
    config,
    pey,
    complete: openRouterCompleter(config),
    now: () => Date.now(),
    transcribe: async (mediaId, mime) => transcribeWithOpenRouter(config, await whatsapp.downloadMedia(mediaId), mime),
  };

  // Avisos que el puente de WhatsApp recoge: "ya cayó" y "venció". Viven en disco para no perderse.
  const outboxFile = join(dataDir, "zaldo-outbox.json");
  const outbox: OutboxItem[] = [];
  try {
    if (existsSync(outboxFile)) {
      const saved = JSON.parse(readFileSync(outboxFile, "utf8")) as unknown;
      if (Array.isArray(saved)) outbox.push(...(saved as OutboxItem[]));
    }
  } catch {
    /* vacío */
  }
  const saveOutbox = () => {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(outboxFile, JSON.stringify(outbox));
    } catch (error) {
      console.error("zaldo outbox", error instanceof Error ? error.message : error);
    }
  };
  const enqueue = (to: string, text: string) => {
    if (!to || !text) return;
    outbox.push({ id: randomUUID(), to, text });
    saveOutbox();
  };

  const timer = setInterval(() => {
    void (async () => {
      try {
        // Primero se le pregunta a pey: el aviso de pago llega aunque el webhook
        // no esté configurado, y un cobro ya pagado no se da por vencido.
        for (const paid of await reconcilePending(flows)) {
          enqueue(paid.owner, paid.text);
          const current = store.getCharge(paid.chargeId);
          if (current) store.updateCharge({ ...current, paidNoticeSent: true });
        }
        for (const notice of takeExpired(store, Date.now())) enqueue(notice.owner, notice.text);
        // Los cobros recurrentes que ya tocan salen solos, y se le avisa a quien cobra.
        for (const notice of await runRecurring(flows)) enqueue(notice.owner, notice.text);
        // Cuentas recién registradas en la página, y las que Banxico ya activó.
        for (const notice of takeNewAccounts(store)) enqueue(notice.owner, notice.text);
        for (const notice of await checkAccounts(accounts)) enqueue(notice.owner, notice.text);
      } catch (error) {
        console.error("zaldo reloj", error instanceof Error ? error.message : error);
      }
    })();
  }, 30_000);
  timer.unref?.();

  /** El número del bot sale de la sesión de WhatsApp que dejó el puente: sirve para el botón de regreso. */
  const botNumber = (): string | null => {
    try {
      const creds = JSON.parse(readFileSync(join(dataDir, "zaldo-wa", "creds.json"), "utf8")) as { me?: { id?: string } };
      const digits = String(creds.me?.id ?? "").split("@")[0]?.split(":")[0]?.replace(/\D/g, "") ?? "";
      return digits.length >= 10 ? digits : null;
    } catch {
      return null;
    }
  };
  const accounts: AccountDeps = { store, config, pey, now: () => Date.now(), botNumber };

  const bridgeOk = (request: CoreRequest) => {
    return sameSecret(request.headers["x-zaldo-token"], config.whatsappVerifyToken);
  };

  async function deliver(messages: Outbound[]): Promise<void> {
    for (const message of messages) {
      if (message.kind === "text") await whatsapp.sendText(message.to, whatsappStyle(message.text));
      else if (message.kind === "buttons") {
        await whatsapp.sendButtons(message.to, whatsappStyle(message.text), message.yesId, message.noId);
      } else if (message.kind === "choice") await whatsapp.sendChoice(message.to, whatsappStyle(message.text), message.options);
      else await whatsapp.sendImage(message.to, message.png, whatsappStyle(message.caption));
    }
  }

  function linkPage(): CoreReply {
    let state = "starting";
    let detail = "";
    try {
      const info = JSON.parse(readFileSync(join(dataDir, "zaldo-wa.json"), "utf8")) as Record<string, unknown>;
      state = String(info.state || state);
      detail = String(info.error || info.code || "");
    } catch {
      /* aún no */
    }
    const img = state === "qr" ? '<img src="/zaldo/qr.png" alt="QR" width="360" height="360">' : "";
    const msg =
      state === "open"
        ? "WhatsApp ya está vinculado. Escríbele a ese número."
        : state === "error" || state === "close"
          ? `No pude abrir WhatsApp. ${detail}`
          : "En el celular del bot: WhatsApp, Ajustes, Dispositivos vinculados, Vincular un dispositivo.";
    const activity = state === "open" ? bridgeActivity(dataDir, Date.now()) : "";
    const seen = activity ? `<p style="color:#667085;font-size:.9rem">${activity}</p>` : "";
    return reply(
      200,
      `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Vincular</title><body style="font-family:sans-serif;text-align:center;padding:2rem"><h1>Vincular Zaldo</h1><p>${msg}</p>${seen}${img}</body>`,
      HTML,
    );
  }

  /** El formato de botones para ese chat: el que comprobó, o el último que alguien vio funcionar. */
  const variantOf = (owner: string): Variant => {
    const own = store.getProfile(owner).choiceVariant;
    if (isVariant(own)) return own;
    const shared = store.getProfile(BUTTON_CONFIG).choiceVariant;
    return isVariant(shared) ? shared : "A";
  };

  async function bridgeInbound(request: CoreRequest): Promise<CoreReply> {
    if (!bridgeOk(request)) return reply(401, "forbidden");
    const raw = await request.body();
    const body = raw.length ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};
    const from = String(body.from || "").replace(/\D/g, "");
    const messageId = String(body.id || randomUUID());
    if (!from) return json(200, { replies: [] });
    // WhatsApp a veces entrega el chat sin número (LID). Si el puente sí lo
    // conoce, queda como el celular de esa persona: no hay que pedírselo.
    const phone = toTenDigits(typeof body.phone === "string" ? body.phone : "");
    if (phone) {
      const profile = store.getProfile(from);
      if (!profile.phone) store.setProfile({ ...profile, phone });
    }
    let text = String(body.text || "");
    if (!text && body.audio && typeof body.audio === "object") {
      const audio = body.audio as { data?: string; mime?: string };
      try {
        if (audio.data) {
          text = await transcribeWithOpenRouter(config, Buffer.from(audio.data, "base64"), audio.mime || "audio/ogg");
        }
      } catch (error) {
        console.error("zaldo nota de voz", error instanceof Error ? error.message : error);
      }
      if (!text.trim()) return json(200, { replies: ["No te entendí en la nota de voz. ¿Me lo escribes?"] });
    }
    // El puente nuevo sabe enseñar botones y lo dice; al viejo se le sigue mandando texto.
    const canChoose = Array.isArray(body.caps) && body.caps.includes("choice");
    const canRaw = Array.isArray(body.caps) && body.caps.includes("raw");
    // Un botón tocado: el de la tarjeta (c:/x:) va directo a la caja; el de una pregunta es su texto.
    const button = typeof body.button === "string" ? body.button.slice(0, 300) : "";
    // Tocó un botón: en su WhatsApp sí se ven. Desde aquí, ese chat recibe solo botones.
    if (button) {
      const profile = store.getProfile(from);
      if (profile.choiceStyle !== "buttons") store.setProfile({ ...profile, choiceStyle: "buttons" });
    }
    const handled = await handleInbound(
      flows,
      /^[cx]:[0-9a-f-]{36}$/i.test(button)
        ? { type: "button", owner: from, messageId, buttonId: button }
        : // CONFIRMAR / CANCELAR escritos los resuelve handleInbound (flows.ts), igual que un botón.
          { type: "text", owner: from, messageId, text: text || (button.startsWith("o:") ? button.slice(2) : "") },
    );
    if (handled.claimed) ackInbound(store, messageId);
    return json(200, { replies: asReplies(handled.messages, canChoose, (owner) => {
        // Solo botones para quien ya tocó uno; solo texto para quien pidió "sin botones"; los demás, las dos cosas.
        const own = store.getProfile(owner).choiceStyle;
        return own === "buttons" ? "buttons" : own === "text" || own === "poll" ? "text" : CHOICE_STYLE;
      }, canRaw ? variantOf : null) });
  }

  async function metaWebhook(request: CoreRequest): Promise<CoreReply> {
    const raw = await request.body();
    if (!verifyMetaSignature(config.whatsappAppSecret, raw, request.headers["x-hub-signature-256"])) {
      return reply(401, "bad signature");
    }
    const payload = raw.length ? (JSON.parse(raw.toString("utf8")) as unknown) : {};
    try {
      for (const message of parseWhatsAppPayload(payload)) {
        const handled = await handleInbound(flows, message);
        try {
          await deliver(handled.messages);
          if (handled.claimed) ackInbound(store, message.messageId);
        } catch (error) {
          if (handled.claimed) releaseInbound(store, message.messageId);
          throw error;
        }
      }
      return reply(200, "ok");
    } catch (error) {
      console.error("zaldo whatsapp", error instanceof Error ? error.message : error);
      return reply(500, "retry");
    }
  }

  async function peyWebhook(request: CoreRequest): Promise<CoreReply> {
    const raw = await request.body();
    try {
      verifyPeyWebhook(config.peyWebhookSecret, raw.toString("utf8"), {
        id: request.headers["webhook-id"],
        timestamp: request.headers["webhook-timestamp"],
        signature: request.headers["webhook-signature"],
      });
    } catch (error) {
      console.error("zaldo pey firma", error instanceof Error ? error.message : error);
      return reply(401, "bad signature");
    }
    const webhookId = request.headers["webhook-id"] ?? "";
    const key = webhookId ? `pey:${webhookId}` : "";
    if (key && store.claim(key) === "skip") return reply(200, "ok");
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      if (key) store.release(key);
      return reply(400, "bad json");
    }
    // pey también avisa por aquí cuando Banxico activa la cuenta de alguien.
    const activated = applyBankEvent(store, body);
    if (activated) enqueue(activated.owner, activated.text);
    const notice = applyPeyEvent(store, body, Date.now());
    if (notice) {
      enqueue(notice.owner, notice.text);
      try {
        await whatsapp.sendText(notice.owner, notice.text);
      } catch (error) {
        // Sin la API de Meta el aviso sale por el puente, que ya lo tiene en la cola.
        console.error("zaldo aviso", error instanceof Error ? error.message : error);
      }
      const current = store.getCharge(notice.chargeId);
      if (current) store.updateCharge({ ...current, paidNoticeSent: true });
    }
    if (key) store.complete(key);
    return reply(200, "ok");
  }

  async function handle(request: CoreRequest): Promise<CoreReply> {
    const { method, path } = request;
    if (method === "GET") {
      if (path === "/health") return json(200, { ok: true, build: CORE_BUILD });
      if (path === "/vincular") return linkPage();
      if (path === "/zaldo/qr.png") {
        const file = join(dataDir, "zaldo-qr.png");
        return existsSync(file) ? reply(200, readFileSync(file), "image/png") : reply(404, "not found");
      }
      // Diagnóstico del puente de WhatsApp: fechas, contadores y el último tropiezo. Sin texto de nadie.
      if (path === "/zaldo/bridge/stats") {
        if (!bridgeOk(request)) return reply(401, "forbidden");
        const read = (name: string): unknown => {
          try {
            return JSON.parse(readFileSync(join(dataDir, name), "utf8")) as unknown;
          } catch {
            return null;
          }
        };
        return json(200, { now: Date.now(), wa: read("zaldo-wa.json"), stats: read("zaldo-wa-stats.json") });
      }
      if (path === "/zaldo/bridge/outbox") {
        if (!bridgeOk(request)) return reply(401, "forbidden");
        const items = outbox.splice(0, outbox.length);
        saveOutbox();
        return json(200, { items: items.map((item) => ({ ...item, text: whatsappStyle(item.text) })) });
      }
      if (path === "/pago/listo") return reply(200, PAGE_OK, HTML);
      if (path === "/pago/volver") return reply(200, PAGE_BACK, HTML);
      if (path === "/webhooks/whatsapp") {
        const challenge = request.query["hub.challenge"] ?? "";
        const ok =
          request.query["hub.mode"] === "subscribe" &&
          sameSecret(request.query["hub.verify_token"], config.whatsappVerifyToken) &&
          !!challenge;
        return ok ? reply(200, challenge) : reply(403, "forbidden");
      }
    }
    if (path === "/cuenta" && (method === "GET" || method === "POST")) {
      return handleAccountPage(accounts, request);
    }
    if (method === "POST") {
      if (path === "/zaldo/bridge/inbound") return bridgeInbound(request);
      if (path === "/webhooks/whatsapp") return metaWebhook(request);
      if (path === "/webhooks/pey") return peyWebhook(request);
    }
    return reply(404, "not found");
  }

  return {
    api: CORE_API,
    build: CORE_BUILD,
    dataDir,
    handle,
    stop: () => clearInterval(timer),
  };
}
