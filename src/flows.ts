import { randomInt } from "node:crypto";
import QRCode from "qrcode";
import { chargeCard, runAgent, type Completer } from "./agent.js";
import type { AppConfig } from "./config.js";
import type { Inbound, Outbound } from "./inbound.js";
import { formatMxn, mexicoDayStart } from "./money.js";
import { isAllowed } from "./phone.js";
import type { LinkInput, LinkResult, PushInput, PushResult, QrInput, QrResult } from "./pey.js";
import { Store, type Charge } from "./store.js";

export interface PeyPort {
  push(input: PushInput): Promise<PushResult>;
  qr(input: QrInput): Promise<QrResult>;
  link(input: LinkInput): Promise<LinkResult>;
}

export interface FlowDeps {
  store: Store;
  config: AppConfig;
  pey: PeyPort;
  complete: Completer;
  transcribe: (mediaId: string, mime: string) => Promise<string>;
  now: () => number;
  renderQr?: (payload: string) => Promise<Buffer>;
}

export async function renderQrPng(payload: string): Promise<Buffer> {
  return QRCode.toBuffer(payload, { errorCorrectionLevel: "M", width: 480, margin: 2 });
}

function newNumRef(used: Set<string>): string {
  for (let attempt = 0; attempt < 30; attempt++) {
    const ref = String(1_000_000 + randomInt(9_000_000));
    if (!used.has(ref)) return ref;
  }
  throw new Error("No quedó una referencia libre");
}

function remember(store: Store, owner: string, role: "user" | "assistant", content: string, now: number): void {
  store.appendTurn(owner, { role, content, at: now });
}

async function confirm(deps: FlowDeps, owner: string, chargeId: string): Promise<Outbound[]> {
  const now = deps.now();
  const charge = deps.store.getCharge(chargeId);
  if (!charge || charge.owner !== owner) {
    return [{ kind: "text", to: owner, text: "Ese cobro no es de este chat." }];
  }
  if (charge.status !== "awaiting_confirm") {
    return [{ kind: "text", to: owner, text: "Ese cobro ya no está esperando confirmación." }];
  }
  if (now > charge.confirmBy) {
    deps.store.updateCharge({ ...charge, status: "cancelled" });
    return [{ kind: "text", to: owner, text: "Ese cobro caducó. Pídelo otra vez." }];
  }
  const used = deps.store.confirmedCentsSince(owner, mexicoDayStart(now));
  if (used + charge.amountCents > deps.config.dailyCapCents) {
    return [{ kind: "text", to: owner, text: "Ese monto ya pasa el tope de hoy." }];
  }

  const numRef = charge.method === "link" ? null : newNumRef(deps.store.usedNumRefs());
  const expiresAt =
    charge.method === "push"
      ? now + deps.config.pushExpirationSec * 1000
      : charge.method === "qr"
        ? now + deps.config.qrExpirationSec * 1000
        : null;
  const locked: Charge = { ...charge, status: "pending", numRef, expiresAt };
  deps.store.updateCharge(locked);
  try {
    if (charge.method === "push") {
      if (!charge.payerPhone || !numRef) throw new Error("Falta el celular");
      const sent = await deps.pey.push({
        amountCents: charge.amountCents,
        phone: charge.payerPhone,
        concept: charge.concept,
        numRef,
        chargeId: charge.id,
        expirationSec: deps.config.pushExpirationSec,
      });
      const current = deps.store.getCharge(charge.id) ?? locked;
      deps.store.updateCharge({
        ...current,
        peyTransactionId: sent.transactionId || current.peyTransactionId,
        peyExternalId: sent.codiId || current.peyExternalId,
      });
      const text = `Listo. Le mandé el cobro CoDi a ${charge.payerName} por ${formatMxn(charge.amountCents)}. Aviso cuando caiga.`;
      remember(deps.store, owner, "assistant", text, now);
      return [{ kind: "text", to: owner, text }];
    }
    if (charge.method === "qr") {
      if (!numRef) throw new Error("Falta la referencia");
      const sent = await deps.pey.qr({
        amountCents: charge.amountCents,
        concept: charge.concept,
        numRef,
        chargeId: charge.id,
        expirationSec: deps.config.qrExpirationSec,
      });
      if (!sent.qrString) throw new Error("Pey no devolvió el QR");
      const png = await (deps.renderQr ?? renderQrPng)(sent.qrString);
      const current = deps.store.getCharge(charge.id) ?? locked;
      deps.store.updateCharge({ ...current, peyExternalId: sent.id || current.peyExternalId });
      const caption = `QR CoDi de ${formatMxn(charge.amountCents)} · ${charge.concept}`;
      remember(deps.store, owner, "assistant", caption, now);
      return [{ kind: "image", to: owner, png, caption }];
    }
    if (!deps.config.publicBaseUrl) throw new Error("Falta la URL pública");
    const sent = await deps.pey.link({
      amountCents: charge.amountCents,
      chargeId: charge.id,
      successUrl: `${deps.config.publicBaseUrl}/pago/listo`,
      backUrl: `${deps.config.publicBaseUrl}/pago/volver`,
    });
    const current = deps.store.getCharge(charge.id) ?? locked;
    deps.store.updateCharge({
      ...current,
      peyExternalId: sent.id || current.peyExternalId,
      linkUrl: sent.url,
    });
    const text = `Link para pagar ${formatMxn(charge.amountCents)} · ${charge.concept}\n${sent.url}`;
    remember(deps.store, owner, "assistant", text, now);
    return [{ kind: "text", to: owner, text }];
  } catch (error) {
    const message = error instanceof Error ? error.message : "Pey no respondió";
    const current = deps.store.getCharge(charge.id) ?? locked;
    if (current.status !== "paid") deps.store.updateCharge({ ...current, status: "failed" });
    const text = `No pude enviar el cobro. ${message}`;
    remember(deps.store, owner, "assistant", text, now);
    return [{ kind: "text", to: owner, text }];
  }
}

async function onButton(deps: FlowDeps, owner: string, buttonId: string): Promise<Outbound[]> {
  const match = /^(c|x):([0-9a-f-]{36})$/i.exec(buttonId);
  if (!match) return [{ kind: "text", to: owner, text: "No reconocí ese botón." }];
  const charge = deps.store.getCharge(match[2]);
  if (!charge || charge.owner !== owner) {
    return [{ kind: "text", to: owner, text: "Ese cobro no es de este chat." }];
  }
  if (match[1].toLowerCase() === "x") {
    if (charge.status === "awaiting_confirm") {
      deps.store.updateCharge({ ...charge, status: "cancelled" });
    }
    const text = `Cancelé el cobro de ${formatMxn(charge.amountCents)}.`;
    remember(deps.store, owner, "assistant", text, deps.now());
    return [{ kind: "text", to: owner, text }];
  }
  return confirm(deps, owner, charge.id);
}

async function onText(deps: FlowDeps, owner: string, text: string): Promise<Outbound[]> {
  const now = deps.now();
  const clean = text.trim();
  if (!clean) return [{ kind: "text", to: owner, text: "Dime a quién le cobro y cuánto." }];
  remember(deps.store, owner, "user", clean, now);
  const result = await runAgent({
    store: deps.store,
    config: deps.config,
    owner,
    now,
    complete: deps.complete,
  });
  if (result.charge) {
    const card = chargeCard(result.charge);
    remember(deps.store, owner, "assistant", card, now);
    return [
      {
        kind: "buttons",
        to: owner,
        text: card,
        yesId: `c:${result.charge.id}`,
        noId: `x:${result.charge.id}`,
      },
    ];
  }
  const reply = result.reply ?? "Dime a quién le cobro, cuánto y el concepto.";
  remember(deps.store, owner, "assistant", reply, now);
  return [{ kind: "text", to: owner, text: reply }];
}

export async function handleInbound(
  deps: FlowDeps,
  inbound: Inbound,
): Promise<{ messages: Outbound[]; claimed: boolean }> {
  if (!isAllowed(inbound.owner, deps.config.allowedPhones)) return { messages: [], claimed: false };
  const key = `wa:${inbound.messageId}`;
  if (deps.store.claim(key) === "skip") return { messages: [], claimed: false };
  try {
    let messages: Outbound[];
    if (inbound.type === "button") messages = await onButton(deps, inbound.owner, inbound.buttonId);
    else if (inbound.type === "audio") {
      let transcript = "";
      try {
        transcript = (await deps.transcribe(inbound.mediaId, inbound.mime)).trim();
      } catch (error) {
        console.error("nota de voz", error instanceof Error ? error.message : error);
        transcript = "";
      }
      messages = transcript
        ? await onText(deps, inbound.owner, transcript)
        : [{ kind: "text", to: inbound.owner, text: "No te entendí en la nota. ¿Me lo escribes?" }];
    } else messages = await onText(deps, inbound.owner, inbound.text);
    return { messages, claimed: true };
  } catch (error) {
    deps.store.release(key);
    throw error;
  }
}

export function ackInbound(store: Store, messageId: string): void {
  store.complete(`wa:${messageId}`);
}

export function releaseInbound(store: Store, messageId: string): void {
  store.release(`wa:${messageId}`);
}

export function applyPeyEvent(
  store: Store,
  body: Record<string, unknown>,
  now: number,
): { chargeId: string; owner: string; text: string } | null {
  const type = String(body.type ?? "");
  let charge: Charge | null = null;
  if (type === "codi.qr.payment_received" || type === "codi.pn.payment_received") {
    const numRef = String(body.numRef ?? "");
    const txn = String(body.transactionId ?? "");
    const qrId = String(body.codiQrId ?? "");
    charge =
      store.findCharge(
        (item) =>
          (!!numRef && item.numRef === numRef) ||
          (!!txn && item.peyTransactionId === txn) ||
          (!!qrId && item.peyExternalId === qrId),
      ) ?? null;
  } else if (type === "payment_link.status_updated") {
    if (body.status !== "paid") return null;
    const ref = String(body.clientReferenceId ?? "");
    const linkId = String(body.paymentLinkId ?? "");
    charge =
      store.findCharge((item) => item.id === ref || (!!linkId && item.peyExternalId === linkId)) ?? null;
  } else {
    return null;
  }
  if (!charge || (charge.status === "paid" && charge.paidNoticeSent)) return null;
  if (charge.status !== "paid") {
    const tx = Array.isArray(body.transactions)
      ? (body.transactions[0] as Record<string, unknown> | undefined)
      : undefined;
    const datePaid =
      typeof body.datePaid === "number" ? body.datePaid : tx && typeof tx.datePaid === "number" ? tx.datePaid : null;
    const paidAt = datePaid === null ? now : datePaid * 1000;
    const paid: Charge = { ...charge, status: "paid", paidAt, paidNoticeSent: false };
    store.updateCharge(paid);
    const text = `Ya cayó, ${formatMxn(paid.amountCents)} de ${paid.payerName} · ${paid.concept}`;
    remember(store, paid.owner, "assistant", text, now);
    return { chargeId: paid.id, owner: paid.owner, text };
  }
  const text = `Ya cayó, ${formatMxn(charge.amountCents)} de ${charge.payerName} · ${charge.concept}`;
  return { chargeId: charge.id, owner: charge.owner, text };
}

export function takeExpired(store: Store, now: number): { owner: string; text: string }[] {
  const due = store
    .listCharges()
    .filter(
      (charge) =>
        charge.status === "pending" && charge.expiresAt !== null && charge.expiresAt <= now && !charge.expiryNotified,
    );
  return due.map((charge) => {
    store.updateCharge({ ...charge, status: "expired", expiryNotified: true });
    const text = `El cobro de ${formatMxn(charge.amountCents)} a ${charge.payerName} venció sin pagarse. Dime si lo reenvío.`;
    remember(store, charge.owner, "assistant", text, now);
    return { owner: charge.owner, text };
  });
}
