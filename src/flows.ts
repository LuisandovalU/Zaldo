import { randomInt } from "node:crypto";
import QRCode from "qrcode";
import { chargeCard, PAYER_OPEN, PAYER_SELF, prettyPhone, runAgent, type Completer } from "./agent.js";
import type { AppConfig } from "./config.js";
import { goalLine, settleDebts } from "./caja.js";
import type { Inbound, Outbound } from "./inbound.js";
import { formatMxn, mexicoDayStart } from "./money.js";
import { isAllowed } from "./phone.js";
import {
  PeyError,
  type LinkInput,
  type LinkResult,
  type PeyPaymentLink,
  type PeyTransaction,
  type PeyTransactionPage,
  type PushInput,
  type PushResult,
  type QrInput,
  type QrResult,
} from "./pey.js";
import { Store, type Charge, type ChargeMethod, type TurnTool } from "./store.js";

export interface PeyPort {
  push(input: PushInput): Promise<PushResult>;
  qr(input: QrInput): Promise<QrResult>;
  link(input: LinkInput): Promise<LinkResult>;
  /** Consultas de estado: con ellas Zaldo se entera del pago aunque el webhook no llegue. */
  transaction?(id: string): Promise<PeyTransaction | null>;
  qrTransactions?(idc: string): Promise<PeyTransactionPage>;
  paymentLink?(id: string): Promise<PeyPaymentLink | null>;
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

export interface PaidNotice {
  chargeId: string;
  owner: string;
  text: string;
}

/** Como en la guía de pey: corrección de errores M y borde de 4 módulos. */
export async function renderQrPng(payload: string): Promise<Buffer> {
  return QRCode.toBuffer(payload, { errorCorrectionLevel: "M", width: 600, margin: 4 });
}

function newNumRef(used: Set<string>): string {
  for (let attempt = 0; attempt < 30; attempt++) {
    const ref = String(1_000_000 + randomInt(9_000_000));
    if (!used.has(ref)) return ref;
  }
  throw new Error("No quedó una referencia libre");
}

function remember(
  store: Store,
  owner: string,
  role: "user" | "assistant",
  content: string,
  now: number,
  tools: TurnTool[] = [],
): void {
  store.appendTurn(owner, { role, content, at: now, ...(tools.length ? { tools } : {}) });
}

/** CoDi muestra un concepto corto en la app del banco: se manda recortado, el libro guarda el completo. */
function peyConcept(concept: string): string {
  return concept.length <= 40 ? concept : `${concept.slice(0, 39).trimEnd()}…`;
}

function minutes(seconds: number): string {
  const total = Math.round(seconds / 60);
  if (total >= 60 && total % 60 === 0) return total === 60 ? "1 hora" : `${total / 60} horas`;
  return total === 1 ? "1 minuto" : `${total} minutos`;
}

/** Por qué no salió un cobro, en palabras de quien cobra y con qué hacer después. */
export function explainPeyError(error: unknown, method: ChargeMethod): string {
  if (!(error instanceof PeyError)) return "Algo falló de mi lado antes de llegar al banco. Inténtalo otra vez en un momento.";
  const type = error.type ?? "";
  if (type === "INVALID_STATE") {
    return "Este negocio todavía no tiene CoDi activo en pey: falta ligar la cuenta (CLABE) a la llave en el portal de pey, o que Banxico termine de activarla (hasta 5 días hábiles). En cuanto quede, ya se puede cobrar.";
  }
  if (type === "INVALID_AMOUNT") return "El banco no aceptó ese monto. Tiene que ser mayor a cero y de máximo $1,000,000.00.";
  if (type === "AUTH_ERROR" || type === "FORBIDDEN" || error.status === 401 || error.status === 403) {
    return "Mi llave de pey no está autorizada para cobrar. Hay que revisarla en el portal de pey.";
  }
  if (type === "NETWORK") return "pey no contestó a tiempo. Inténtalo otra vez en un minuto.";
  if (error.status >= 500 || type === "SERVICE_UNAVAILABLE" || type === "FLAGS_UNAVAILABLE") {
    return "pey o CoDi están fallando ahorita. Inténtalo otra vez en unos minutos.";
  }
  if (method === "push" && /phone/i.test(error.message)) {
    return "Ese celular no le sirvió a CoDi. Tienen que ser 10 dígitos de un número con CoDi activo en la app de su banco.";
  }
  return `pey rechazó el cobro: ${error.message}`;
}

function logPeyError(error: unknown, charge: Charge): void {
  if (error instanceof PeyError) {
    console.error(
      "pey",
      JSON.stringify({ method: charge.method, type: error.type, status: error.status, requestId: error.requestId, message: error.message }),
    );
  } else console.error("cobro", error instanceof Error ? error.message : error);
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
    return [{ kind: "text", to: owner, text: "Ese cobro caducó sin confirmarse. Pídemelo otra vez." }];
  }
  const used = deps.store.confirmedCentsSince(owner, mexicoDayStart(now));
  if (used + charge.amountCents > deps.config.dailyCapCents) {
    return [{ kind: "text", to: owner, text: "Ese monto ya pasa el tope de cobros de hoy." }];
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
  const amount = formatMxn(charge.amountCents);
  try {
    if (charge.method === "push") {
      if (!charge.payerPhone || !numRef) throw new Error("Falta el celular");
      const sent = await deps.pey.push({
        amountCents: charge.amountCents,
        phone: charge.payerPhone,
        concept: peyConcept(charge.concept),
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
      const wait = minutes(deps.config.pushExpirationSec);
      const text =
        charge.payerName === PAYER_SELF
          ? `Listo, ya salió. Te llega la notificación CoDi por ${amount} en la app de tu banco: ábrela y acéptala. Tienes ${wait}. Te aviso cuando caiga.`
          : `Listo, ya salió. A ${charge.payerName} le llega la notificación CoDi por ${amount} en la app de su banco (${prettyPhone(charge.payerPhone)}). Tiene ${wait} para aceptarla. Te aviso cuando caiga.`;
      remember(deps.store, owner, "assistant", text, now);
      return [{ kind: "text", to: owner, text }];
    }
    if (charge.method === "qr") {
      if (!numRef) throw new Error("Falta la referencia");
      const sent = await deps.pey.qr({
        amountCents: charge.amountCents,
        concept: peyConcept(charge.concept),
        numRef,
        chargeId: charge.id,
        expirationSec: deps.config.qrExpirationSec,
      });
      if (!sent.qrString) throw new Error("Pey no devolvió el QR");
      const png = await (deps.renderQr ?? renderQrPng)(sent.qrString);
      const current = deps.store.getCharge(charge.id) ?? locked;
      deps.store.updateCharge({ ...current, peyExternalId: sent.id || current.peyExternalId });
      const caption = `QR CoDi por ${amount} · ${charge.concept}. Se escanea desde la app del banco, en la opción CoDi. Vale ${minutes(deps.config.qrExpirationSec)}. Te aviso cuando caiga.`;
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
    const text = `Link para pagar ${amount} · ${charge.concept} (CoDi o tarjeta):\n${sent.url}\nTe aviso cuando caiga.`;
    remember(deps.store, owner, "assistant", text, now);
    return [{ kind: "text", to: owner, text }];
  } catch (error) {
    logPeyError(error, charge);
    const current = deps.store.getCharge(charge.id) ?? locked;
    if (current.status !== "paid") deps.store.updateCharge({ ...current, status: "failed" });
    const offer = charge.method === "push" ? " Si quieres, te lo paso en QR." : "";
    const text = `No salió el cobro de ${amount}. ${explainPeyError(error, charge.method)}${offer}`;
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
    const text = `Cancelé el cobro de ${formatMxn(charge.amountCents)}. No se envió nada.`;
    remember(deps.store, owner, "assistant", text, deps.now());
    return [{ kind: "text", to: owner, text }];
  }
  return confirm(deps, owner, charge.id);
}

const YES = /^(confirmar|confirma|confirmo|s[ií]|va|dale|ok)[.!]*$/i;
const NO = /^(cancelar|cancela|cancelo|no)[.!]*$/i;
const EXPLICIT = /^(confirmar|confirma|confirmo|cancelar|cancela|cancelo)[.!]*$/i;

/**
 * Donde no hay botones (WhatsApp por puente), la tarjeta se contesta con
 * CONFIRMAR o CANCELAR. Eso lo resuelve la caja, nunca el modelo: un
 * "cancelar" suelto no debe terminar borrando un apunte.
 */
async function onConfirmWord(deps: FlowDeps, owner: string, clean: string): Promise<Outbound[] | null> {
  const yes = YES.test(clean);
  if (!yes && !NO.test(clean)) return null;
  const waiting = deps.store
    .listCharges(owner)
    .reverse()
    .find((charge) => charge.status === "awaiting_confirm");
  if (waiting) return onButton(deps, owner, `${yes ? "c" : "x"}:${waiting.id}`);
  if (EXPLICIT.test(clean)) {
    return [{ kind: "text", to: owner, text: "No hay ningún cobro esperando confirmación. Dime qué cobro y lo armo." }];
  }
  return null;
}

async function onText(deps: FlowDeps, owner: string, text: string): Promise<Outbound[]> {
  const now = deps.now();
  const clean = text.trim();
  if (!clean) return [{ kind: "text", to: owner, text: "Dime qué vendiste o a quién le cobro y cuánto." }];
  const answered = await onConfirmWord(deps, owner, clean);
  if (answered) return answered;
  remember(deps.store, owner, "user", clean, now);
  const result = await runAgent({
    store: deps.store,
    config: deps.config,
    owner,
    now,
    complete: deps.complete,
  });
  if (result.charge) {
    const card = chargeCard(result.charge, !!deps.config.testMaxCents);
    remember(deps.store, owner, "assistant", card, now, result.tools);
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
  const reply = result.reply ?? "No te caché. Dime qué vendiste o a quién le cobro, cuánto y por qué.";
  remember(deps.store, owner, "assistant", reply, now, result.tools);
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
        : [{ kind: "text", to: inbound.owner, text: "No te entendí en la nota de voz. ¿Me lo escribes?" }];
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

function paidText(charge: Charge, settled: string): string {
  const amount = formatMxn(charge.amountCents);
  const from =
    charge.payerName === PAYER_SELF
      ? ", lo pagaste tú"
      : charge.payerName === PAYER_OPEN
        ? ""
        : ` de ${charge.payerName}`;
  return `Ya cayó: ${amount}${from} · ${charge.concept}. Confirmado por CoDi.${settled}`;
}

/**
 * Marca un cobro como pagado, una sola vez. Si quien pagó tenía una deuda
 * apuntada, se le abona. Devuelve el aviso para quien cobró.
 */
function markPaid(store: Store, charge: Charge, paidAt: number, now: number): PaidNotice {
  const paid: Charge = { ...charge, status: "paid", paidAt, paidNoticeSent: false };
  store.updateCharge(paid);
  let settled = "";
  if (paid.payerName !== PAYER_SELF && paid.payerName !== PAYER_OPEN) {
    const done = settleDebts(store, paid.owner, "deuda", paid.payerName, paid.amountCents);
    if (done.found && done.paidCents > 0) {
      settled =
        done.leftCents > 0
          ? ` Lo aboné a su fiado: le quedan ${formatMxn(done.leftCents)}.`
          : " Su fiado quedó saldado.";
    }
  }
  const goal = goalLine(store, paid.owner, now);
  const text = `${paidText(paid, settled)}${goal ? ` Meta del día: ${goal}.` : ""}`;
  remember(store, paid.owner, "assistant", text, now);
  return { chargeId: paid.id, owner: paid.owner, text };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** El chargeId que mandamos al crear el cobro: Pey lo devuelve en metadata.externalMetadata. */
function chargeIdOf(metadata: unknown): string {
  const meta = record(metadata);
  if (!meta) return "";
  const nested = record(meta.externalMetadata);
  const value = nested?.chargeId ?? meta.chargeId;
  return typeof value === "string" ? value : "";
}

export function applyPeyEvent(store: Store, body: Record<string, unknown>, now: number): PaidNotice | null {
  const type = String(body.type ?? "");
  let charge: Charge | null = null;
  const first = Array.isArray(body.transactions) ? record(body.transactions[0]) : null;
  if (type === "codi.qr.payment_received" || type === "codi.pn.payment_received") {
    const byMeta = chargeIdOf(body.metadata);
    const numRef = String(body.numRef ?? "");
    const txn = String(body.transactionId ?? "");
    const qrId = String(body.codiQrId ?? "");
    charge =
      (byMeta ? store.getCharge(byMeta) : null) ??
      store.findCharge(
        (item) =>
          (!!numRef && item.numRef === numRef) ||
          (!!txn && item.peyTransactionId === txn) ||
          (!!qrId && item.peyExternalId === qrId),
      ) ??
      null;
  } else if (type === "payment_link.status_updated") {
    if (body.status !== "paid") return null;
    const ref = String(body.clientReferenceId ?? "") || chargeIdOf(first?.metadata);
    const linkId = String(body.paymentLinkId ?? "");
    charge =
      store.findCharge((item) => (!!ref && item.id === ref) || (!!linkId && item.peyExternalId === linkId)) ?? null;
  } else {
    return null;
  }
  if (!charge || (charge.status === "paid" && charge.paidNoticeSent)) return null;
  if (charge.status !== "paid") {
    const datePaid =
      typeof body.datePaid === "number" ? body.datePaid : first && typeof first.datePaid === "number" ? first.datePaid : null;
    return markPaid(store, charge, datePaid === null ? now : datePaid * 1000, now);
  }
  return { chargeId: charge.id, owner: charge.owner, text: paidText(charge, "") };
}

/** Hasta cuándo vale la pena preguntarle a Pey por un cobro que ya venció aquí. */
const LATE_PAYMENT_MS = 10 * 60 * 1000;
/** Pasado este tiempo, un cobro abierto se consulta con menos frecuencia. */
const OLD_CHARGE_MS = 15 * 60 * 1000;

async function paidAtFromPey(pey: PeyPort, charge: Charge, now: number): Promise<number | null> {
  if (charge.method === "push") {
    if (!charge.peyTransactionId || !pey.transaction) return null;
    const tx = await pey.transaction(charge.peyTransactionId);
    return tx?.status === "PAID" ? (tx.datePaid ?? now) : null;
  }
  if (charge.method === "qr") {
    if (!charge.peyExternalId || !pey.qrTransactions) return null;
    const page = await pey.qrTransactions(charge.peyExternalId);
    const tx = page.items.find((item) => item.status === "PAID");
    return tx ? (tx.datePaid ?? now) : null;
  }
  if (!charge.peyExternalId || !pey.paymentLink) return null;
  const link = await pey.paymentLink(charge.peyExternalId);
  return link?.status === "paid" ? (link.datePaid ?? now) : null;
}

/**
 * Le pregunta a Pey por los cobros que siguen abiertos. Así el aviso de "ya
 * cayó" llega aunque el webhook no esté configurado o se pierda. Va antes de
 * takeExpired: un cobro pagado en el último segundo no se da por vencido.
 */
export async function reconcilePending(deps: FlowDeps, max = 10): Promise<PaidNotice[]> {
  const now = deps.now();
  // Un cobro reciente se consulta en cada vuelta; uno viejo (un QR de una hora), una de cada cinco.
  const slowTurn = Math.floor(now / 30_000) % 5 !== 0;
  const open = deps.store
    .listCharges()
    .filter(
      (charge) =>
        charge.status === "pending" ||
        (charge.status === "expired" && charge.expiresAt !== null && now - charge.expiresAt < LATE_PAYMENT_MS),
    )
    .filter((charge) => !(slowTurn && now - charge.createdAt > OLD_CHARGE_MS))
    .slice(-max);
  const notices: PaidNotice[] = [];
  for (const charge of open) {
    try {
      const paidAt = await paidAtFromPey(deps.pey, charge, now);
      if (paidAt === null) continue;
      const current = deps.store.getCharge(charge.id);
      // El webhook pudo llegar mientras preguntábamos.
      if (!current || current.status === "paid") continue;
      notices.push(markPaid(deps.store, current, paidAt, now));
    } catch (error) {
      console.error("pey estado", error instanceof Error ? error.message : error);
    }
  }
  return notices;
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
    const to =
      charge.payerName === PAYER_SELF ? "" : charge.payerName === PAYER_OPEN ? "" : ` a ${charge.payerName}`;
    const text = `El cobro de ${formatMxn(charge.amountCents)}${to} · ${charge.concept} venció sin pagarse. Dime "repítelo" y lo mando otra vez.`;
    remember(store, charge.owner, "assistant", text, now);
    return { owner: charge.owner, text };
  });
}
