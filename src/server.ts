import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ReconcileCache } from "./admin/reconcile.js";
import { handleAdminRoutes } from "./admin/routes.js";
import type { AuthConfig } from "./auth/config.js";
import { handleAuthRoutes } from "./auth/routes.js";
import type { AuthService } from "./auth/service.js";
import type { AppConfig } from "./config.js";
import {
  ackInbound,
  applyPeyEvent,
  handleInbound,
  reconcilePending,
  releaseInbound,
  takeExpired,
  type FlowDeps,
} from "./flows.js";
import type { Outbound } from "./inbound.js";
import { serveLanding } from "./landing.js";
import { verifyPeyWebhook } from "./peyWebhook.js";
import { parseWhatsAppPayload, verifyMetaSignature, type WhatsApp } from "./whatsapp.js";

export interface ServerDeps {
  config: AppConfig;
  flows: FlowDeps;
  whatsapp: WhatsApp;
  /** Panel administrador. Sin esto, /admin responde 404 y Zaldo sigue igual. */
  admin?: {
    auth: AuthService;
    authConfig: AuthConfig;
    reconcile?: ReconcileCache;
  };
  /** Carpeta de la landing; por defecto landing/ en la raíz del repo. */
  landingDir?: string;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

async function deliver(whatsapp: WhatsApp, messages: Outbound[]): Promise<void> {
  for (const message of messages) {
    if (message.kind === "text") await whatsapp.sendText(message.to, message.text);
    else if (message.kind === "buttons") await whatsapp.sendButtons(message.to, message.text, message.yesId, message.noId);
    else await whatsapp.sendImage(message.to, message.png, message.caption);
  }
}

const PAGE_OK = `<!doctype html><meta charset="utf-8"><title>Zaldo</title><body style="font-family:sans-serif;padding:2rem"><h1>Listo</h1><p>Si ya pagaste, Zaldo te avisa por WhatsApp.</p>`;
const PAGE_BACK = `<!doctype html><meta charset="utf-8"><title>Zaldo</title><body style="font-family:sans-serif;padding:2rem"><h1>Volviste</h1><p>El pago sigue pendiente. Puedes cerrar esta página.</p>`;

export function createApp(deps: ServerDeps) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, JSON.stringify({ ok: true }), "application/json");
        return;
      }
      if (req.method === "GET" && url.pathname === "/pago/listo") {
        send(res, 200, PAGE_OK, "text/html; charset=utf-8");
        return;
      }
      if (req.method === "GET" && url.pathname === "/pago/volver") {
        send(res, 200, PAGE_BACK, "text/html; charset=utf-8");
        return;
      }
      // El panel va antes de leer el cuerpo: sus rutas manejan su propio form.
      if (deps.admin && (url.pathname === "/admin" || url.pathname.startsWith("/admin"))) {
        const adminDeps = {
          auth: deps.admin.auth,
          authConfig: deps.admin.authConfig,
          store: deps.flows.store,
          config: deps.config,
          now: deps.flows.now,
          reconcile: deps.admin.reconcile,
        };
        if (await handleAuthRoutes(adminDeps, req, res, url)) return;
        if (await handleAdminRoutes(adminDeps, req, res, url)) return;
      }
      if (url.pathname === "/webhooks/whatsapp" && req.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        if (mode === "subscribe" && token === deps.config.whatsappVerifyToken && challenge) {
          send(res, 200, challenge);
          return;
        }
        send(res, 403, "forbidden");
        return;
      }
      // Landing estática en "/" (index.html, styles.css, assets/, vendor/...).
      if (await serveLanding(req, res, url.pathname, deps.landingDir)) return;
      const raw = await readBody(req);
      if (url.pathname === "/webhooks/whatsapp" && req.method === "POST") {
        const signature = req.headers["x-hub-signature-256"];
        const header = Array.isArray(signature) ? signature[0] : signature;
        if (!verifyMetaSignature(deps.config.whatsappAppSecret, raw, header)) {
          send(res, 401, "bad signature");
          return;
        }
        const payload = raw.length ? (JSON.parse(raw.toString("utf8")) as unknown) : {};
        const incoming = parseWhatsAppPayload(payload);
        try {
          for (const message of incoming) {
            const handled = await handleInbound(deps.flows, message);
            try {
              await deliver(deps.whatsapp, handled.messages);
              if (handled.claimed) ackInbound(deps.flows.store, message.messageId);
            } catch (error) {
              if (handled.claimed) releaseInbound(deps.flows.store, message.messageId);
              throw error;
            }
          }
          send(res, 200, "ok");
        } catch (error) {
          console.error("whatsapp", error instanceof Error ? error.message : error);
          if (!res.headersSent) send(res, 500, "retry");
        }
        return;
      }
      if (url.pathname === "/webhooks/pey" && req.method === "POST") {
        const header = (name: string) => {
          const value = req.headers[name];
          return Array.isArray(value) ? value[0] : value;
        };
        try {
          verifyPeyWebhook(deps.config.peyWebhookSecret, raw.toString("utf8"), {
            id: header("webhook-id"),
            timestamp: header("webhook-timestamp"),
            signature: header("webhook-signature"),
          });
        } catch (error) {
          console.error("pey firma", error instanceof Error ? error.message : error);
          send(res, 401, "bad signature");
          return;
        }
        const webhookId = header("webhook-id") ?? "";
        const key = webhookId ? `pey:${webhookId}` : "";
        if (key && deps.flows.store.claim(key) === "skip") {
          send(res, 200, "ok");
          return;
        }
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        } catch {
          if (key) deps.flows.store.release(key);
          send(res, 400, "bad json");
          return;
        }
        const notice = applyPeyEvent(deps.flows.store, body, deps.flows.now());
        if (notice) {
          try {
            await deps.whatsapp.sendText(notice.owner, notice.text);
            const current = deps.flows.store.getCharge(notice.chargeId);
            if (current) deps.flows.store.updateCharge({ ...current, paidNoticeSent: true });
          } catch (error) {
            if (key) deps.flows.store.release(key);
            console.error("aviso de pago", error instanceof Error ? error.message : error);
            send(res, 500, "retry");
            return;
          }
        }
        if (key) deps.flows.store.complete(key);
        send(res, 200, "ok");
        return;
      }
      send(res, 404, "not found");
    } catch (error) {
      console.error("http", error instanceof Error ? error.message : error);
      if (!res.headersSent) send(res, 500, "error");
    }
  });
}

export function startSweeper(deps: FlowDeps, whatsapp: WhatsApp, auth?: AuthService): NodeJS.Timeout {
  return setInterval(() => {
    void (async () => {
      try {
        auth?.sweep(deps.now());
        // Primero se le pregunta a Pey: un cobro ya pagado no se da por vencido.
        for (const paid of await reconcilePending(deps)) {
          await whatsapp.sendText(paid.owner, paid.text);
          const current = deps.store.getCharge(paid.chargeId);
          if (current) deps.store.updateCharge({ ...current, paidNoticeSent: true });
        }
        const notices = takeExpired(deps.store, deps.now());
        for (const notice of notices) await whatsapp.sendText(notice.owner, notice.text);
      } catch (error) {
        console.error("vencidos", error instanceof Error ? error.message : error);
      }
    })();
  }, 30_000);
}
