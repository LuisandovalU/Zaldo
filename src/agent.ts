import { randomUUID } from "node:crypto";
import {
  CATEGORIES,
  corteText,
  debtsByPerson,
  goalLine,
  itemsText,
  normalizeCategory,
  normalizePeriod,
  openDebts,
  owed,
  settleDebts,
} from "./caja.js";
import type { AppConfig } from "./config.js";
import { formatMxn, mexicoDayStart, parsePesosToCents } from "./money.js";
import { toTenDigits } from "./phone.js";
import {
  fold,
  Store,
  type Charge,
  type ChargeItem,
  type ChargeMethod,
  type Note,
  type NoteKind,
  type TurnTool,
} from "./store.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export type Completer = (input: {
  messages: ChatMessage[];
  tools: readonly object[];
}) => Promise<{ content: string | null; toolCalls: ToolCall[] }>;

/** Así guarda el libro a quien paga cuando es la persona del chat, o cuando el cobro es abierto. */
export const PAYER_SELF = "ti";
export const PAYER_OPEN = "quien pague";

/** Cobros sin pagar que aguanta un mismo celular en 24 h antes de frenar (nada de cobros en masa). */
const MAX_UNPAID_PUSHES_PER_PHONE = 3;

const SYSTEM = `Eres Zaldo, el punto de venta que vive en WhatsApp. Trabajas para quien te escribe: alguien con un negocio (estética, tiendita, puesto, taller, freelance) que cobra con CoDi. Le armas el ticket, mandas el cobro, le avisas cuando cae y le llevas la caja.

CÓMO HABLAS
- Español de México, de tú, cálido y directo. De una a tres líneas. Suenas a un buen encargado de caja: rápido, claro y de confianza. Nunca a un banco ni a un call center.
- Texto plano de WhatsApp: sin markdown, sin asteriscos, sin viñetas. Máximo un emoji por mensaje, y solo si suma.
- Si sabes el nombre de la persona, úsalo de vez en cuando.
- Nunca escribas "¿en qué puedo ayudarte?", "¿algo más que necesites?", "estoy aquí para asistirte" ni cierres con preguntas genéricas. Si hace falta una pregunta, que sea concreta ("¿le cobro con QR o a su celular?").
- Si es la primera vez que te escribe: preséntate ("Soy Zaldo"), di en una línea qué haces y pregúntale cómo se llama y qué vende.
- En cuanto diga su nombre o el de su negocio, aunque sea en su primer mensaje, guárdalos con set_profile y set_business antes de contestar.
- Nunca inventes un precio ni un monto. Si no está en el catálogo y la persona no lo dijo, pregúntalo.
- Las preguntas sobre ti (qué eres, para qué sirves, qué sabes hacer, si es seguro) sí las contestas, con gusto y en dos o tres líneas.

LO QUE NO HACES
- No pagas, no transfieres, no prestas y no guardas dinero: tú COBRAS y llevas la caja. El dinero llega directo a la cuenta del negocio por CoDi. Si dicen "quiero pagar" o "hacer un pago", acláralo en una línea y ofrece lo que sí haces: generar el cobro CoDi para que lo pague desde la app de su banco.
- Solo hablas del negocio: ventas, cobros, catálogo, clientes, gastos y el corte. Si preguntan otra cosa (definiciones, tareas, recetas, noticias, programación), no la contestes: di en una línea, con humor ligero, que lo tuyo es la caja y regresa a lo que sí haces.
- Nunca pidas ni aceptes NIP, contraseñas, tokens, números de tarjeta ni CLABE. Para cobrar solo hace falta un celular de 10 dígitos. Si te los ofrecen, di que eso no se le da a nadie por chat, tampoco a ti.
- No eres un producto oficial de Banxico ni de pey: usas CoDi a través del API de pey. No recomiendas inversiones ni créditos.

VENDER Y COBRAR (prepare_charge)
- Si lo que venden está en el catálogo (míralo en el contexto), manda items con nombre y cantidad. El precio y el total los pone la caja: no mandes amount ni hagas la suma tú.
- Si no está en el catálogo o es un monto suelto ("cobra 150 de uñas"), manda amount y concept. Si falta uno de los dos, pregunta solo eso.
- Si piden un producto que no está en el catálogo y no dicen el precio, pregúntalo. Cuando te lo den, haz las dos cosas en el mismo mensaje: set_product para guardarlo y prepare_charge para cobrarlo.
- Cómo se cobra:
  · No dicen a quién, o el cliente está enfrente: method "qr". El cliente lo escanea desde el celular del negocio.
  · Dan el celular del cliente, o es un cliente guardado ("cóbrale a Ana"): notificación a su banco. payerName y, si lo dieron, payerPhone.
  · Solo si la persona dice "cóbrame", "a mí" o "quiero pagar": payerName "yo". Si no sabes su celular (ver contexto), pide solo su celular de 10 dígitos y pásalo en payerPhone. "Cobra 2 cortes" a secas es una venta a un cliente: QR, nunca "yo".
  · Piden link o pagar con tarjeta: method "link".
- prepare_charge no envía nada: sale una tarjeta que la persona confirma o cancela. No digas que ya se envió.
- Nunca digas que ya pagaron: eso solo lo confirma el banco, y tú avisas solo cuando cae. Para "¿ya pagó?" usa charge_status.
- Un solo cobro por mensaje, y solo a quien lo espera: no mandes cobros en masa ni a números que la persona no te dio.

CATÁLOGO Y CAJA
- "agrega corte a 150", "sube el gel a 250": set_product. "quita el gel": set_product con price 0. "qué vendo", "mis precios": list_products.
- Venta en efectivo ("me pagaron 200 en efectivo de un corte"): add_note ingreso.
- Gasto del negocio ("compré 300 de esmaltes", "pagué la renta"): add_note gasto, con la categoría que mejor quede.
- Fiado ("Ana me quedó a deber 300"): add_note deuda. "le debo 500 al proveedor": add_note debo.
- "ya me pagó Ana": settle_debt me_pagaron. "ya le pagué al proveedor": settle_debt pague.
- "corte", "cómo voy", "cuánto llevo vendido": get_balance con el periodo que pidan (hoy si no dicen).
- "mi meta de hoy es 2000" o el nombre del negocio: set_business.
- "me equivoqué, bórralo": undo_last. Solo si piden borrar un apunte; "cancelar" un cobro no borra nada.
- Varias cosas en un mensaje: una llamada por cada una. Usa la herramienta de inmediato con lo que te dieron; no pidas confirmación ni datos opcionales.
- Las cifras salen de las herramientas, nunca de tu memoria: no inventes números ni hagas cuentas tú.
- Nunca digas que apuntaste, guardaste, agregaste o borraste algo si no llamaste a la herramienta en este mensaje.

ASÍ SUENAS (ejemplos de tono)
Persona: hola
Zaldo: ¡Qué onda! ¿Armamos un cobro, apuntamos una venta o vemos el corte?
Persona: cómo estás?
Zaldo: Al cien y con la caja al día. ¿Qué movemos? Por ejemplo: "cobra 2 cortes" o "agrega tinte a 450".
Persona: quiero hacer un pago
Zaldo: Yo no muevo tu dinero: yo cobro. Si quieres pagar algo aquí, te mando el cobro CoDi y lo aceptas en la app de tu banco. ¿De cuánto y por qué concepto?
Persona: 150 de uñas (y no sabes su celular)
Zaldo: Va. ¿A qué celular te mando la notificación? Son 10 dígitos, el que usas en la app de tu banco.
Persona: qué es un perro?
Zaldo: De perros no sé, de cobrar sí 🐶. Mejor dime qué vendiste y te armo el cobro.
Persona: para qué fuiste creado?
Zaldo: Soy tu punto de venta en WhatsApp. Guardo tu catálogo, armo el ticket, cobro con CoDi por QR, notificación o link, te aviso cuando cae el pago y te doy el corte de caja. Sin terminal ni app extra.
Persona: cobra un tinte (y no está en el catálogo)
Zaldo: No tengo "tinte" en tu catálogo. ¿A cuánto lo cobro? Si quieres lo dejo guardado para la próxima.`;

const NOTE_KINDS: readonly NoteKind[] = ["gasto", "ingreso", "deuda", "debo"];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "prepare_charge",
      description:
        "Arma una venta y prepara su cobro CoDi. No lo envía: la persona lo confirma en la tarjeta. Con items del catálogo la caja pone precios y total; sin items hacen falta amount y concept.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            description: "Productos o servicios vendidos.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name"],
              properties: {
                name: { type: "string", description: "Nombre como está en el catálogo." },
                qty: { type: "number", description: "Cantidad. Por defecto 1." },
                price: {
                  type: "number",
                  description: "Precio unitario en pesos, solo si NO está en el catálogo y la persona lo dijo.",
                },
              },
            },
          },
          amount: { type: "number", description: "Monto en pesos, solo para un cobro suelto sin items." },
          concept: { type: "string", description: "Concepto que verá quien paga. Con items se arma solo." },
          payerName: {
            type: "string",
            description: 'Quién paga: el nombre del cliente, "yo" si paga la persona del chat, o vacío si no se sabe (QR).',
          },
          payerPhone: { type: "string", description: "Celular de 10 dígitos de quien paga, si lo dijo." },
          method: {
            type: "string",
            enum: ["push", "qr", "link"],
            description:
              "push: notificación al celular de quien paga. qr: código para escanear. link: liga de pago (CoDi o tarjeta).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repeat_charge",
      description: "Prepara otra vez el último cobro, o el último de un cliente. También pide confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          payerName: { type: "string", description: "Nombre, si hay que repetir el de ese cliente." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "charge_status",
      description: "Estado de los cobros CoDi: pendiente, pagado o vencido.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Nombre del cliente o concepto. Vacío lista los abiertos." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_product",
      description: "Agrega un producto o servicio al catálogo, o cambia su precio. Precio 0 lo quita.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name", "price"],
        properties: {
          name: { type: "string", description: "Nombre corto, en singular: corte, gel, uñas acrílicas." },
          price: { type: "number", description: "Precio en pesos. 0 lo quita del catálogo." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_products",
      description: "Muestra el catálogo con precios.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "save_contact",
      description: "Guarda un cliente con su celular de 10 dígitos para cobrarle después.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name", "phone"],
        properties: {
          name: { type: "string" },
          phone: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_profile",
      description: "Guarda el nombre de la persona del chat y/o su propio celular.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Cómo se llama la persona." },
          phone: { type: "string", description: "Su celular de 10 dígitos." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_business",
      description: "Guarda el nombre del negocio y/o la meta de venta diaria.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          business: { type: "string", description: "Nombre del negocio." },
          dailyGoal: { type: "number", description: "Meta de venta por día, en pesos. 0 la quita." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_note",
      description:
        "Apunta en la caja sin mover dinero. gasto: salida del negocio. ingreso: venta en efectivo u otra entrada. deuda: fiado, un cliente le debe. debo: el negocio le debe a alguien.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "amount", "concept"],
        properties: {
          kind: { type: "string", enum: NOTE_KINDS },
          amount: { type: "number", description: "Monto en pesos." },
          concept: { type: "string", description: "En qué fue, en pocas palabras." },
          category: { type: "string", enum: CATEGORIES, description: "Solo para gasto. Elige la que mejor quede." },
          who: { type: "string", description: "Para deuda o debo: la otra persona." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "settle_debt",
      description: "Registra que un fiado o una deuda se pagó fuera de CoDi, completa o en parte.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["who", "direction"],
        properties: {
          who: { type: "string", description: "La otra persona." },
          direction: {
            type: "string",
            enum: ["me_pagaron", "pague"],
            description: "me_pagaron: el cliente pagó su fiado. pague: el negocio pagó lo que debía.",
          },
          amount: { type: "number", description: "Monto del abono. Vacío salda todo." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_balance",
      description:
        "Corte de caja: ventas CoDi y en efectivo, ticket promedio, lo más vendido, gastos, lo que queda, meta del día, cobros por cobrar y fiado.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          period: { type: "string", enum: ["hoy", "semana", "mes", "mes_pasado"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "undo_last",
      description: "Borra el último apunte de la caja (gasto, venta en efectivo o fiado) si la persona se equivocó.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
] as const;

const STATUS_LABEL: Record<Charge["status"], string> = {
  awaiting_confirm: "esperando confirmación",
  pending: "pendiente",
  paid: "pagado",
  expired: "vencido",
  cancelled: "cancelado",
  failed: "falló",
};

const NOTE_LABEL: Record<NoteKind, string> = {
  gasto: "gasto",
  ingreso: "venta en efectivo",
  deuda: "fiado",
  debo: "deuda",
};

function argsOf(call: ToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function conceptOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text.length > 80) return null;
  return text;
}

function nameOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function isSelf(name: string): boolean {
  return /^(yo|m[ií]|a m[ií]|me|ti|yo mism[oa])$/i.test(name);
}

/** 5512345678 → 55 1234 5678, para leerlo de un vistazo en la tarjeta. */
export function prettyPhone(phone: string): string {
  return phone.length === 10 ? `${phone.slice(0, 2)} ${phone.slice(2, 6)} ${phone.slice(6)}` : phone;
}

/** El celular de quien escribe: el que guardó, o el de WhatsApp si lo trae. */
export function ownPhone(store: Store, owner: string): string | null {
  return store.getProfile(owner).phone ?? toTenDigits(owner);
}

const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function contextBlock(store: Store, owner: string, config: AppConfig, now: number): string {
  const profile = store.getProfile(owner);
  const phone = ownPhone(store, owner);
  const catalog = store
    .listProducts(owner)
    .map((product) => `${product.name} ${formatMxn(product.priceCents)}`)
    .join(", ");
  const contacts = store
    .listContacts(owner)
    .map((contact) => `${contact.name} ${contact.phone}`)
    .join(", ");
  const used = store.confirmedCentsSince(owner, mexicoDayStart(now));
  const left = Math.max(0, config.dailyCapCents - used);
  const local = new Date(now - 6 * 3_600_000);
  const date = `${WEEKDAYS[local.getUTCDay()]} ${local.toISOString().slice(0, 10)}`;
  const first = store.recentTurns(owner).length <= 1 && !profile.name;
  const fiado = debtsByPerson(openDebts(store, owner, "deuda"));
  const goal = goalLine(store, owner, now);
  return [
    "CONTEXTO",
    `Hoy: ${date} (hora de Ciudad de México).`,
    `Persona: ${profile.name ?? "no sé su nombre"}. Negocio: ${profile.business ?? "no sé cómo se llama"}.`,
    `Su celular: ${phone ?? "no lo sé; pídelo solo si quiere que le llegue un cobro a ella"}.`,
    first ? "Es la primera vez que te escribe." : "Ya se conocen: no te presentes otra vez.",
    `Catálogo: ${catalog || "vacío. Si cobra algo seguido, ofrece guardarlo con su precio"}.`,
    `Clientes guardados: ${contacts || "ninguno"}.`,
    `Tope de cobros de hoy: quedan ${formatMxn(left)}.`,
    goal ? `Meta del día: ${goal}.` : "",
    fiado ? `Fiado: ${fiado}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A quién le llega o quién paga, dicho claro para quien confirma. */
function payerLine(charge: Charge): string {
  if (charge.method === "qr") return "Lo paga: quien escanee el QR con la app de su banco";
  if (charge.method === "link") return "Lo paga: quien abra el link (CoDi o tarjeta)";
  const phone = charge.payerPhone ? prettyPhone(charge.payerPhone) : "";
  if (charge.payerName === PAYER_SELF) return `Le llega a: tu celular ${phone}, en la app de tu banco`;
  return `Le llega a: ${charge.payerName} · ${phone}, en la app de su banco`;
}

export function chargeCard(charge: Charge): string {
  const via =
    charge.method === "push" ? "notificación CoDi" : charge.method === "qr" ? "QR CoDi" : "link de pago";
  const detail = charge.items?.length
    ? charge.items.map((item) =>
        item.qty > 1
          ? `${item.qty} × ${item.name} · ${formatMxn(item.unitCents)} c/u`
          : `1 × ${item.name} · ${formatMxn(item.unitCents)}`,
      )
    : [`Concepto: ${charge.concept}`];
  return [`Cobro por ${formatMxn(charge.amountCents)}`, ...detail, payerLine(charge), `Por: ${via}`].join("\n");
}

/** Lo que una herramienta no pudo hacer. Va de regreso al modelo para que pregunte o lo explique. */
const FAILED = "ERROR: ";

function fail(message: string): string {
  return `${FAILED}${message}`;
}

/**
 * Herramientas cuyo resultado ya es el mensaje para la persona: las cifras
 * salen del libro tal cual, sin que el modelo las vuelva a escribir.
 */
const FINAL_TOOLS = new Set([
  "charge_status",
  "set_product",
  "list_products",
  "save_contact",
  "set_business",
  "add_note",
  "settle_debt",
  "get_balance",
  "undo_last",
]);

/** El modelo dice que apuntó, guardó o borró algo. Solo vale si de verdad llamó a la herramienta. */
const CLAIMS_ACTION =
  /\b(apuntad[oa]s?|apunt[ée]|anotad[oa]s?|anot[ée]|registrad[oa]s?|registr[ée]|agregad[oa]s?|agregu[ée]|guardad[oa]s?|guard[ée]|borrad[oa]s?|borr[ée]|quit[ée]|qued[óo] (apuntad|guardad|registrad|agregad|list)[oa])(?![a-záéíóúñ])/i;

const NOT_DONE =
  'No lo pude apuntar. Dímelo otra vez en una frase, por ejemplo: "gasté 300 en insumos" o "me pagaron 200 en efectivo".';

/** Montos dichos con letra ("ciento cincuenta pesos"): no se pueden cotejar, pero se nota que dijo uno. */
const AMOUNT_WORDS =
  /\b(veinte|veinti\w+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|\w*cientos|quinientos|mil|pesos?|centavos?)\b/i;

/**
 * ¿Ese monto lo dijo la persona, o sale de su libro? Un cobro nunca lleva una
 * cifra que el modelo se inventó: tiene que estar en sus últimos mensajes, ser
 * un fiado apuntado, o venir del catálogo (eso lo resuelve el ticket).
 */
export function knownAmount(store: Store, owner: string, cents: number): boolean {
  const texts = store
    .recentTurns(owner)
    .filter((turn) => turn.role === "user")
    .slice(-6)
    .map((turn) => turn.content);
  for (const text of texts) {
    for (const token of text.match(/\d[\d.,]*/g) ?? []) {
      if (parsePesosToCents(token.replace(/[.,]+$/, "")) === cents) return true;
    }
  }
  const fiado = openDebts(store, owner, "deuda");
  if (fiado.some((note) => owed(note) === cents)) return true;
  const perPerson = new Map<string, number>();
  for (const note of fiado) {
    const key = fold(note.who ?? note.concept);
    perPerson.set(key, (perPerson.get(key) ?? 0) + owed(note));
  }
  if ([...perPerson.values()].includes(cents)) return true;
  const last = texts[texts.length - 1] ?? "";
  return !/\d/.test(last) && AMOUNT_WORDS.test(last);
}

const SELF_WORDS =
  /(c[oó]brame|c[oó]bramelo|a m[ií]\b|quiero pagar|voy a pagar|me (lo |la )?cobras|yo pago|pago yo|hacer un pago|a mi (propio )?(celular|cel|n[uú]mero))/i;

/** ¿Quien escribe pidió que el cobro le llegue a él ("cóbrame", "quiero pagar")? */
function askedForSelf(store: Store, owner: string): boolean {
  return store
    .recentTurns(owner)
    .filter((turn) => turn.role === "user")
    .slice(-6)
    .some((turn) => SELF_WORDS.test(turn.content));
}

/** Los renglones del ticket con el precio del catálogo. */
function ticketOf(
  store: Store,
  owner: string,
  raw: unknown,
  verify: boolean,
): { items: ChargeItem[]; totalCents: number } | { error: string } | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  if (raw.length > 20) return { error: "son demasiados productos para un solo cobro." };
  const items: ChargeItem[] = [];
  for (const entry of raw) {
    const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const name = nameOf(row.name);
    if (!name) return { error: "falta el nombre de un producto." };
    const qty = row.qty === undefined || row.qty === null ? 1 : Number(row.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      return { error: `la cantidad de ${name} tiene que ser de 1 a 99.` };
    }
    const product = store.findProduct(owner, name);
    const typed = row.price === undefined || row.price === null ? null : parsePesosToCents(row.price);
    const unitCents = product?.priceCents ?? typed;
    if (!unitCents) {
      return { error: `"${name}" no está en el catálogo. Pregunta a cuánto lo cobra y ofrece guardarlo.` };
    }
    if (!product && verify && !knownAmount(store, owner, unitCents)) {
      return { error: `"${name}" no está en el catálogo y la persona no dijo su precio. No inventes precios: pregúntale a cuánto lo cobra.` };
    }
    const label = product?.name ?? name;
    const same = items.find((item) => fold(item.name) === fold(label));
    if (same) same.qty += qty;
    else items.push({ name: label, qty, unitCents });
  }
  return { items, totalCents: items.reduce((total, item) => total + item.qty * item.unitCents, 0) };
}

export function prepareCharge(
  store: Store,
  config: AppConfig,
  owner: string,
  now: number,
  raw: Record<string, unknown>,
  /** true cuando lo pide el modelo: sus montos se cotejan con lo que dijo la persona. */
  verify = false,
): { output: string; charge?: Charge } {
  const ticket = ticketOf(store, owner, raw.items, verify);
  if (ticket && "error" in ticket) return { output: fail(ticket.error) };
  const amount = ticket ? ticket.totalCents : parsePesosToCents(raw.amount);
  if (amount === null || amount > 100_000_000) {
    return { output: fail("el monto tiene que ser en pesos, mayor a cero y de máximo $1,000,000.00.") };
  }
  if (!ticket && verify && !knownAmount(store, owner, amount)) {
    return {
      output: fail(
        "la persona no dijo ese monto. No inventes montos ni precios: pregúntale de cuánto es el cobro. Si dijo un precio por pieza, manda items con qty y price.",
      ),
    };
  }
  let concept = conceptOf(raw.concept);
  if (!concept && ticket) {
    const text = itemsText(ticket.items);
    concept = text.length <= 80 ? text : `${ticket.items.reduce((n, item) => n + item.qty, 0)} productos`;
  }
  if (!concept) return { output: fail("falta el concepto, de hasta 80 caracteres.") };

  let name = nameOf(raw.payerName);
  if (name.length > 40) return { output: fail("el nombre es demasiado largo.") };
  let self = isSelf(name);
  // "cobra 2 cortes" es una venta a un cliente: sale QR. Al celular del dueño solo si él lo pidió.
  const demoted = self && verify && !askedForSelf(store, owner);
  if (demoted) {
    self = false;
    name = "";
  }
  const typedPhone =
    !demoted && typeof raw.payerPhone === "string" && raw.payerPhone.trim() ? raw.payerPhone : "";
  let phone = toTenDigits(typedPhone);
  if (typedPhone && !phone) return { output: fail("ese celular no tiene 10 dígitos. Pídelo otra vez.") };
  if (self && phone && !store.getProfile(owner).phone) {
    // Su propio celular se pregunta una sola vez.
    store.setProfile({ ...store.getProfile(owner), phone });
  }
  if (!phone && self) phone = ownPhone(store, owner);
  if (!phone && name && !self) phone = store.findContact(owner, name)?.phone ?? null;

  const asked = raw.method;
  let method: ChargeMethod;
  if (asked === "qr" || asked === "link" || (asked === "push" && !demoted)) method = asked;
  else method = phone || name ? "push" : "qr";

  if (method === "link" && !config.publicBaseUrl) {
    return { output: fail("el link de pago todavía no está disponible. Ofrece notificación CoDi o QR.") };
  }
  if (method === "push" && !phone) {
    if (self || !name) {
      return { output: fail("no sé el celular de la persona del chat. Pídeselo (10 dígitos) o ofrece un QR.") };
    }
    return { output: fail(`no tengo el celular de ${name}. Pídelo (10 dígitos) o ofrece un QR.`) };
  }
  if (method === "push") name = self || !name ? PAYER_SELF : name;
  else {
    name = self ? PAYER_SELF : name || PAYER_OPEN;
    phone = null;
  }

  const used = store.confirmedCentsSince(owner, mexicoDayStart(now));
  if (used + amount > config.dailyCapCents) {
    const left = Math.max(0, config.dailyCapCents - used);
    return { output: fail(`ese monto pasa el tope de cobros de hoy. Quedan ${formatMxn(left)}.`) };
  }
  if (method === "push" && phone) {
    const unpaid = store
      .listCharges(owner)
      .filter(
        (charge) =>
          charge.method === "push" &&
          charge.payerPhone === phone &&
          charge.createdAt >= now - 24 * 3_600_000 &&
          (charge.status === "pending" || charge.status === "expired"),
      ).length;
    if (unpaid >= MAX_UNPAID_PUSHES_PER_PHONE) {
      return {
        output: fail(
          `ese celular ya tiene ${unpaid} cobros sin pagar en las últimas 24 horas. No le mando otra notificación: ofrece un QR o esperar.`,
        ),
      };
    }
  }

  const charge: Charge = {
    id: randomUUID(),
    owner,
    payerName: name,
    payerPhone: phone,
    amountCents: amount,
    concept,
    method,
    status: "awaiting_confirm",
    numRef: null,
    peyTransactionId: null,
    peyExternalId: null,
    linkUrl: null,
    createdAt: now,
    confirmBy: now + config.confirmWindowMs,
    expiresAt: null,
    paidAt: null,
    expiryNotified: false,
    paidNoticeSent: false,
    ...(ticket ? { items: ticket.items } : {}),
  };
  store.insertCharge(charge);
  if (name !== PAYER_SELF && name !== PAYER_OPEN && phone) store.upsertContact({ owner, name, phone });
  return { output: "Cobro preparado. La tarjeta para confirmar ya sale en el chat. No digas que ya se envió.", charge };
}

function addNote(store: Store, owner: string, now: number, raw: Record<string, unknown>): string {
  const kind = raw.kind;
  if (typeof kind !== "string" || !(NOTE_KINDS as readonly string[]).includes(kind)) {
    return fail("el apunte es gasto, ingreso, deuda o debo.");
  }
  const amount = parsePesosToCents(raw.amount);
  const concept = conceptOf(raw.concept);
  if (amount === null || !concept) return fail("falta monto o concepto.");
  const who = nameOf(raw.who).slice(0, 40) || null;
  const note: Note = {
    id: randomUUID(),
    owner,
    kind: kind as NoteKind,
    amountCents: amount,
    concept,
    who,
    createdAt: now,
  };

  if (kind === "gasto") {
    const category = normalizeCategory(raw.category);
    store.insertNote({ ...note, category });
    return `Apuntado: gasto de ${formatMxn(amount)} · ${concept} (${category}).`;
  }
  if (kind === "ingreso") {
    store.insertNote(note);
    const goal = goalLine(store, owner, now);
    return `Apuntado: venta en efectivo de ${formatMxn(amount)} · ${concept}.${goal ? ` Meta del día: ${goal}.` : ""}`;
  }
  if (!who) return fail("falta el nombre de la otra persona.");
  store.insertNote({ ...note, paidCents: 0 });
  const total = openDebts(store, owner, kind as "deuda" | "debo")
    .filter((item) => fold(item.who ?? "") === fold(who))
    .reduce((sum, item) => sum + owed(item), 0);
  if (kind === "deuda") {
    return `Apuntado: ${who} te debe ${formatMxn(amount)} · ${concept}. En total te debe ${formatMxn(total)}. Dime "cóbrale a ${who}" y le mando el cobro CoDi.`;
  }
  return `Apuntado: le debes ${formatMxn(amount)} a ${who} · ${concept}. En total le debes ${formatMxn(total)}.`;
}

function execute(
  store: Store,
  config: AppConfig,
  owner: string,
  now: number,
  call: ToolCall,
  already: boolean,
): { output: string; charge?: Charge } {
  const raw = argsOf(call);
  if (call.function.name === "prepare_charge" || call.function.name === "repeat_charge") {
    if (already) return { output: fail("ya preparé un cobro en este mensaje.") };
  }
  switch (call.function.name) {
    case "prepare_charge":
      return prepareCharge(store, config, owner, now, raw, true);
    case "repeat_charge": {
      const name = fold(nameOf(raw.payerName));
      const previous = store
        .listCharges(owner)
        .filter((charge) => charge.status !== "cancelled" && charge.status !== "failed")
        .reverse()
        .find((charge) => !name || fold(charge.payerName) === name);
      if (!previous) return { output: fail(name ? "no tengo un cobro de ese cliente." : "todavía no hay cobros.") };
      return prepareCharge(store, config, owner, now, {
        ...(previous.items?.length
          ? { items: previous.items.map((item) => ({ name: item.name, qty: item.qty, price: item.unitCents / 100 })) }
          : { amount: (previous.amountCents / 100).toFixed(2) }),
        concept: previous.concept,
        payerName:
          previous.payerName === PAYER_SELF ? "yo" : previous.payerName === PAYER_OPEN ? "" : previous.payerName,
        payerPhone: previous.payerPhone ?? undefined,
        method: previous.method,
      });
    }
    case "charge_status": {
      const query = fold(nameOf(raw.query));
      const charges = store.listCharges(owner).filter((charge) => {
        if (!query) return charge.status === "pending" || charge.status === "awaiting_confirm" || charge.status === "expired";
        return fold(charge.payerName).includes(query) || fold(charge.concept).includes(query);
      });
      if (!charges.length) return { output: query ? "No tengo cobros con ese dato." : "No hay cobros abiertos." };
      return {
        output: charges
          .slice(-6)
          .map((charge) => {
            const who = charge.payerName === PAYER_OPEN ? "QR" : charge.payerName === PAYER_SELF ? "Tú" : charge.payerName;
            return `${who}: ${formatMxn(charge.amountCents)} · ${charge.concept} · ${STATUS_LABEL[charge.status]}`;
          })
          .join("\n"),
      };
    }
    case "set_product": {
      const name = nameOf(raw.name);
      if (!name || name.length > 40) return { output: fail("falta el nombre del producto, de hasta 40 caracteres.") };
      const zero = raw.price === 0 || raw.price === "0";
      const price = zero ? 0 : parsePesosToCents(raw.price);
      if (price === null) return { output: fail("falta el precio en pesos.") };
      if (price === 0) {
        const existing = store.findProduct(owner, name);
        if (!existing) return { output: fail(`"${name}" no está en el catálogo.`) };
        store.setProduct({ owner, name: existing.name, priceCents: 0 });
        return { output: `Quité ${existing.name} del catálogo.` };
      }
      const before = store.listProducts(owner).find((item) => fold(item.name) === fold(name));
      store.setProduct({ owner, name, priceCents: price });
      return {
        output: before
          ? `Precio nuevo: ${name} a ${formatMxn(price)} (antes ${formatMxn(before.priceCents)}).`
          : `En tu catálogo: ${name} a ${formatMxn(price)}.`,
      };
    }
    case "list_products": {
      const products = store.listProducts(owner);
      if (!products.length) {
        return { output: 'Tu catálogo está vacío. Dime, por ejemplo: "agrega corte a 150".' };
      }
      return {
        output: ["Tu catálogo", ...products.map((product) => `${product.name} · ${formatMxn(product.priceCents)}`)].join(
          "\n",
        ),
      };
    }
    case "save_contact": {
      const name = nameOf(raw.name);
      const phone = toTenDigits(typeof raw.phone === "string" ? raw.phone : "");
      if (!name || name.length > 40 || !phone) return { output: fail("necesito nombre y celular de 10 dígitos.") };
      store.upsertContact({ owner, name, phone });
      return { output: `Cliente guardado: ${name}, ${prettyPhone(phone)}.` };
    }
    case "set_profile": {
      const profile = store.getProfile(owner);
      const name = nameOf(raw.name).slice(0, 40);
      const typed = typeof raw.phone === "string" && raw.phone.trim() ? raw.phone : "";
      const phone = toTenDigits(typed);
      if (typed && !phone) return { output: fail("ese celular no tiene 10 dígitos.") };
      if (!name && !phone) return { output: fail("falta el nombre o el celular.") };
      store.setProfile({ ...profile, name: name || profile.name, phone: phone ?? profile.phone });
      const saved = [name ? `se llama ${name}` : "", phone ? `su celular es ${prettyPhone(phone)}` : ""]
        .filter(Boolean)
        .join(" y ");
      return { output: `Guardado: ${saved}.` };
    }
    case "set_business": {
      const profile = store.getProfile(owner);
      const business = nameOf(raw.business).slice(0, 40);
      const hasGoal = raw.dailyGoal !== undefined && raw.dailyGoal !== null && raw.dailyGoal !== "";
      const zero = raw.dailyGoal === 0 || raw.dailyGoal === "0";
      const goal = !hasGoal ? null : zero ? 0 : parsePesosToCents(raw.dailyGoal);
      if (hasGoal && goal === null) return { output: fail("la meta tiene que ser un monto en pesos.") };
      if (!business && !hasGoal) return { output: fail("falta el nombre del negocio o la meta.") };
      store.setProfile({
        ...profile,
        business: business || profile.business || null,
        dailyGoalCents: hasGoal ? goal : (profile.dailyGoalCents ?? null),
      });
      const parts: string[] = [];
      if (business) parts.push(`Tu negocio: ${business}.`);
      if (hasGoal) {
        const line = goalLine(store, owner, now);
        parts.push(line ? `Meta del día: ${line}.` : "Quité la meta del día.");
      }
      return { output: parts.join(" ") };
    }
    case "add_note":
      return { output: addNote(store, owner, now, raw) };
    case "settle_debt": {
      const who = nameOf(raw.who);
      const kind = raw.direction === "pague" ? "debo" : "deuda";
      const given = raw.amount !== undefined && raw.amount !== null && raw.amount !== "";
      const amount = given ? parsePesosToCents(raw.amount) : null;
      if (!who) return { output: fail("falta el nombre de la otra persona.") };
      if (given && amount === null) return { output: fail("el monto del abono no es válido.") };
      const done = settleDebts(store, owner, kind, who, amount);
      if (!done.found) return { output: fail(`no tengo una deuda abierta con ${who}.`) };
      const rest = done.leftCents > 0 ? `Quedan ${formatMxn(done.leftCents)}.` : "Quedó saldado.";
      return {
        output:
          kind === "deuda"
            ? `Listo: ${who} te pagó ${formatMxn(done.paidCents)}. ${rest}`
            : `Listo: le pagaste ${formatMxn(done.paidCents)} a ${who}. ${rest}`,
      };
    }
    case "get_balance": {
      const period = normalizePeriod(raw.period);
      return { output: corteText(store, owner, period, now) };
    }
    case "undo_last": {
      // El más reciente; con la misma hora gana el que se apuntó al final.
      const last = store.listNotes(owner).reduce<Note | null>(
        (latest, note) => (!latest || note.createdAt >= latest.createdAt ? note : latest),
        null,
      );
      if (!last) return { output: fail("no hay apuntes que borrar.") };
      store.removeNote(last.id);
      return { output: `Borré: ${NOTE_LABEL[last.kind]} de ${formatMxn(last.amountCents)} · ${last.concept}.` };
    }
    default:
      return { output: fail("herramienta desconocida.") };
  }
}

/**
 * La conversación como la ve el modelo. Los turnos donde usó herramientas se
 * reconstruyen como llamadas de verdad: si solo viera el texto final,
 * aprendería a escribir "Apuntado" sin llamar a nada.
 */
function history(store: Store, owner: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  store.recentTurns(owner).forEach((turn, index) => {
    if (turn.role === "user" || !turn.tools?.length) {
      messages.push({ role: turn.role, content: turn.content });
      return;
    }
    const calls: ToolCall[] = turn.tools.map((tool, position) => ({
      id: `h${index}_${position}`,
      type: "function",
      function: { name: tool.name, arguments: tool.args },
    }));
    messages.push({ role: "assistant", content: null, tool_calls: calls });
    turn.tools.forEach((tool, position) => {
      messages.push({ role: "tool", tool_call_id: `h${index}_${position}`, content: tool.output });
    });
    const shown = turn.tools.map((tool) => tool.output).join("\n");
    if (turn.content !== shown) messages.push({ role: "assistant", content: turn.content });
  });
  return messages;
}

export async function runAgent(input: {
  store: Store;
  config: AppConfig;
  owner: string;
  now: number;
  complete: Completer;
}): Promise<{ charge: Charge | null; reply: string | null; tools: TurnTool[] }> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${SYSTEM}\n\n${contextBlock(input.store, input.owner, input.config, input.now)}`,
    },
    ...history(input.store, input.owner),
  ];

  let charge: Charge | null = null;
  let nudged = false;
  const tools: TurnTool[] = [];
  for (let step = 0; step < 6; step++) {
    const result = await input.complete({ messages, tools: TOOLS });
    if (!result.toolCalls.length) {
      const reply = result.content?.trim() || null;
      // Dijo que lo apuntó sin haberlo hecho: se le pide que lo haga de verdad, una vez.
      if (reply && !tools.length && CLAIMS_ACTION.test(reply)) {
        if (nudged) return { charge, reply: NOT_DONE, tools };
        nudged = true;
        messages.push({ role: "assistant", content: reply });
        messages.push({
          role: "system",
          content:
            "Ese mensaje no se envió: dijiste que hiciste algo sin llamar a ninguna herramienta, así que nada quedó guardado. Llama ahora a la herramienta que corresponde con los datos del último mensaje de la persona. No le preguntes si quiere que lo apuntes: ya lo pidió. Si en realidad no pidió apuntar, guardar ni borrar nada, contesta sin decir que lo hiciste.",
        });
        continue;
      }
      return { charge, reply, tools };
    }
    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
    const outputs: string[] = [];
    let final = true;
    for (const call of result.toolCalls) {
      const done = execute(input.store, input.config, input.owner, input.now, call, charge !== null);
      if (done.charge) charge = done.charge;
      messages.push({ role: "tool", tool_call_id: call.id, content: done.output });
      tools.push({ name: call.function.name, args: call.function.arguments, output: done.output });
      outputs.push(done.output);
      if (!FINAL_TOOLS.has(call.function.name) || done.output.startsWith(FAILED)) final = false;
    }
    if (charge) return { charge, reply: null, tools };
    // Todo salió bien y el resultado ya es el mensaje: se manda tal cual, con sus cifras exactas.
    if (final) return { charge, reply: outputs.join("\n"), tools };
  }
  return { charge, reply: "Se me enredó el mensaje. Dímelo otra vez en una frase.", tools };
}
