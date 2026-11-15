import { randomInt, randomUUID } from "node:crypto";
import QRCode from "qrcode";
import {
  chargeCard,
  DEFAULT_CONCEPT,
  isNumberLabel,
  ownBank,
  PAYER_OPEN,
  PAYER_SELF,
  prettyPhone,
  runAgent,
  testCapFor,
  type AgentServices,
  type Completer,
} from "./agent.js";
import type { AccountPey } from "./cuenta.js";
import { frequencyLabel, goalLine, nextOccurrence, settleDebts, shortDate } from "./caja.js";
import type { AppConfig } from "./config.js";
import { VARIANTS } from "./botones.js";
import type { Inbound, Outbound } from "./inbound.js";
import { formatMxn, mexicoDayStart } from "./money.js";
import { isAllowed } from "./phone.js";
import { planKey } from "./recurrentes.js";
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
import { Store, type Charge, type ChargeMethod, type Recurring, type TurnTool } from "./store.js";

export interface PeyPort extends AccountPey {
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
  cardOf?: string,
): void {
  store.appendTurn(owner, { role, content, at: now, ...(tools.length ? { tools } : {}), ...(cardOf ? { cardOf } : {}) });
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
  const own = ownBank(deps.store, charge.owner);
  const input: PushInput = {
    amountCents: charge.amountCents,
    phone: charge.payerPhone,
    concept: peyConcept(charge.concept),
    numRef,
    chargeId: charge.id,
    expirationSec,
    // Con cuenta propia activa, el cobro cae directo en el banco de quien cobra.
    ...(own ? { bankAccountId: own.id } : {}),
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
    ...(own ? { bankAccountId: own.id } : {}),
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
    // Otro concepto u otra frecuencia para el mismo cliente es otro plan: no pisa al que ya tenía.
    .find(
      (plan) =>
        plan.active &&
        planKey(plan) === planKey({ payerPhone: charge.payerPhone ?? "", every: charge.repeat as Recurring["every"], concept: charge.concept }),
    );
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

/** Alguien confirmó una tarjeta que ya no está viva: se le dice qué pasó con ese cobro. */
function staleCardText(store: Store, charge: Charge): string {
  const which = charge.openAmount ? "Ese cobro" : `Ese cobro de ${formatMxn(charge.amountCents)}`;
  if (charge.status === "cancelled") {
    const newer = store
      .listCharges(charge.owner)
      .reverse()
      .find((item) => item.status === "awaiting_confirm");
    return newer
      ? `${which} ya lo había descartado y no se envió: lo reemplazó el de ${newer.openAmount ? "monto abierto" : formatMxn(newer.amountCents)}. Para mandar ese, confírmame la tarjeta nueva.`
      : `${which} ya estaba cancelado y no se envió. Si lo quieres, pídemelo otra vez.`;
  }
  if (charge.status === "pending") return `${which} ya salió: estoy esperando el pago. No lo mando dos veces.`;
  if (charge.status === "paid") return `${which} ya se pagó. No lo mando dos veces.`;
  if (charge.status === "expired") return `${which} ya venció sin pagarse. Dime "repítelo" y lo mando otra vez.`;
  return `${which} no salió la vez pasada. Pídemelo otra vez y lo intento.`;
}

async function confirm(deps: FlowDeps, owner: string, chargeId: string): Promise<Outbound[]> {
  const now = deps.now();
  const charge = deps.store.getCharge(chargeId);
  if (!charge || charge.owner !== owner) {
    return [{ kind: "text", to: owner, text: "Ese cobro no es de este chat." }];
  }
  if (charge.status !== "awaiting_confirm") {
    return [{ kind: "text", to: owner, text: staleCardText(deps.store, charge) }];
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
          : isNumberLabel(charge.payerName)
            ? `Listo, ya salió. Al ${charge.payerName} le llega la notificación CoDi por ${amount} en la app de su banco. Tiene ${wait} para aceptarla. Te aviso cuando caiga.${again}`
            : `Listo, ya salió. A ${charge.payerName} le llega la notificación CoDi por ${amount} en la app de su banco (${prettyPhone(charge.payerPhone ?? "")}). Tiene ${wait} para aceptarla. Te aviso cuando caiga.${again}`;
      remember(deps.store, owner, "assistant", text, now);
      return [{ kind: "text", to: owner, text }];
    }
    if (charge.method === "qr") {
      if (!numRef) throw new Error("Falta la referencia");
      const own = ownBank(deps.store, owner);
      const sent = await deps.pey.qr({
        amountCents: charge.amountCents,
        concept: peyConcept(charge.concept),
        numRef,
        chargeId: charge.id,
        expirationSec: qrSeconds,
        ...(own ? { bankAccountId: own.id } : {}),
      });
      if (!sent.qrString) throw new Error("Pey no devolvió el QR");
      const png = await (deps.renderQr ?? renderQrPng)(sent.qrString);
      const current = deps.store.getCharge(charge.id) ?? locked;
      deps.store.updateCharge({
        ...current,
        peyExternalId: sent.id || current.peyExternalId,
        ...(own ? { bankAccountId: own.id } : {}),
      });
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
    const what = charge.openAmount ? "el cobro" : `el cobro de ${formatMxn(charge.amountCents)}`;
    let text = `Cancelé ${what}. No se envió nada.`;
    if (charge.status === "awaiting_confirm") deps.store.updateCharge({ ...charge, status: "cancelled" });
    // Un cobro que ya salió no se retira desde aquí: decir "no se envió nada" sería mentira.
    else if (charge.status === "pending") {
      text = charge.reusable
        ? "Ese QR fijo ya está activo. Si ya no lo quieres usar, deja de enseñarlo: lo que no se paga no se cobra."
        : `Ese cobro ya salió y no lo puedo retirar. Si no lo pagan, vence solo y no se cobra nada.`;
    } else if (charge.status === "paid") {
      text = "Ese cobro ya se pagó: no se puede cancelar. Una devolución se hace con una transferencia desde tu banco.";
    } else if (charge.status === "cancelled") text = "Ese cobro ya estaba cancelado. No se envió nada.";
    else text = "Ese cobro ya no está activo: no hay nada que cancelar.";
    remember(deps.store, owner, "assistant", text, deps.now());
    return [{ kind: "text", to: owner, text }];
  }
  return confirm(deps, owner, charge.id);
}

const YES = /^(confirmar|confirma|confirmo|s[ií]|va|dale|ok)[.!]*$/i;
const NO = /^(cancelar|cancela|cancelo|no)[.!]*$/i;
const EXPLICIT = /^(confirmar|confirma|confirmo|cancelar|cancela|cancelo)[.!]*$/i;

/**
 * Con una tarjeta por confirmar, la gente no escribe "CONFIRMAR": escribe "sí,
 * mándalo", "órale" o "ya no, gracias". Aquí se manda dinero, así que la
 * lectura es estricta: el mensaje ENTERO tiene que ser de palabras de sí (o
 * de no) y muletillas. Una sola palabra de más ("si quieres", "ok, cancélalo",
 * "mándalo mañana", cualquier pregunta) y no se decide aquí.
 */
const YES_WORDS = new Set([
  "si", "sip", "sipi", "simon", "va", "vas", "dale", "ok", "okay", "okey", "oki", "sale", "claro", "correcto",
  "exacto", "adelante", "confirmar", "confirma", "confirmo", "confirmado", "confirmalo", "mandalo", "mandaselo",
  "mandala", "envialo", "enviaselo", "enviala", "hazlo", "cobralo", "cobraselo", "orale", "andale", "jalo", "arre",
  "perfecto", "yes", "yep", "yeah", "eso", "mero", "echale", "aceptar", "acepto", "afirmativo", "simona",
]);
/** Asentimientos flojos: junto a un "no" o un "cancela", gana el no ("ok, cancélalo", "claro que no"). */
const WEAK_YES = new Set(["ok", "okay", "okey", "oki", "sale", "claro", "va", "dale", "exacto", "correcto", "perfecto", "eso"]);
const NO_WORDS = new Set([
  "no", "nel", "nop", "nope", "nones", "cancelar", "cancela", "cancelo", "cancelalo", "cancelala", "cancelado",
  "cancelacion", "olvidalo", "dejalo", "tampoco", "negativo", "nah",
]);
const FILLER = new Set([
  "por", "favor", "porfa", "porfis", "plis", "please", "pues", "ya", "de", "una", "vez", "ahora", "mismo", "que",
  "lo", "la", "le", "el", "mejor", "siempre", "y", "bien", "esta", "asi", "es", "muy", "todo", "mandes", "envies",
  "quiero", "gracias",
]);
const YES_EMOJI = /[👍👌✅✔☑🆗]/u;
const NO_EMOJI = /[👎❌✖🚫⛔]/u;
/** Lo que cambia el sentido: una pregunta, un "después", una condición o un cambio al cobro. */
const NOT_NOW = /[?¿]|\d|\b(despu[eé]s|luego|ma[ñn]ana|al rato|m[aá]s tarde|ahorita no|todav[ií]a|espera|esp[eé]rame|aguanta|tantito|momento|pero|cambia|c[aá]mbialo|otro|otra)\b/i;

function plainWords(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

export function confirmIntent(clean: string): "yes" | "no" | null {
  if (YES.test(clean)) return "yes";
  if (NO.test(clean)) return "no";
  if (clean.length > 60 || NOT_NOW.test(clean)) return null;
  const words = plainWords(clean);
  const yesEmoji = YES_EMOJI.test(clean);
  const noEmoji = NO_EMOJI.test(clean);
  if (!words.length) return yesEmoji && !noEmoji ? "yes" : noEmoji && !yesEmoji ? "no" : null;
  // Una palabra que no es ni sí, ni no, ni muletilla: esto ya es otra plática.
  if (words.some((word) => !YES_WORDS.has(word) && !NO_WORDS.has(word) && !FILLER.has(word))) return null;
  const yes = words.filter((word) => YES_WORDS.has(word));
  const no = words.filter((word) => NO_WORDS.has(word));
  if (no.length || noEmoji) {
    // "ok, cancélalo" o "claro que no" es no. "no, sí mándalo" o "sí no" no se adivina.
    return yes.every((word) => WEAK_YES.has(word)) && !yesEmoji ? "no" : null;
  }
  // "ya" solo no confirma nada, y un "ok, gracias" es cortesía, no una orden de mandar dinero.
  if (words.includes("gracias")) return null;
  return yes.length || yesEmoji ? "yes" : null;
}

/**
 * "Espera", "aguanta tantito", "ahorita no", "al rato": la persona no dijo ni
 * sí ni no. La tarjeta se queda esperando. Igual de estricto que el sí: el
 * mensaje entero tiene que ser de espera ("espera, mejor por link" es un
 * cambio al cobro y lo ve el modelo).
 */
const WAIT_CORE = new Set([
  "espera", "esperame", "esperate", "espere", "esperen", "aguanta", "aguantame", "tantito", "momento", "momentito",
  "dejame", "deja", "chance", "permiteme", "segundo", "segundito", "seg", "luego", "despues", "rato", "ratito",
  "ahorita", "orita", "todavia", "aun",
]);
const WAIT_FILLER = new Set([
  "no", "al", "un", "ver", "veo", "checar", "checo", "pensar", "pienso", "dame", "te", "digo", "aviso", "le", "pregunto",
  "lo", "ay", "oye", "mas", "tarde", "tantito", "poquito", "poco",
]);

export function asksToWait(clean: string): boolean {
  if (clean.length > 50 || /[\d?¿]/.test(clean)) return false;
  const words = plainWords(clean);
  if (!words.length || !words.some((word) => WAIT_CORE.has(word))) return false;
  return words.every((word) => WAIT_CORE.has(word) || WAIT_FILLER.has(word) || FILLER.has(word));
}

/** Con cualquiera de estas, lo que dijo la persona no es un sí limpio, diga lo que diga el modelo. */
const NOT_A_YES = new Set([
  "no", "nel", "nop", "nope", "nones", "nah", "tampoco", "negativo", "nunca", "jamas", "nada", "cancela", "cancelar",
  "cancelo", "cancelalo", "cancelala", "cancelado", "cancelen", "cancelacion", "olvidalo", "dejalo", "dejala", "deja",
  "borra", "borralo", "quita", "quitalo", "detente", "espera", "esperame", "esperate", "espere", "aguanta",
  "aguantame", "tantito", "momento", "momentito", "luego", "despues", "manana", "rato", "ratito", "tarde", "todavia",
  "aun", "pero", "mejor", "cambia", "cambialo", "cambiale", "otro", "otra", "quieres", "gustas", "crees", "puedes",
  "puede", "pudieras", "sera", "seria", "deberia", "quiza", "quizas", "acaso", "duda", "seguro", "segura",
]);

/** Sin al menos una de estas, no hay sí: un nombre o un concepto ("Pepito", "uñas") no manda dinero. */
const AFFIRMS = new Set([
  "si", "sip", "sii", "siii", "simon", "va", "vas", "vale", "dale", "andale", "orale", "sale", "ok", "okay", "okey", "oki",
  "claro", "listo", "perfecto", "correcto", "exacto", "adelante", "confirmo", "confirma", "confirmar", "confirmado",
  "confirmalo", "manda", "mandalo", "mandala", "mandaselo", "mandamelo", "mandasela", "mande", "envia", "envialo",
  "enviaselo", "enviamelo", "envie", "hazlo", "llegue", "salga", "cobrale", "cobralo", "cobraselo", "cobramelo", "jalo",
  "arre", "acepto", "aceptar", "procede", "proceda", "acuerdo", "afirmativo", "venga", "juega", "sobres", "camara",
]);
const AFFIRM_PHRASE = /esta bien|asi esta|asi mero|de una|por favor mand|porfa mand/;

/**
 * El modelo dice que la persona aceptó la tarjeta con sus palabras ("ándale
 * pues, mándaselo"). Aquí se manda dinero, así que la caja lo revisa: nada de
 * preguntas, negaciones, esperas, condiciones ni cifras que no sean las del
 * cobro. Si algo de eso aparece, no se manda y se pide un sí claro.
 */
export function modelMayConfirm(text: string, charge: Pick<Charge, "amountCents" | "payerPhone">): boolean {
  if (!text.trim() || text.length > 160 || /[?¿]/.test(text) || NO_EMOJI.test(text)) return false;
  const words = plainWords(text);
  if (words.some((word) => NOT_A_YES.has(word))) return false;
  // Tiene que haber un sí: que no diga que no, no basta para mandar dinero.
  if (!words.some((word) => AFFIRMS.has(word)) && !AFFIRM_PHRASE.test(words.join(" "))) return false;
  for (const token of text.match(/\d[\d.,\s-]*\d|\d/g) ?? []) {
    const digits = token.replace(/\D/g, "");
    if (charge.payerPhone && digits.endsWith(charge.payerPhone)) continue;
    const pesos = Number(token.replace(/[,\s]/g, "").replace(/\.$/, ""));
    if (!Number.isFinite(pesos) || Math.round(pesos * 100) !== charge.amountCents) return false;
  }
  return true;
}

const NEEDS_CLEAR_YES = "Para mandarlo necesito un sí claro: escribe CONFIRMAR, o CANCELAR si ya no va.";
const NOTHING_WAITING = "No hay ningún cobro esperando confirmación. Dime qué cobro y lo armo.";

/**
 * Donde no hay botones (WhatsApp por puente), la tarjeta se contesta con
 * palabras. Eso lo resuelve la caja, nunca el modelo: un "cancelar" suelto no
 * debe terminar borrando un apunte, ni un "sí, mándalo" quedarse sin mandar.
 */
async function onConfirmWord(deps: FlowDeps, owner: string, clean: string): Promise<Outbound[] | null> {
  const waiting = deps.store
    .listCharges(owner)
    .reverse()
    .find((charge) => charge.status === "awaiting_confirm");
  if (waiting) {
    const intent = confirmIntent(clean);
    // Un "sí" o un "no" contesta lo último que dijo Zaldo. Si después de la tarjeta
    // hubo otra pregunta, ese "sí" no es para el cobro: solo CONFIRMAR / CANCELAR lo son.
    const cardIsLast = lastAssistant(deps.store, owner)?.cardOf === waiting.id;
    if (!intent) {
      const now = deps.now();
      if (!cardIsLast || now > waiting.confirmBy || !asksToWait(clean)) return null;
      // La tarjeta sigue viva, con su plazo completo otra vez: nadie pidió mandarla ni tirarla.
      const confirmBy = Math.max(waiting.confirmBy, now + deps.config.confirmWindowMs);
      deps.store.updateCharge({ ...waiting, confirmBy });
      const text = `Va, aquí lo dejo esperando. Cuando quieras: CONFIRMAR o CANCELAR. Te lo guardo ${minutes((confirmBy - now) / 1000)}.`;
      remember(deps.store, owner, "user", clean, now);
      remember(deps.store, owner, "assistant", text, now, [], waiting.id);
      return [{ kind: "text", to: owner, text }];
    }
    if (!cardIsLast && !EXPLICIT.test(clean)) return null;
    return onButton(deps, owner, `${intent === "yes" ? "c" : "x"}:${waiting.id}`);
  }
  if (EXPLICIT.test(clean)) {
    return [{ kind: "text", to: owner, text: NOTHING_WAITING }];
  }
  return null;
}

function lastAssistant(store: Store, owner: string) {
  return [...store.recentTurns(owner)].reverse().find((turn) => turn.role === "assistant");
}

function waitingCard(store: Store, owner: string): Charge | null {
  return (
    store
      .listCharges(owner)
      .reverse()
      .find((charge) => charge.status === "awaiting_confirm") ?? null
  );
}

const CORTE =
  /^(el |dame el |hazme el |mu[eé]strame el |p[aá]same el |mi |ver el )?corte( de caja)?( de| del)?( hoy| ayer| la semana| esta semana| semana| el mes| este mes| mes| el mes pasado| mes pasado)?[\s.!?¿]*$/i;
const HELP_WORD = /^[¿¡\s]*(ayuda|help|men[uú]|opciones|comandos|qu[eé] (puedes|sabes) hacer|c[oó]mo te uso|qu[eé] haces)[\s.!?]*$/i;

/**
 * Lo que no tiene dos lecturas se contesta sin el modelo: "corte" es el corte
 * de caja aunque haya un producto que se llame corte, y "ayuda" es la ayuda.
 * Devuelve la herramienta que lo resuelve, para que quede en la memoria como tal.
 */
function shortcut(clean: string): { name: string; args: Record<string, string> } | null {
  const corte = CORTE.exec(clean);
  if (corte) {
    const when = (corte[4] ?? "").trim().toLowerCase();
    const period = when.includes("pasado")
      ? "mes_pasado"
      : when.includes("ayer")
        ? "ayer"
        : when.includes("semana")
          ? "semana"
          : when.includes("mes")
            ? "mes"
            : "hoy";
    return { name: "get_balance", args: { period } };
  }
  return HELP_WORD.test(clean) ? { name: "show_help", args: {} } : null;
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
function servicesOf(deps: FlowDeps, owner: string): AgentServices {
  const { pey, config } = deps;
  // Los pagos y la cuenta que se consultan son los de la cuenta donde esa persona recibe.
  const accountId = ownBank(deps.store, owner)?.id ?? config.peyBankAccountId ?? null;
  const canList = !!(accountId && pey.transactionsByBankAccount) || !!pey.transactionsByApiKey;
  return {
    refresh: (owner) => refreshOwner(deps, owner),
    payments: canList ? () => ownerPayments(deps, owner) : undefined,
    account: accountId && pey.bankAccount ? () => pey.bankAccount!(accountId) : undefined,
  };
}

/** Páginas que se revisan en una cuenta compartida buscando los pagos de una persona, y cuántos bastan. */
const PAYMENT_PAGES = 4;
const PAYMENTS_WANTED = 8;

/**
 * Lo que pey registró para ESTA persona. En su propia cuenta, todo lo que cae
 * es suyo. En la cuenta compartida (pruebas, o una sola llave para todos) caen
 * los cobros de mucha gente: solo cuentan los que salieron de su libro. Nadie
 * ve los pagos de otro.
 */
async function ownerPayments(deps: FlowDeps, owner: string): Promise<PeyTransaction[]> {
  const { pey, config, store } = deps;
  const own = ownBank(store, owner);
  if (own && pey.transactionsByBankAccount) return (await pey.transactionsByBankAccount(own.id)).items;
  const shared = config.peyBankAccountId ?? null;
  const page = (token?: string): Promise<PeyTransactionPage> =>
    shared && pey.transactionsByBankAccount
      ? pey.transactionsByBankAccount(shared, token)
      : pey.transactionsByApiKey
        ? pey.transactionsByApiKey(token)
        : Promise.resolve({ items: [], nextToken: null });
  const charges = store.listCharges(owner);
  const ids = new Set(charges.map((charge) => charge.id));
  const transactions = new Set(charges.map((charge) => charge.peyTransactionId).filter(Boolean));
  // El id del QR o del link sí es de un solo cobro; el de una notificación no sirve para cruzar.
  const payables = new Set(
    charges.filter((charge) => charge.method !== "push").map((charge) => charge.peyExternalId).filter(Boolean),
  );
  const mine: PeyTransaction[] = [];
  let token: string | undefined;
  for (let turn = 0; turn < PAYMENT_PAGES; turn++) {
    const result = await page(token);
    for (const tx of result.items) {
      if ((tx.chargeId && ids.has(tx.chargeId)) || transactions.has(tx.id) || (tx.payableId && payables.has(tx.payableId))) {
        mine.push(tx);
      }
    }
    if (!result.nextToken || mine.length >= PAYMENTS_WANTED) break;
    token = result.nextToken;
  }
  return mine;
}

const REGISTER = "Registrar mi cuenta";
const KEEP_DEMO_LABEL = "Seguir en demo";
const KEEP_DEMO = /^seguir en (la |el )?(modo )?demo[\s.!]*$/i;

function choices(labels: string[]): { id: string; label: string }[] {
  return labels.map((label) => ({ id: `o:${label}`, label }));
}

/**
 * La bienvenida de quien llega: en cuanto dice su nombre se le explica, una
 * sola vez, que está en modo demo, y se le ofrecen dos caminos con botones:
 * registrar su cuenta para cobrar de verdad, o seguir probando.
 */
function demoWelcome(deps: FlowDeps, owner: string, nameBefore: string | null, now: number, tools: TurnTool[]): Outbound[] | null {
  const profile = deps.store.getProfile(owner);
  if (nameBefore || !profile.name || profile.onboarded) return null;
  deps.store.setProfile({ ...profile, onboarded: true });
  const cap = testCapFor(deps.store, deps.config, owner);
  // Quien ya recibe en su propio banco no está en demo: no hay nada que explicar.
  if (!cap) return null;
  const text = [
    `¡Mucho gusto, ${profile.name}!`,
    "",
    `Estás en *modo demo*: puedes probar todo, con cobros de hasta *${formatMxn(cap)}*. Ese dinero va a la cuenta de pruebas de pey, no a tu banco, y no se devuelve.`,
    "",
    "Para cobrar de verdad y recibir en tu banco, registra tu cuenta: toma un minuto.",
    "",
    "¿Cómo seguimos?",
  ].join("\n");
  remember(deps.store, owner, "assistant", text, now, tools);
  return [{ kind: "choice", to: owner, text, options: choices([REGISTER, KEEP_DEMO_LABEL]) }];
}

const WIPE = /^(borra|borrar|elimina|eliminar|reinicia|reiniciar|resetea|resetear) (mi cuenta|mis datos|todo|este chat)[\s.!]*$|^empezar de cero[\s.!]*$/i;
const WIPE_ASK =
  "¿Borro todo lo de este chat? Se van tu nombre, tu catálogo, tus clientes, tus apuntes y la conversación. Los cobros que ya salieron y la cuenta de banco que registraste se quedan.";
const WIPE_YES = "Sí, borrar todo";

/** Donde se guarda el formato de botones que ya se vio funcionar: no es una persona, es la configuración. */
export const BUTTON_CONFIG = "zaldo:botones";
/** Los formatos que se mandan en "probar botones". Ya se comprobó cuál se ve: solo va ese. */
const TRIAL_VARIANTS = VARIANTS.filter((variant) => variant === "A");

const TRY_BUTTONS = /^(probar|prueba de|prueba|activar?|quiero|pon|ponme|usa) (los )?botones[\s.!]*$/i;
const SEES_BUTTONS = "Sí veo los botones";
const NO_BUTTONS = /^(sin botones|no los veo|no veo( los)? botones|quitar? (los )?botones)[\s.!]*$/i;

/**
 * No todos los WhatsApp pintan los botones de respuesta rápida, y uno que no
 * los pinta no enseña nada. Por eso cada quien los prueba una vez: si los ve,
 * desde ahí sus preguntas y su tarjeta llevan botones; si no, opciones que
 * se ven en cualquier teléfono.
 */
function buttonTest(deps: FlowDeps, owner: string, clean: string, now: number): Outbound[] | null {
  const profile = deps.store.getProfile(owner);
  // "Borrar mi cuenta": se pregunta una vez, con botones, y solo entonces se borra.
  if (WIPE.test(clean)) {
    remember(deps.store, owner, "assistant", WIPE_ASK, now);
    return [{ kind: "choice", to: owner, text: WIPE_ASK, options: choices([WIPE_YES, "No, dejarlo así"]) }];
  }
  if (clean.replace(/[\s.!]+$/, "").toLowerCase() === WIPE_YES.toLowerCase()) {
    const turns = deps.store.recentTurns(owner);
    const asked = turns.length >= 2 && turns[turns.length - 2]?.role === "assistant" && turns[turns.length - 2]?.content === WIPE_ASK;
    if (asked) {
      deps.store.resetOwner(owner);
      return [{ kind: "text", to: owner, text: 'Listo: borré todo lo de este chat. Escríbeme "hola" y empezamos de cero.' }];
    }
  }
  if (TRY_BUTTONS.test(clean)) {
    // No todos los teléfonos pintan el mismo formato: van cuatro, y se queda el que la persona sí ve.
    const intro = 'Te mando una prueba de botones. Si la ves con botones, toca "Veo la A". Si no, escríbeme "sin botones".';
    remember(deps.store, owner, "assistant", intro, now);
    return [
      { kind: "text", to: owner, text: intro },
      ...TRIAL_VARIANTS.map((variant) => ({
        kind: "choice" as const,
        to: owner,
        text: `Prueba ${variant}`,
        style: "buttons" as const,
        variant,
        options: choices([`Veo la ${variant}`, "Esta no"]),
      })),
    ];
  }
  const seen = /^veo la ([abcd])[\s.!]*$/i.exec(clean);
  if (seen) {
    const variant = (seen[1] ?? "A").toUpperCase();
    deps.store.setProfile({ ...profile, choiceStyle: "buttons", choiceVariant: variant });
    // El formato que alguien ya vio funcionar es el que se intenta primero con los demás.
    deps.store.setProfile({ ...deps.store.getProfile(BUTTON_CONFIG), choiceVariant: variant });
    const text = `Listo: me quedo con los botones de la prueba ${variant}. Desde ahora tus preguntas y la tarjeta de cada cobro traen botones.`;
    remember(deps.store, owner, "assistant", text, now);
    return [{ kind: "text", to: owner, text }];
  }
  if (/^esta no[\s.!]*$/i.test(clean)) {
    const text = "Va. Toca el botón de la prueba que sí veas bien.";
    remember(deps.store, owner, "assistant", text, now);
    return [{ kind: "text", to: owner, text }];
  }
  const answer = clean.replace(/[\s.!]+$/, "").toLowerCase();
  if (answer === SEES_BUTTONS.toLowerCase() || answer === "si veo los botones") {
    deps.store.setProfile({ ...profile, choiceStyle: "buttons" });
    const text = "Listo: desde ahora te pregunto con botones, y la tarjeta de cada cobro trae Confirmar y Cancelar.";
    remember(deps.store, owner, "assistant", text, now);
    return [{ kind: "text", to: owner, text }];
  }
  // "Seguir en demo": el siguiente paso es probar un cobro de verdad, de un centavo.
  if (KEEP_DEMO.test(clean)) {
    const text =
      "Va, seguimos en *modo demo*.\n\nLo mejor para probar: un cobro de un centavo a tu propio celular. Te llega a la app de tu banco, lo aceptas y ves cómo te aviso cuando cae.";
    remember(deps.store, owner, "assistant", text, now);
    return [{ kind: "choice", to: owner, text, options: choices(["Cobrarme 1 centavo", "¿Qué puedes hacer?"]) }];
  }
  if (NO_BUTTONS.test(clean)) {
    deps.store.setProfile({ ...profile, choiceStyle: "text" });
    const text = "Va, sin botones: te escribo las opciones y me contestas con la que quieras.";
    remember(deps.store, owner, "assistant", text, now);
    return [{ kind: "text", to: owner, text }];
  }
  return null;
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
  // Cómo estaba la tarjeta ANTES de este mensaje: de eso depende si un "sí" del modelo vale.
  const waitingBefore = waitingCard(deps.store, owner);
  const cardWasLast = !!waitingBefore && lastAssistant(deps.store, owner)?.cardOf === waitingBefore.id;
  remember(deps.store, owner, "user", clean, now);
  const tested = buttonTest(deps, owner, clean, now);
  if (tested) return tested;
  const nameBefore = deps.store.getProfile(owner).name;
  const direct = shortcut(clean);
  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    result = await runAgent({
      store: deps.store,
      config: deps.config,
      owner,
      now,
      // Un atajo es la misma herramienta de siempre, pedida por la caja y no por el modelo.
      complete: direct
        ? async () => ({
            content: null,
            toolCalls: [{ id: "atajo", type: "function", function: { name: direct.name, arguments: JSON.stringify(direct.args) } }],
          })
        : deps.complete,
      services: servicesOf(deps, owner),
    });
  } catch (error) {
    // El modelo no contestó (red, saturación): la persona no se queda sin respuesta.
    console.error("agente", error instanceof Error ? error.message : error);
    const reply = "Se me fue la señal un momento. Mándamelo otra vez, porfa.";
    remember(deps.store, owner, "assistant", reply, now);
    return [{ kind: "text", to: owner, text: reply }];
  }
  // Acaba de decir cómo se llama: es el momento de explicarle dónde está parado.
  const welcome = !result.charge && !result.confirm ? demoWelcome(deps, owner, nameBefore, now, result.tools) : null;
  if (welcome) return welcome;
  const notice = result.notice?.trim();
  if (result.charge) {
    const card = chargeCard(result.charge, !!testCapFor(deps.store, deps.config, owner), now);
    // Si en el mismo mensaje pidió algo más (guardar un producto, el corte), eso va antes de la tarjeta.
    const before = result.reply?.trim();
    // Y antes que todo, lo que la caja tiene que avisar ("descarté el cobro que no habías confirmado").
    const parts = [notice, before, card].filter((part): part is string => !!part);
    remember(deps.store, owner, "assistant", parts.join("\n\n"), now, result.tools, result.charge.id);
    return [
      ...(notice ? [{ kind: "text" as const, to: owner, text: notice }] : []),
      ...(before ? [{ kind: "text" as const, to: owner, text: before }] : []),
      {
        kind: "buttons",
        to: owner,
        text: card,
        yesId: `c:${result.charge.id}`,
        noId: `x:${result.charge.id}`,
      },
    ];
  }
  if (result.confirm) {
    // El modelo entendió un sí (o un no) dicho con otras palabras. Él propone; la caja decide.
    const waiting = waitingBefore ? deps.store.getCharge(waitingBefore.id) : null;
    if (!waiting || waiting.status !== "awaiting_confirm") {
      remember(deps.store, owner, "assistant", NOTHING_WAITING, now);
      return [{ kind: "text", to: owner, text: NOTHING_WAITING }];
    }
    if (result.confirm === "no") return onButton(deps, owner, `x:${waiting.id}`);
    if (!cardWasLast || !modelMayConfirm(clean, waiting)) {
      // No se manda nada. La tarjeta sigue esperando, y el siguiente "sí" ya es para ella.
      remember(deps.store, owner, "assistant", NEEDS_CLEAR_YES, now, [], waiting.id);
      return [{ kind: "text", to: owner, text: NEEDS_CLEAR_YES }];
    }
    return onButton(deps, owner, `c:${waiting.id}`);
  }
  const said = result.reply ?? 'No te caché. Dime, por ejemplo: "cobra 150" o "cóbrale 200 a Ana".';
  const reply = notice && !said.includes(notice) ? `${notice}\n\n${said}` : said;
  remember(deps.store, owner, "assistant", reply, now, result.tools);
  // Una duda con respuestas contadas sale con botones: tocar uno es como escribirlo.
  if (result.options && result.options.length >= 2) {
    return [{ kind: "choice", to: owner, text: reply, options: result.options.map((label) => ({ id: `o:${label}`, label })) }];
  }
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
      // El botón de una pregunta ("o:Dame un QR") es su texto: sigue la conversación como si lo hubiera escrito.
      if (inbound.type === "button" && inbound.buttonId.startsWith("o:")) {
        messages = await onText(deps, inbound.owner, inbound.buttonId.slice(2));
      } else if (inbound.type === "button") {
        // El toque también es parte de la conversación: sin él, el hilo tiene un hueco.
        remember(deps.store, inbound.owner, "user", inbound.buttonId.startsWith("x:") ? "Cancelar" : "Confirmar", deps.now());
        messages = await onButton(deps, inbound.owner, inbound.buttonId);
      }
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
        : isNumberLabel(charge.payerName)
          ? ` del ${charge.payerName}`
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
  /** freshMs: solo los cobros que salieron hace menos de eso (la vuelta rápida, para avisar casi al instante). */
  options: { max?: number; owner?: string; freshMs?: number } = {},
): Promise<PaidNotice[]> {
  const now = deps.now();
  // Un cobro reciente se consulta en cada vuelta; uno viejo (un QR de una hora, un QR fijo), una de cada cinco.
  const slowTurn = !options.owner && !options.freshMs && Math.floor(now / 30_000) % 5 !== 0;
  const open = deps.store
    .listCharges(options.owner)
    .filter(
      (charge) =>
        charge.status === "pending" ||
        (charge.status === "expired" && charge.expiresAt !== null && now - charge.expiresAt < LATE_PAYMENT_MS),
    )
    .filter((charge) => !(slowTurn && now - charge.createdAt > OLD_CHARGE_MS))
    .filter((charge) => !options.freshMs || (charge.status === "pending" && now - charge.createdAt <= options.freshMs))
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
 * "¿Ya pagó?": consulta a pey en ese momento los cobros de esa persona.
 * Devuelve el aviso de cada pago que apareció (también los de cobros por los
 * que no preguntó) para que vayan en la respuesta misma. Quedan como avisados:
 * el reloj no los vuelve a mandar.
 */
async function refreshOwner(deps: FlowDeps, owner: string): Promise<string[]> {
  const texts: string[] = [];
  for (const notice of await reconcilePending(deps, { owner })) {
    const current = deps.store.getCharge(notice.chargeId);
    if (current) deps.store.updateCharge({ ...current, paidNoticeSent: true });
    texts.push(notice.text);
  }
  return texts;
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
/** Si pey no deja salir el cobro del periodo, se reintenta: primero pronto, luego con calma, y hasta aquí. */
const RETRY_AFTER_MS = [15 * 60_000, 3_600_000, RETRY_LATER_MS];
const MAX_SEND_FAILURES = 4;

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
    // La fecha en que tocaba este periodo, aunque se esté reintentando: de ahí se cuenta el siguiente.
    const due = plan.dueAt ?? plan.nextAt;
    const used = deps.store.confirmedCentsSince(plan.owner, mexicoDayStart(now));
    if (used + plan.amountCents > deps.config.dailyCapCents) {
      deps.store.upsertRecurring({ ...plan, nextAt: now + RETRY_LATER_MS, dueAt: due });
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
    let nextAt = nextOccurrence(due, plan.every);
    while (nextAt <= now) nextAt = nextOccurrence(nextAt, plan.every);
    const { dueAt: _dueAt, ...base } = plan;
    try {
      const sent = await sendPush(deps, charge, numRef, RECURRING_EXPIRATION_SEC);
      deps.store.upsertRecurring({ ...base, nextAt, lastChargeId: charge.id, missed, failures: 0 });
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
      // Que pey no lo deje salir no es culpa de quien paga: no cuenta como periodo sin pagar.
      // El periodo anterior ya se evaluó arriba (missed); sin lastChargeId no se vuelve a contar.
      const failures = (plan.failures ?? 0) + 1;
      if (failures >= MAX_SEND_FAILURES) {
        deps.store.upsertRecurring({ ...base, active: false, missed, failures, lastChargeId: null });
        tell(
          plan.owner,
          `Pausé el cobro recurrente de ${label}: no ha podido salir ${failures} veces seguidas. ${explainPeyError(error, "push")} Cuando quede, dime que lo retome.`,
        );
      } else {
        const wait = RETRY_AFTER_MS[Math.min(failures - 1, RETRY_AFTER_MS.length - 1)] ?? RETRY_LATER_MS;
        deps.store.upsertRecurring({ ...base, nextAt: now + wait, dueAt: due, missed, failures, lastChargeId: null });
        // Se avisa la primera vez; los reintentos van callados.
        if (failures === 1) {
          tell(plan.owner, `No salió el cobro recurrente de ${label}. ${explainPeyError(error, "push")} Lo vuelvo a intentar más tarde.`);
        }
      }
    }
  }
  return notices;
}
