import { randomInt, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import {
  chargeCard,
  DEFAULT_CONCEPT,
  PAYER_OPEN,
  PAYER_SELF,
  prettyPhone,
  runAgent,
  type AgentServices,
  type Completer,
} from "./agent.js";
import { frequencyLabel, goalLine, nextOccurrence, settleDebts, shortDate } from "./caja.js";
import type { AppConfig } from "./config.js";
import type { Inbound, Outbound } from "./inbound.js";
import { formatMxn, mexicoDayStart } from "./money.js";
import { isAllowed } from "./phone.js";
import {
  PeyError,
  type LinkInput,
  type LinkResult,
  type PeyBankAccount,
  type PeyPaymentLink,
  type PeyTransaction,
  type PeyTransactionPage,
  type PushInput,
  type PushResult,
  type QrInput,
  type QrResult,
} from "./pey.js";
import { Store, type Charge, type ChargeMethod, type Recurring, type TurnTool } from "./store.js";

export interface PeyPort {
  push(input: PushInput): Promise<PushResult>;
  qr(input: QrInput): Promise<QrResult>;
  link(input: LinkInput): Promise<LinkResult>;
  /** Consultas de estado: con ellas Zaldo se entera del pago aunque el webhook no llegue. */
  transaction?(id: string): Promise<PeyTransaction | null>;
  qrTransactions?(idc: string): Promise<PeyTransactionPage>;
  paymentLink?(id: string): Promise<PeyPaymentLink | null>;
  /** Lo que pey registró de verdad, para "mis últimos pagos". */
  transactionsByApiKey?(nextToken?: string): Promise<PeyTransactionPage>;
  transactionsByBankAccount?(bankAccountId: string, nextToken?: string): Promise<PeyTransactionPage>;
  bankAccount?(id: string): Promise<PeyBankAccount | null>;
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

/** " · uñas", o nada si el cobro no lleva concepto propio. */
function conceptTail(charge: { concept: string }): string {
  return charge.concept === DEFAULT_CONCEPT ? "" : ` · ${charge.concept}`;
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

/** Un día entero para aceptar un cobro que nadie está esperando frente al celular. */
const RECURRING_EXPIRATION_SEC = 24 * 3600;

/**
 * Manda la notificación CoDi de un cobro ya apartado en el libro. Si pey no
 * acepta un plazo largo, lo intenta con el mínimo que documenta (6 minutos).
 */
async function sendPush(
  deps: FlowDeps,
  charge: Charge,
  numRef: string,
  expirationSec: number,
): Promise<{ expirationSec: number }> {
  if (!charge.payerPhone) throw new Error("Falta el celular");
  const input: PushInput = {
    amountCents: charge.amountCents,
    phone: charge.payerPhone,
    concept: peyConcept(charge.concept),
    numRef,
    chargeId: charge.id,
    expirationSec,
  };
  let used = expirationSec;
  let sent: PushResult;
  try {
    sent = await deps.pey.push(input);
  } catch (error) {
    const tooLong = error instanceof PeyError && error.status === 400 && /expir/i.test(error.message);
    if (!tooLong || expirationSec <= deps.config.pushExpirationSec) throw error;
    used = deps.config.pushExpirationSec;
    sent = await deps.pey.push({ ...input, expirationSec: used });
  }
  const current = deps.store.getCharge(charge.id) ?? charge;
  deps.store.updateCharge({
    ...current,
    expiresAt: deps.now() + used * 1000,
    peyTransactionId: sent.transactionId || current.peyTransactionId,
    peyExternalId: sent.codiId || current.peyExternalId,
  });
  return { expirationSec: used };
}

/** Deja activo el cobro recurrente de un cobro que se confirmó con "cada mes". */
function startRecurring(store: Store, charge: Charge, now: number): Recurring | null {
  if (!charge.repeat || !charge.payerPhone) return null;
  const existing = store
    .listRecurrings(charge.owner)
    .find((plan) => plan.active && plan.payerPhone === charge.payerPhone && plan.every === charge.repeat);
  const plan: Recurring = {
    id: existing?.id ?? randomUUID(),
    owner: charge.owner,
    payerName: charge.payerName,
    payerPhone: charge.payerPhone,
    amountCents: charge.amountCents,
    concept: charge.concept,
    every: charge.repeat,
    nextAt: nextOccurrence(now, charge.repeat),
    active: true,
    createdAt: existing?.createdAt ?? now,
    lastChargeId: charge.id,
    missed: 0,
  };
  store.upsertRecurring(plan);
  return plan;
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
  // Un QR fijo no vence; lo demás sí, según su tipo.
  const qrSeconds = charge.reusable ? 0 : deps.config.qrExpirationSec;
  const expiresAt =
    charge.method === "push"
      ? now + deps.config.pushExpirationSec * 1000
      : charge.method === "qr" && !charge.reusable
        ? now + qrSeconds * 1000
        : null;
  const locked: Charge = { ...charge, status: "pending", numRef, expiresAt };
  deps.store.updateCharge(locked);
  const amount = formatMxn(charge.amountCents);
  const tail = conceptTail(charge);
  try {
    if (charge.method === "push") {
      if (!numRef) throw new Error("Falta la referencia");
      const sent = await sendPush(deps, locked, numRef, deps.config.pushExpirationSec);
      const wait = minutes(sent.expirationSec);
      const plan = startRecurring(deps.store, charge, now);
      const again = plan
        ? ` Queda como cobro recurrente: se lo mando solo ${frequencyLabel(plan.every)}; el siguiente, el ${shortDate(plan.nextAt)}. Para detenerlo dime "ya no le cobres a ${charge.payerName === PAYER_SELF ? "mí" : charge.payerName}".`
        : "";
      const text =
        charge.payerName === PAYER_SELF
          ? `Listo, ya salió. Te llega la notificación CoDi por ${amount} en la app de tu banco: ábrela y acéptala. Tienes ${wait}. Te aviso cuando caiga.${again}`
          : `Listo, ya salió. A ${charge.payerName} le llega la notificación CoDi por ${amount} en la app de su banco (${prettyPhone(charge.payerPhone ?? "")}). Tiene ${wait} para aceptarla. Te aviso cuando caiga.${again}`;
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
        expirationSec: qrSeconds,
      });
      if (!sent.qrString) throw new Error("Pey no devolvió el QR");
      const png = await (deps.renderQr ?? renderQrPng)(sent.qrString);
      const current = deps.store.getCharge(charge.id) ?? locked;
      deps.store.updateCharge({ ...current, peyExternalId: sent.id || current.peyExternalId });
      const what = charge.openAmount ? "de monto abierto" : `por ${amount}`;
      const how = charge.openAmount
        ? "Quien paga lo escanea desde la app de su banco, en la opción CoDi, y escribe el monto."
        : "Se escanea desde la app del banco, en la opción CoDi.";
      const caption = charge.reusable
        ? `QR CoDi fijo ${what}${tail}. ${how} No vence y sirve para muchos pagos: imprímelo o tenlo a la mano. Cada pago que caiga te lo aviso.`
        : `QR CoDi ${what}${tail}. ${how} Vale ${minutes(qrSeconds)}. Te aviso cuando caiga.`;
      remember(deps.store, owner, "assistant", caption, now);
      return [{ kind: "image", to: owner, png, caption }];
    }
    if (!deps.config.publicBaseUrl) throw new Error("Falta la URL pública");
    const sent = await deps.pey.link({
      amountCents: charge.amountCents,
      chargeId: charge.id,
      successUrl: `${deps.config.publicBaseUrl}/pago/listo`,
      backUrl: `${deps.config.publicBaseUrl}/pago/volver`,
      ...(charge.tip ? { hasTip: true } : {}),
    });
    const current = deps.store.getCharge(charge.id) ?? locked;
    deps.store.updateCharge({
      ...current,
      peyExternalId: sent.id || current.peyExternalId,
      linkUrl: sent.url,
    });
    const tipNote = charge.tip ? ", con opción de propina" : "";
    const text = `Link para pagar ${amount}${tail} (CoDi o tarjeta${tipNote}):\n${sent.url}\nTe aviso cuando caiga.`;
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
    const what = charge.openAmount ? "el cobro" : `el cobro de ${formatMxn(charge.amountCents)}`;
    const text = `Cancelé ${what}. No se envió nada.`;
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

/** Lo más largo que se le pasa al modelo de un solo mensaje. */
const MAX_TEXT = 1500;
/** Mensajes por minuto que una persona puede mandarle al modelo. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;
const recentByStore = new WeakMap<Store, Map<string, number[]>>();

/** true = va demasiado rápido. `first` dice si es la primera vez que se pasa, para avisarle una sola vez. */
function tooFast(store: Store, owner: string, now: number): { limited: boolean; first: boolean } {
  let byOwner = recentByStore.get(store);
  if (!byOwner) {
    byOwner = new Map();
    recentByStore.set(store, byOwner);
  }
  const recent = (byOwner.get(owner) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  recent.push(now);
  byOwner.set(owner, recent);
  return { limited: recent.length > RATE_LIMIT, first: recent.length === RATE_LIMIT + 1 };
}

/** Lo que el agente puede preguntarle a pey mientras conversa. */
function servicesOf(deps: FlowDeps): AgentServices {
  const { pey, config } = deps;
  const accountId = config.peyBankAccountId ?? null;
  return {
    refresh: (owner) => refreshOwner(deps, owner),
    payments:
      accountId && pey.transactionsByBankAccount
        ? async () => (await pey.transactionsByBankAccount!(accountId)).items
        : pey.transactionsByApiKey
          ? async () => (await pey.transactionsByApiKey!()).items
          : undefined,
    account: accountId && pey.bankAccount ? () => pey.bankAccount!(accountId) : undefined,
  };
}

async function onText(deps: FlowDeps, owner: string, text: string): Promise<Outbound[]> {
  const now = deps.now();
  const clean = text.trim().slice(0, MAX_TEXT);
  if (!clean) return [{ kind: "text", to: owner, text: "Dime cuánto cobro y a quién, o pídeme el corte." }];
  const answered = await onConfirmWord(deps, owner, clean);
  if (answered) return answered;
  const speed = tooFast(deps.store, owner, now);
  if (speed.limited) {
    return speed.first
      ? [{ kind: "text", to: owner, text: "Voy un poco saturado con tantos mensajes seguidos. Dame un minuto y seguimos." }]
      : [];
  }
  remember(deps.store, owner, "user", clean, now);
  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    result = await runAgent({
      store: deps.store,
      config: deps.config,
      owner,
      now,
      complete: deps.complete,
      services: servicesOf(deps),
    });
  } catch (error) {
    // El modelo no contestó (red, saturación): la persona no se queda sin respuesta.
    console.error("agente", error instanceof Error ? error.message : error);
    const reply = "Se me fue la señal un momento. Mándamelo otra vez, porfa.";
    remember(deps.store, owner, "assistant", reply, now);
    return [{ kind: "text", to: owner, text: reply }];
  }
  if (result.charge) {
    const card = chargeCard(result.charge, !!deps.config.testMaxCents, now);
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
  const reply = result.reply ?? 'No te caché. Dime, por ejemplo: "cobra 150" o "cóbrale 200 a Ana".';
  remember(deps.store, owner, "assistant", reply, now, result.tools);
  return [{ kind: "text", to: owner, text: reply }];
}

/** Una persona, un mensaje a la vez: dos seguidos no se pisan el libro ni la conversación. */
const queueByStore = new WeakMap<Store, Map<string, Promise<unknown>>>();

function inTurn<T>(store: Store, owner: string, task: () => Promise<T>): Promise<T> {
  let byOwner = queueByStore.get(store);
  if (!byOwner) {
    byOwner = new Map();
    queueByStore.set(store, byOwner);
  }
  const queue = byOwner;
  const run = (queue.get(owner) ?? Promise.resolve()).then(task, task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queue.set(owner, tail);
  void tail.then(() => {
    if (queue.get(owner) === tail) queue.delete(owner);
  });
  return run;
}

export async function handleInbound(
  deps: FlowDeps,
  inbound: Inbound,
): Promise<{ messages: Outbound[]; claimed: boolean }> {
  if (!isAllowed(inbound.owner, deps.config.allowedPhones)) return { messages: [], claimed: false };
  const key = `wa:${inbound.messageId}`;
  if (deps.store.claim(key) === "skip") return { messages: [], claimed: false };
  return inTurn(deps.store, inbound.owner, async () => {
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
  });
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
  const tip = charge.tipCents ? ` Más ${formatMxn(charge.tipCents)} de propina.` : "";
  return `Ya cayó: ${amount}${from}${conceptTail(charge)}. Confirmado por CoDi.${tip}${settled}`;
}

function withGoal(store: Store, owner: string, text: string, now: number): string {
  const goal = goalLine(store, owner, now);
  return goal ? `${text} Meta del día: ${goal}.` : text;
}

/**
 * Marca un cobro como pagado, una sola vez. Si quien pagó tenía un fiado
 * apuntado, se le abona. Devuelve el aviso para quien cobró.
 */
function markPaid(
  store: Store,
  charge: Charge,
  paidAt: number,
  now: number,
  got: { amountCents?: number; tipCents?: number } = {},
): PaidNotice {
  const paid: Charge = {
    ...charge,
    status: "paid",
    paidAt,
    paidNoticeSent: false,
    // En un QR de monto abierto, el monto lo puso quien pagó.
    ...(charge.openAmount && got.amountCents ? { amountCents: got.amountCents } : {}),
    ...(got.tipCents ? { tipCents: got.tipCents } : {}),
  };
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
  const text = withGoal(store, paid.owner, paidText(paid, settled), now);
  remember(store, paid.owner, "assistant", text, now);
  return { chargeId: paid.id, owner: paid.owner, text };
}

/** Pagos de un QR fijo que se recuerdan para no contar el mismo dos veces. */
const SEEN_KEPT = 300;

/**
 * Un pago más en un QR fijo: el QR sigue abierto y el pago queda como una
 * venta aparte. Si ese pago ya se había contado, no pasa nada.
 */
function recordFixedSale(
  store: Store,
  qr: Charge,
  payment: { id: string; amountCents: number; paidAt: number },
  now: number,
): PaidNotice | null {
  if (!payment.id || (qr.seenTransactions ?? []).includes(payment.id)) return null;
  const sale: Charge = {
    id: randomUUID(),
    owner: qr.owner,
    payerName: PAYER_OPEN,
    payerPhone: null,
    amountCents: payment.amountCents > 0 ? payment.amountCents : qr.amountCents,
    concept: qr.concept,
    method: "qr",
    status: "paid",
    numRef: null,
    peyTransactionId: payment.id,
    peyExternalId: qr.peyExternalId,
    linkUrl: null,
    createdAt: now,
    confirmBy: now,
    expiresAt: null,
    paidAt: payment.paidAt,
    expiryNotified: false,
    paidNoticeSent: false,
    parentId: qr.id,
    ...(qr.items ? { items: qr.items } : {}),
  };
  store.insertCharge(sale);
  store.updateCharge({ ...qr, seenTransactions: [...(qr.seenTransactions ?? []), payment.id].slice(-SEEN_KEPT) });
  const text = withGoal(
    store,
    qr.owner,
    `Ya cayó: ${formatMxn(sale.amountCents)} en tu QR fijo${conceptTail(sale)}. Confirmado por CoDi.`,
    now,
  );
  remember(store, qr.owner, "assistant", text, now);
  return { chargeId: sale.id, owner: qr.owner, text };
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

/** Pesos de pey (150.5) a centavos. 0 si no viene. */
function centsOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * 100) : 0;
}

export function applyPeyEvent(store: Store, body: Record<string, unknown>, now: number): PaidNotice | null {
  const type = String(body.type ?? "");
  let charge: Charge | null = null;
  const first = Array.isArray(body.transactions) ? record(body.transactions[0]) : null;
  const txn = String(body.transactionId ?? "");
  if (type === "codi.qr.payment_received" || type === "codi.pn.payment_received") {
    const byMeta = chargeIdOf(body.metadata);
    const numRef = String(body.numRef ?? "");
    const qrId = String(body.codiQrId ?? "");
    charge =
      (byMeta ? store.getCharge(byMeta) : null) ??
      store.findCharge(
        (item) =>
          !item.parentId &&
          ((!!numRef && item.numRef === numRef) ||
            (!!txn && item.peyTransactionId === txn) ||
            (!!qrId && item.peyExternalId === qrId)),
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
  if (!charge) return null;
  const datePaid =
    typeof body.datePaid === "number" ? body.datePaid : first && typeof first.datePaid === "number" ? first.datePaid : null;
  const paidAt = datePaid === null ? now : datePaid * 1000;
  if (charge.reusable) {
    return recordFixedSale(store, charge, { id: txn, amountCents: centsOf(body.amount), paidAt }, now);
  }
  if (charge.status === "paid") {
    return charge.paidNoticeSent ? null : { chargeId: charge.id, owner: charge.owner, text: paidText(charge, "") };
  }
  const breakdown = record(first?.amountBreakdown);
  return markPaid(store, charge, paidAt, now, {
    amountCents: centsOf(body.amount),
    tipCents: centsOf(breakdown?.tip),
  });
}

/** Hasta cuándo vale la pena preguntarle a Pey por un cobro que ya venció aquí. */
const LATE_PAYMENT_MS = 10 * 60 * 1000;
/** Pasado este tiempo, un cobro abierto se consulta con menos frecuencia. */
const OLD_CHARGE_MS = 15 * 60 * 1000;

interface PeyPayment {
  id: string;
  amountCents: number;
  tipCents: number;
  paidAt: number;
}

/** Los pagos que pey tiene de un cobro. Un QR fijo puede traer varios. */
async function paymentsFromPey(pey: PeyPort, charge: Charge, now: number): Promise<PeyPayment[]> {
  if (charge.method === "push") {
    if (!charge.peyTransactionId || !pey.transaction) return [];
    const tx = await pey.transaction(charge.peyTransactionId);
    return tx?.status === "PAID"
      ? [{ id: tx.id, amountCents: tx.amountCents, tipCents: 0, paidAt: tx.datePaid ?? now }]
      : [];
  }
  if (charge.method === "qr") {
    if (!charge.peyExternalId || !pey.qrTransactions) return [];
    const page = await pey.qrTransactions(charge.peyExternalId);
    return page.items
      .filter((item) => item.status === "PAID")
      .map((item) => ({ id: item.id, amountCents: item.amountCents, tipCents: 0, paidAt: item.datePaid ?? now }));
  }
  if (!charge.peyExternalId || !pey.paymentLink) return [];
  const link = await pey.paymentLink(charge.peyExternalId);
  return link?.status === "paid"
    ? [{ id: link.id, amountCents: 0, tipCents: link.tipCents, paidAt: link.datePaid ?? now }]
    : [];
}

/**
 * Le pregunta a Pey por los cobros que siguen abiertos. Así el aviso de "ya
 * cayó" llega aunque el webhook no esté configurado o se pierda. Va antes de
 * takeExpired: un cobro pagado en el último segundo no se da por vencido.
 * Con `owner` revisa solo los de esa persona, ya (para "¿ya pagó?").
 */
export async function reconcilePending(
  deps: FlowDeps,
  options: { max?: number; owner?: string } = {},
): Promise<PaidNotice[]> {
  const now = deps.now();
  // Un cobro reciente se consulta en cada vuelta; uno viejo (un QR de una hora, un QR fijo), una de cada cinco.
  const slowTurn = !options.owner && Math.floor(now / 30_000) % 5 !== 0;
  const open = deps.store
    .listCharges(options.owner)
    .filter(
      (charge) =>
        charge.status === "pending" ||
        (charge.status === "expired" && charge.expiresAt !== null && now - charge.expiresAt < LATE_PAYMENT_MS),
    )
    .filter((charge) => !(slowTurn && now - charge.createdAt > OLD_CHARGE_MS))
    .slice(-(options.max ?? 10));
  const notices: PaidNotice[] = [];
  for (const charge of open) {
    try {
      const payments = await paymentsFromPey(deps.pey, charge, now);
      if (!payments.length) continue;
      const current = deps.store.getCharge(charge.id);
      if (!current) continue;
      if (current.reusable) {
        // Del más viejo al más nuevo, y releyendo el QR: cada venta le apunta su pago.
        for (const payment of [...payments].reverse()) {
          const qr = deps.store.getCharge(charge.id);
          const notice = qr ? recordFixedSale(deps.store, qr, payment, now) : null;
          if (notice) notices.push(notice);
        }
        continue;
      }
      // El webhook pudo llegar mientras preguntábamos.
      if (current.status === "paid") continue;
      const payment = payments[0];
      if (!payment) continue;
      notices.push(markPaid(deps.store, current, payment.paidAt, now, payment));
    } catch (error) {
      console.error("pey estado", error instanceof Error ? error.message : error);
    }
  }
  return notices;
}

/**
 * "¿Ya pagó?": consulta a pey en ese momento los cobros de esa persona. Lo que
 * resulte pagado se da por avisado, porque se lo va a decir la respuesta misma.
 */
async function refreshOwner(deps: FlowDeps, owner: string): Promise<void> {
  for (const notice of await reconcilePending(deps, { owner })) {
    const current = deps.store.getCharge(notice.chargeId);
    if (current) deps.store.updateCharge({ ...current, paidNoticeSent: true });
  }
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
    const what = charge.openAmount ? "El cobro de monto abierto" : `El cobro de ${formatMxn(charge.amountCents)}`;
    const text = `${what}${to}${conceptTail(charge)} venció sin pagarse. Dime "repítelo" y lo mando otra vez.`;
    remember(store, charge.owner, "assistant", text, now);
    return { owner: charge.owner, text };
  });
}

/** Cobros recurrentes seguidos sin pagar antes de pausarlo solo: nadie recibe cobros que ya no quiere. */
const MAX_MISSED = 3;
const RETRY_LATER_MS = 6 * 3_600_000;

/**
 * Manda los cobros recurrentes que ya tocan. Cada uno se confirmó una vez al
 * crearlo; aquí salen solos y se le avisa a quien cobra. Va en el reloj.
 */
export async function runRecurring(deps: FlowDeps): Promise<{ owner: string; text: string }[]> {
  const now = deps.now();
  const notices: { owner: string; text: string }[] = [];
  const tell = (owner: string, text: string) => {
    remember(deps.store, owner, "assistant", text, now);
    notices.push({ owner, text });
  };
  for (const plan of deps.store.listRecurrings().filter((item) => item.active && item.nextAt <= now)) {
    const amount = formatMxn(plan.amountCents);
    const label = `${plan.payerName} (${amount} ${frequencyLabel(plan.every)})`;
    const last = plan.lastChargeId ? deps.store.getCharge(plan.lastChargeId) : null;
    const missed = last && last.status !== "paid" ? plan.missed + 1 : 0;
    if (missed >= MAX_MISSED) {
      deps.store.upsertRecurring({ ...plan, active: false, missed });
      tell(plan.owner, `Pausé el cobro recurrente de ${label}: lleva ${missed} seguidos sin pagar. Si quieres retomarlo, dímelo.`);
      continue;
    }
    const used = deps.store.confirmedCentsSince(plan.owner, mexicoDayStart(now));
    if (used + plan.amountCents > deps.config.dailyCapCents) {
      deps.store.upsertRecurring({ ...plan, nextAt: now + RETRY_LATER_MS });
      tell(plan.owner, `No mandé el cobro recurrente de ${label}: pasa el tope de cobros de hoy. Lo intento más tarde.`);
      continue;
    }
    const numRef = newNumRef(deps.store.usedNumRefs());
    const charge: Charge = {
      id: randomUUID(),
      owner: plan.owner,
      payerName: plan.payerName,
      payerPhone: plan.payerPhone,
      amountCents: plan.amountCents,
      concept: plan.concept,
      method: "push",
      status: "pending",
      numRef,
      peyTransactionId: null,
      peyExternalId: null,
      linkUrl: null,
      createdAt: now,
      confirmBy: now,
      expiresAt: now + RECURRING_EXPIRATION_SEC * 1000,
      paidAt: null,
      expiryNotified: false,
      paidNoticeSent: false,
      recurringId: plan.id,
    };
    deps.store.insertCharge(charge);
    // El siguiente cae en su fecha de siempre, aunque este haya salido tarde.
    let nextAt = nextOccurrence(plan.nextAt, plan.every);
    while (nextAt <= now) nextAt = nextOccurrence(nextAt, plan.every);
    try {
      const sent = await sendPush(deps, charge, numRef, RECURRING_EXPIRATION_SEC);
      deps.store.upsertRecurring({ ...plan, nextAt, lastChargeId: charge.id, missed });
      const who = plan.payerName === PAYER_SELF ? "Te mandé" : `Le mandé a ${plan.payerName}`;
      const whose = plan.payerName === PAYER_SELF ? "tu" : "su";
      tell(
        plan.owner,
        `Cobro recurrente: ${who} ${whose} cobro ${plan.every} de ${amount}${conceptTail(plan)}. Tiene ${minutes(sent.expirationSec)} para aceptarlo en la app de ${whose} banco. Te aviso cuando caiga. El siguiente, el ${shortDate(nextAt)}.`,
      );
    } catch (error) {
      logPeyError(error, charge);
      const current = deps.store.getCharge(charge.id) ?? charge;
      deps.store.updateCharge({ ...current, status: "failed" });
      const failures = plan.missed + 1;
      if (failures >= MAX_MISSED) {
        deps.store.upsertRecurring({ ...plan, active: false, missed: failures });
        tell(plan.owner, `Pausé el cobro recurrente de ${label}: no ha podido salir ${failures} veces. ${explainPeyError(error, "push")}`);
      } else {
        deps.store.upsertRecurring({ ...plan, nextAt: now + RETRY_LATER_MS, missed: failures, lastChargeId: null });
        tell(plan.owner, `No salió el cobro recurrente de ${label}. ${explainPeyError(error, "push")} Lo vuelvo a intentar más tarde.`);
      }
    }
  }
  return notices;
}
