import { createHmac, timingSafeEqual } from "node:crypto";
import type { Inbound } from "./inbound.js";

const GRAPH = "https://graph.facebook.com/v22.0";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function verifyMetaSignature(appSecret: string, raw: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(raw).digest("hex");
  const given = header.slice("sha256=".length);
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseWhatsAppPayload(body: unknown): Inbound[] {
  const root = asRecord(body);
  const entries = Array.isArray(root?.entry) ? root.entry : [];
  const out: Inbound[] = [];
  for (const entry of entries) {
    const changes = asRecord(entry)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const messages = asRecord(asRecord(change)?.value)?.messages;
      if (!Array.isArray(messages)) continue;
      for (const message of messages) {
        const parsed = parseMessage(message);
        if (parsed) out.push(parsed);
      }
    }
  }
  return out;
}

function parseMessage(value: unknown): Inbound | null {
  const message = asRecord(value);
  if (!message) return null;
  const owner = typeof message.from === "string" ? message.from : "";
  const messageId = typeof message.id === "string" ? message.id : "";
  if (!owner || !messageId) return null;
  if (message.type === "text") {
    const text = asRecord(message.text)?.body;
    if (typeof text !== "string") return null;
    return { type: "text", owner, messageId, text };
  }
  if (message.type === "audio") {
    const audio = asRecord(message.audio);
    const mediaId = audio?.id;
    if (!audio || typeof mediaId !== "string") return null;
    const mime = typeof audio.mime_type === "string" ? audio.mime_type : "audio/ogg";
    return { type: "audio", owner, messageId, mediaId, mime };
  }
  if (message.type === "interactive") {
    const reply = asRecord(asRecord(message.interactive)?.button_reply);
    const buttonId = reply?.id;
    if (typeof buttonId !== "string") return null;
    return { type: "button", owner, messageId, buttonId };
  }
  return null;
}

export function audioFormat(mime: string): string {
  const base = mime.split(";")[0]?.trim().toLowerCase() ?? "";
  if (base.includes("mpeg") || base.includes("mp3")) return "mp3";
  if (base.includes("wav")) return "wav";
  if (base.includes("mp4") || base.includes("m4a")) return "m4a";
  return "ogg";
}

export class WhatsApp {
  constructor(
    private readonly token: string,
    private readonly phoneNumberId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendText(to: string, text: string): Promise<void> {
    await this.send({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text.slice(0, 4000) },
    });
  }

  async sendButtons(to: string, body: string, yesId: string, noId: string): Promise<void> {
    await this.send({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body.slice(0, 1024) },
        action: {
          buttons: [
            { type: "reply", reply: { id: yesId, title: "Confirmar" } },
            { type: "reply", reply: { id: noId, title: "Cancelar" } },
          ],
        },
      },
    });
  }

  async sendImage(to: string, png: Buffer, caption: string): Promise<void> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", "image/png");
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "codi.png");
    const uploaded = await this.request(`/${this.phoneNumberId}/media`, { method: "POST", body: form });
    const id = String(uploaded.id ?? "");
    if (!id) throw new Error("WhatsApp no devolvió el id de la imagen");
    await this.send({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { id, caption: caption.slice(0, 1024) },
    });
  }

  async downloadMedia(mediaId: string): Promise<Uint8Array> {
    const meta = await this.request(`/${mediaId}`, { method: "GET" });
    const url = typeof meta.url === "string" ? meta.url : "";
    if (!url) throw new Error("WhatsApp no dio la URL de la nota");
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("No pude bajar la nota de voz");
    return new Uint8Array(await response.arrayBuffer());
  }

  private async send(payload: unknown): Promise<void> {
    await this.request(`/${this.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }

  private async request(path: string, init: RequestInit): Promise<Record<string, unknown>> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    const response = await this.fetchImpl(`${GRAPH}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { message: text.slice(0, 180) };
      }
    }
    if (!response.ok) {
      const error = asRecord(body.error);
      throw new Error(String(error?.message ?? body.message ?? `WhatsApp respondió ${response.status}`).slice(0, 180));
    }
    return body;
  }
}
