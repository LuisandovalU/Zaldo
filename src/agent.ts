import { randomUUID } from "node:crypto";
import {
  CATEGORIES,
  corteText,
  debtsByPerson,
  goalLine,
  itemsText,
  frequencyLabel,
  nextOccurrence,
  normalizeCategory,
  plural,
  normalizeFrequency,
  normalizePeriod,
  openDebts,
  owed,
  settleDebts,
  shortDate,
  shortDateTime,
} from "./caja.js";
import type { AppConfig } from "./config.js";
import { accountLink } from "./cuenta.js";
import { formatMxn, mexicoDayStart, parsePesosToCents } from "./money.js";
import {
  asksDaily,
  cleanConcept,
  hypothetical,
  mentionsTip,
  plusPair,
  saidOwnName,
  saidPhone,
  saysPayment,
  spokenConcept,
  spokenPayer,
  wantsCatalogChange,
  wantsDelete,
  wantsMemory,
} from "./dicho.js";
import { derivable, eitherOr, foreignCurrency, saidAmount, soleMoney } from "./montos.js";
import { addNote as addMemory, cleanNote, countNotes, dropNotes, grounded, memoryOf, sectionOf } from "./memoria.js";
import { SYSTEM } from "./prompt.js";
import { cancelRecurrings, recurringLines, resumeRecurring, updateRecurring } from "./recurrentes.js";
import { chargeViolation, looksLikeInstruction, looksSensitive, plausiblePhone } from "./reglas.js";
import type { PeyBankAccount, PeyTransaction } from "./pey.js";
import { toTenDigits } from "./phone.js";
import {
  fold,
  Store,
  type BankLink,
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

/** La cuenta propia de esa persona, si ya está activa: ahí caen sus cobros. */
export function ownBank(store: Store, owner: string): BankLink | null {
  const bank = store.getProfile(owner).bank;
  return bank && bank.status === "ACTIVE" ? bank : null;
}

/**
 * El tope del modo de prueba para esa persona. Solo aplica mientras sus cobros
 * van a la cuenta de pruebas de pey; con su propia cuenta activa cobra lo que quiera.
 */
export function testCapFor(store: Store, config: AppConfig, owner: string): number | null {
  return ownBank(store, owner) ? null : (config.testMaxCents ?? null);
}

/** Cobros sin pagar que aguanta un mismo celular en 24 h antes de frenar (nada de cobros en masa). */
const MAX_UNPAID_PUSHES_PER_PHONE = 3;

const NOTE_KINDS: readonly NoteKind[] = ["gasto", "ingreso", "deuda", "debo"];

const TOOLS = [
  {
    type: "function",
    function: {
      name: "prepare_charge",
      description:
        "Prepara un cobro CoDi. No lo envía: la persona lo confirma en la tarjeta. Basta el monto (amount); el concepto es opcional. Con items del catálogo la caja pone precios y total.",
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
          amount: { type: "number", description: "Monto en pesos, para un cobro sin items." },
          concept: { type: "string", description: "Concepto que verá quien paga. Opcional: solo si lo dijeron." },
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
          tip: { type: "boolean", description: "Solo con link: deja que quien paga agregue propina." },
          fixed: {
            type: "boolean",
            description: "QR fijo para el mostrador: no vence y recibe muchos pagos, cada uno cae como venta.",
          },
          openAmount: {
            type: "boolean",
            description: "QR sin monto: quien paga escribe la cantidad en la app de su banco. No mandes amount.",
          },
          every: {
            type: "string",
            enum: ["semanal", "quincenal", "mensual"],
            description:
              "Cobro recurrente: tras confirmarlo, se le manda solo al mismo cliente cada semana, quincena o mes. Necesita el celular del cliente.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repeat_charge",
      description:
        "Prepara otra vez el último cobro, o el último de un cliente; con toName lo manda a otra persona. También pide confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          payerName: { type: "string", description: "Nombre, si hay que repetir el de ese cliente." },
          toName: { type: "string", description: 'Si el mismo cobro va para OTRA persona ("lo mismo a Luis").' },
          toPhone: { type: "string", description: "Celular de 10 dígitos de esa otra persona, solo si la persona lo escribió." },
          amount: { type: "string", description: 'Solo si piden el mismo cobro con otro monto ("lo mismo pero de 200").' },
          method: { type: "string", enum: ["push", "qr", "link"], description: "Solo si piden cambiar la forma de cobro." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_choice",
      description:
        'Cuando dudas y la respuesta es una de dos o tres cosas ("¿QR o a su celular?", "¿corte de dama o de caballero?"), pregunta con botones. Una sola pregunta corta. Si la respuesta es abierta (monto, nombre, celular), no la uses.',
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["question", "options"],
        properties: {
          question: { type: "string", description: "La pregunta, en una línea." },
          options: { type: "array", minItems: 2, maxItems: 3, items: { type: "string" }, description: "Dos o tres respuestas, de máximo 20 caracteres cada una." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_charge",
      description:
        'Hay una tarjeta de cobro esperando y la persona la aceptó con sus palabras ("ándale, mándaselo", "sí porfa, que le llegue"). Solo si de verdad aceptó: si duda, pregunta o pide esperar, no la llames. Un nombre, un concepto o un dato suelto ("Pepito", "es de uñas") NO es aceptar: es una corrección, y el cobro se arma otra vez con prepare_charge incluyendo ese dato.',
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_charge",
      description:
        'Cancela el cobro que está esperando confirmación ("cancélalo", "ya no", "mejor no"). No borra apuntes de la caja.',
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_recurring",
      description: "Muestra los cobros recurrentes: a quién, cuánto, cada cuándo y cuándo toca el siguiente.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_recurring",
      description: "Detiene el cobro recurrente de un cliente. Ya no se le manda nada más.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["payerName"],
        properties: {
          payerName: { type: "string", description: 'El cliente del cobro recurrente, o "yo" si es el que le llega a quien escribe.' },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_recurring",
      description:
        'Cambia el monto o cada cuándo se cobra un recurrente que ya existe ("súbele a 600 la mensualidad de Ana", "que sea quincenal"). No manda ningún cobro ahora: aplica desde el siguiente periodo.',
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["payerName"],
        properties: {
          payerName: { type: "string", description: 'El cliente del cobro recurrente, o "yo".' },
          amount: { type: "string", description: "El monto nuevo en pesos, si lo dijeron." },
          every: { type: "string", enum: ["semanal", "quincenal", "mensual"], description: "La frecuencia nueva, si la dijeron." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resume_recurring",
      description: 'Retoma un cobro recurrente que quedó en pausa ("retoma el de Ana", "vuelve a cobrarle a Ana cada mes").',
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["payerName"],
        properties: { payerName: { type: "string", description: 'El cliente del cobro recurrente, o "yo".' } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_contacts",
      description: 'Los clientes guardados con su celular ("¿a quién tengo guardado?", "mis clientes").',
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "close_fixed_qr",
      description: 'Piden dejar de usar el QR fijo del mostrador ("cierra el QR fijo", "ya no uses el QR del mostrador").',
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "pey_payments",
      description: "Los últimos pagos que pey registró de verdad para esta cuenta, con su comisión.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "account_status",
      description: "A qué cuenta cae el dinero, si ya está activa en CoDi, si hay modo de prueba y el tope del día.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Anota EN SILENCIO algo duradero que la persona dijo de su negocio, de un cliente o de cómo trabaja (qué vende, horarios, a quién le cobra cómo), aunque no pida recordarlo. Con sus palabras, corto. Nunca un cobro puntual, un monto de una venta ni datos secretos.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["fact"],
        properties: {
          fact: { type: "string", description: "La nota, en una frase corta." },
          section: {
            type: "string",
            enum: ["negocio", "clientes", "costumbres", "pendientes"],
            description: "negocio: qué vende, dónde, horarios. clientes: datos de un cliente. costumbres: cómo le gusta cobrar o trabajar. pendientes: algo por hacer.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description: 'La persona pide olvidar algo que te había contado ("olvida lo de los lunes"). Con fact "todo" se olvida todo.',
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["fact"],
        properties: {
          fact: { type: "string", description: "Palabras del dato que hay que olvidar." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "connect_bank",
      description:
        'Manda el enlace seguro para que la persona registre la cuenta (CLABE) donde quiere recibir sus cobros, o dice en qué estado está. Úsala para "registrar mi cuenta", "quiero recibir en mi banco", "dónde pongo mi CLABE".',
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          replace: { type: "boolean", description: "true si quiere cambiar la cuenta que ya registró." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_help",
      description: "Muestra todo lo que Zaldo sabe hacer, con ejemplos.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "charge_status",
      description:
        "Estado de los cobros CoDi: pendiente, pagado o vencido. Le pregunta a pey en ese momento, así que es el estado real.",
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
          period: { type: "string", enum: ["hoy", "ayer", "semana", "mes", "mes_pasado"] },
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
  const testCap = testCapFor(store, config, owner);
  const bank = profile.bank;
  const bankLine = !bank
    ? "Cuenta para recibir: no ha registrado la suya. Si pregunta dónde cae su dinero o quiere recibir en su banco: connect_bank."
    : bank.status === "ACTIVE"
      ? `Cuenta para recibir: la suya, terminada en ${bank.last4}, activa. Sus cobros caen directo en su banco.`
      : bank.status === "ERROR"
        ? `Cuenta para recibir: la terminada en ${bank.last4} no se pudo activar. Puede registrar otra con connect_bank.`
        : `Cuenta para recibir: la terminada en ${bank.last4}, en activación con Banxico (hasta 5 días hábiles).`;
  const memory = memoryOf(profile);
  // Los últimos cobros, para que "el de Ana", "el último" o "ese" tengan a qué referirse.
  const lastCharges = store
    .listCharges(owner)
    .filter((charge) => charge.status !== "cancelled")
    .slice(-5)
    .map((charge) => `${chargeLabel(charge)} ${formatMxn(charge.amountCents)} ${charge.concept} (${STATUS_LABEL[charge.status]})`)
    .join("; ");
  const waiting = store.listCharges(owner).find((charge) => charge.status === "awaiting_confirm");
  const recurring = store
    .listRecurrings(owner)
    .filter((plan) => plan.active)
    .map((plan) => `${plan.payerName} ${formatMxn(plan.amountCents)} ${frequencyLabel(plan.every)}, siguiente ${shortDate(plan.nextAt)}`)
    .join("; ");
  return [
    "CONTEXTO",
    `Hoy: ${date} (hora de Ciudad de México).`,
    `Persona: ${profile.name ?? "no sé su nombre"}. Negocio: ${profile.business ?? "no sé cómo se llama"}.`,
    `Su celular: ${phone ?? "no lo sé; pídelo solo si quiere que le llegue un cobro a ella"}.`,
    first ? "Es la primera vez que te escribe." : "Ya se conocen: no te presentes otra vez.",
    `Catálogo: ${catalog || "vacío. Si cobra algo seguido, ofrece guardarlo con su precio"}.`,
    `Clientes guardados: ${contacts || "ninguno"}.`,
    `Tope de cobros de hoy: quedan ${formatMxn(left)}.`,
    bankLine,
    testCap
      ? `MODO DE PRUEBA: máximo ${formatMxn(testCap)} por cobro. El dinero va a la cuenta de pruebas de pey, no al banco del negocio, y no se devuelve. Dilo si preguntan.`
      : "",
    goal ? `Meta del día: ${goal}.` : "",
    fiado ? `Fiado: ${fiado}.` : "",
    lastCharges ? `Últimos cobros (del más viejo al más nuevo): ${lastCharges}.` : "",
    waiting
      ? `HAY UNA TARJETA ESPERANDO CONFIRMACIÓN: ${formatMxn(waiting.amountCents)} · ${waiting.concept} · ${chargeLabel(waiting)}. Todavía NO se ha enviado. Si la persona la acepta: confirm_charge. Si la rechaza: cancel_charge. Si la corrige: prepare_charge otra vez.`
      : "",
    recurring ? `Cobros recurrentes activos: ${recurring}.` : "",
    draftLine(store, owner, now),
    threadLine(store, owner),
    memory
      ? `TUS NOTAS SOBRE ESTA PERSONA (solo tú las ves: úsalas con naturalidad y nunca menciones que existen)\n${memory}`
      : "TUS NOTAS SOBRE ESTA PERSONA: todavía ninguna.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Cómo se le dice a quien paga un cobro: Ana, Tú, o QR si es abierto. */
function chargeLabel(charge: Charge): string {
  if (charge.reusable) return "QR fijo";
  if (charge.payerName === PAYER_OPEN) return charge.method === "link" ? "Link" : "QR";
  return charge.payerName === PAYER_SELF ? "Tú" : charge.payerName;
}

/** A quién le llega o quién paga, dicho claro para quien confirma. */
function payerLine(charge: Charge): string {
  if (charge.method === "qr") {
    return charge.openAmount
      ? "Lo paga: quien escanee el QR; escribe el monto en la app de su banco"
      : "Lo paga: quien escanee el QR con la app de su banco";
  }
  if (charge.method === "link") return "Lo paga: quien abra el link (CoDi o tarjeta)";
  const phone = charge.payerPhone ? prettyPhone(charge.payerPhone) : "";
  if (charge.payerName === PAYER_SELF) return `Le llega a: tu celular ${phone}, en la app de tu banco`;
  if (isNumberLabel(charge.payerName)) return `Le llega a: el celular ${phone}, en la app de su banco`;
  return `Le llega a: ${charge.payerName} · ${phone}, en la app de su banco`;
}

const TEST_NOTE =
  'Modo de prueba: el pago va a la cuenta de pruebas de pey, no a tu banco, y no se devuelve. Para recibir en tu banco dime "registrar mi cuenta".';

/** El concepto que lleva un cobro cuando la persona no dijo ninguno. */
export const DEFAULT_CONCEPT = "Cobro";

export function chargeCard(charge: Charge, testMode = false, now = charge.createdAt): string {
  const via =
    charge.method === "push"
      ? "notificación CoDi"
      : charge.method === "qr"
        ? charge.reusable
          ? "QR CoDi fijo (no vence y recibe varios pagos)"
          : "QR CoDi"
        : charge.tip
          ? "link de pago, con opción de propina"
          : "link de pago";
  const detail = charge.items?.length
    ? charge.items.map((item) =>
        item.qty > 1
          ? `${item.qty} × ${item.name} · ${formatMxn(item.unitCents)} c/u`
          : `1 × ${item.name} · ${formatMxn(item.unitCents)}`,
      )
    : charge.concept === DEFAULT_CONCEPT
      ? []
      : [`Concepto: ${charge.concept}`];
  const adjust = charge.adjustCents
    ? [`${charge.adjustCents < 0 ? "Descuento" : "Cargo extra"}: ${charge.adjustCents < 0 ? "-" : "+"}${formatMxn(Math.abs(charge.adjustCents))}`]
    : [];
  return [
    charge.openAmount ? "Cobro con monto abierto" : `Cobro por ${formatMxn(charge.amountCents)}`,
    ...detail,
    ...adjust,
    payerLine(charge),
    `Por: ${via}`,
    ...(charge.repeat
      ? [`Se repite: ${frequencyLabel(charge.repeat)}, solo. El siguiente, el ${shortDate(nextOccurrence(now, charge.repeat))}.`]
      : []),
    ...(testMode ? [TEST_NOTE] : []),
  ].join("\n");
}

/** Lo que una herramienta no pudo hacer. Va de regreso al modelo para que pregunte o lo explique. */
const FAILED = "ERROR: ";

function fail(message: string): string {
  return `${FAILED}${message}`;
}

/** Un aviso de la caja que va tal cual a la persona, sin que el modelo lo reinterprete. */
const DIRECT = "AVISO: ";

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
  "cancel_charge",
  "list_recurring",
  "cancel_recurring",
  "pey_payments",
  "account_status",
  "forget",
  "show_help",
  "connect_bank",
  "list_contacts",
  "close_fixed_qr",
  "update_recurring",
  "resume_recurring",
]);

/** Lo que el agente puede preguntarle a pey en vivo. Lo conecta flows.ts. */
export interface AgentServices {
  /** Vuelve a consultar en pey los cobros abiertos de esta persona. Devuelve los avisos de pago que salieron de ahí. */
  refresh?: (owner: string) => Promise<string[] | void>;
  /** Los pagos que pey registró para esta llave, lo más nuevo primero. */
  payments?: () => Promise<PeyTransaction[]>;
  /** La cuenta que recibe los cobros, si se registró por API. */
  account?: () => Promise<PeyBankAccount | null>;
}

const HELP = [
  "Esto hago por ti:",
  '· Cobrar con CoDi: "cobra 150", "cóbrale 200 a Ana 5512345678", "link de 500 con propina"',
  '· Cobros que se repiten solos: "cóbrale 500 a Ana cada mes"',
  '· QR para tu mostrador: "hazme un QR fijo de 50" o "un QR abierto"',
  '· Saber si pagaron: "¿ya pagó Ana?", "mis últimos pagos"',
  '· Catálogo: "agrega corte a 150" y luego "cobra 2 cortes"',
  '· Caja: "corte", "gasté 300 en insumos", "me pagaron 200 en efectivo"',
  '· Fiado: "Ana me quedó a deber 300", "cóbrale a Ana lo que debe"',
  '· Que no se me pase: "recuerda que cierro a las 8"',
  "Escríbeme o mándame nota de voz, como te salga.",
].join("\n");

/** El modelo dice que apuntó, guardó o borró algo. Solo vale si de verdad llamó a la herramienta. */
const CLAIMS_ACTION =
  /\b(apuntad[oa]s?|apunt[ée]|anotad[oa]s?|anot[ée]|registrad[oa]s?|registr[ée]|agregad[oa]s?|agregu[ée]|guardad[oa]s?|guard[ée]|borrad[oa]s?|borr[ée]|quit[ée]|qued[óo] (apuntad|guardad|registrad|agregad|list)[oa])(?![a-záéíóúñ])/i;

/** El modelo rechaza un cobro por su cuenta ("el mínimo es 1 peso"). Eso solo lo decide la caja. */
const REFUSES_CHARGE =
  /s[oó]lo (puedo|se puede|puedes) cobrar|(no (puedo|es posible|se puede)|no hago)[^.!?\n]{0,40}(cobr|generar)|(monto )?m[ií]nimo (es|debe|de|para)|fuera de (los )?rangos|no (puedo )?acept(o|ar) decimales|monto v[aá]lido/i;

/** El modelo pregunta por un celular. Para un cobro normal no hace falta: sale QR. */
const ASKS_PHONE = /\?[^?]*$/;
const MENTIONS_PHONE = /celular|n[uú]mero de (cel|tel)|tu n[uú]mero|su n[uú]mero|10 d[ií]gitos/i;
/** Frases donde sí hay alguien a quien mandarle el cobro: ahí pedir su celular es lo correcto. */
const NAMES_PAYER =
  /c[oó]bra(le|selo|les)|m[aá]nda(le|selo)|env[ií]a(le|selo)|\bcada (mes|semana|quincena|d[ií]a)|mensual|semanal|quincenal|recurrente|suscripci[oó]n|mensualidad/i;

/** El modelo afirma algo de la cuenta o del modo de prueba sin haberlo consultado. */
const CLAIMS_ACCOUNT = /(cuenta[^.!?\n]{0,40}(activa|lista|verificada))|modo de prueba/i;

/** El modelo dice que un cobro ya salió. Eso solo pasa cuando la persona confirma la tarjeta. */
const CLAIMS_SENT =
  /(ya|listo)[^.!?\n]{0,40}(sali[oó]|se envi[oó]|envié|mandé|se mand[oó]|va en camino)|(cobro|notificaci[oó]n|qr|link) (enviad[oa]|mandad[oa])|qued[oó] (enviad|mandad)[oa]|le (lleg[oó]|va a llegar|llegar[aá]) (el cobro|la notificaci[oó]n)/i;

/** El modelo dice que cambió algo de la configuración que no existe como herramienta ("ya elevé tu tope"). */
const CLAIMS_CHANGE =
  /\b(actualicé|actualizad[oa]|cambié|elevé|elevad[oa]|se elev[oó]|aumenté|aumentad[oa]|activé|configuré|configurad[oa]|programé|programad[oa]|desactivé)(?![a-záéíóúñ])/;

/** Nombres internos que nunca deben llegarle a la persona. */
const LEAKS =
  /prepare_charge|ask_choice|repeat_charge|cancel_charge|confirm_charge|charge_status|set_product|list_products|add_note|get_balance|undo_last|settle_debt|set_profile|set_business|save_contact|list_contacts|connect_bank|account_status|pey_payments|update_recurring|resume_recurring|cancel_recurring|list_recurring|close_fixed_qr|show_help|payerName|payerPhone|openAmount|tool_call|en mi memoria|mi memoria|base de datos|markdown|\bJSON\b|mis instrucciones|system prompt/i;

/** Lo que pide un cobro: sin nada de esto en lo reciente, un saludo o una pregunta no arman una tarjeta. */
const CHARGE_WORDS =
  /c[oó]bra|cobro|cobrar|c[oó]bre|\bqr\b|c[oó]digo|\blink\b|\bliga\b|codi|notificaci[oó]n|quiero pagar|voy a pagar|para pagar|p[aá]gam|p[aá]sale|m[aá]ndale|m[aá]ndaselo|env[ií]ale|mensualidad|suscripci[oó]n|recurrente|ticket|la cuenta|lo mismo|otro igual|rep[ií]te|mejor (de|por|a|con)|\d/i;

/** Una pregunta ("¿qué es CoDi?", "¿cómo funciona el cobro?") no pide cobrar, salvo que lo pida con todas sus letras. */
const ASKS_ABOUT = /\?|^\s*¿?(qu[eé]|c[oó]mo|qui[eé]n|cu[aá]nto cuesta|cu[aá]nto cobras|para qu[eé]|por qu[eé]|es seguro|d[oó]nde)\b/i;
const ORDERS_CHARGE =
  /c[oó]bra(le|me|selo|les)\b|cobrar(le|me|les)\b|(hazme|haces|dame|das|quiero|necesito|ocupo|puedes|podr[ií]as|ay[uú]dame a|genera|generas|manda|mandas|env[ií]a|arma|armas)[^?]{0,40}(\bqr\b|\blink\b|\bliga\b|cobr)/i;

function wantsCharge(store: Store, owner: string, texts: string[]): boolean {
  const asked = texts[texts.length - 1] ?? "";
  if (ASKS_ABOUT.test(asked) && !/\d/.test(asked) && !AMOUNT_WORDS.test(asked) && !ORDERS_CHARGE.test(asked)) return false;
  const recent = texts.slice(-3);
  if (recent.some((text) => CHARGE_WORDS.test(text) || AMOUNT_WORDS.test(text))) return true;
  // "2 cortes y un tinte" a secas, con catálogo: es una venta.
  const last = fold(texts[texts.length - 1] ?? "");
  return store.listProducts(owner).some((product) => last.includes(fold(product.name).replace(/s$/, "")));
}

/** Cosas del negocio que la persona cuenta para que se sepan, aunque no diga "recuerda". */
const WORK_FACT = /\b(abro|cierro|horario|atiendo|descanso|siempre|normalmente|por lo general|prefiero|no trabajo|trabajo (de|los))\b/i;

const NOT_DONE =
  'No me quedó claro qué hacer con eso. Dímelo otra vez en una frase, por ejemplo: "cobra 150" o "gasté 300 en insumos".';

/**
 * Montos dichos con letra o en jerga ("ochenta pesos", "ciento cincuenta",
 * "un centavo", "una luca"): no se pueden cotejar cifra por cifra, pero consta
 * que la persona dijo uno. Pasa seguido en notas de voz.
 */
const AMOUNT_WORDS =
  /\b(un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieci\w+|veinte|veinti\w+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|\w*cientos|quinientos|mil|mill[oó]n|millones|medio)\s+(pesos?|centavos?|varos?|bolas?|mil\b|mill[oó]n|millones)|\b(veinte|veinti\w+|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|\w*cientos|quinientos|mil)\b|\b(luca|lucas|quinient[oó]n|tost[oó]n|milpa)\b/i;

/**
 * ¿Ese monto lo dijo la persona, o sale de su libro? Un cobro nunca lleva una
 * cifra que el modelo se inventó. Vale si la escribió (en cualquier formato),
 * si es un fiado apuntado, si sale de una cuenta sencilla sobre lo que dijo
 * ("el doble", "más 20 de envío", "con 10% de descuento"), o si la dijo con
 * letra. Lo del catálogo lo resuelve el ticket.
 */
export function knownAmount(store: Store, owner: string, cents: number, extras: number[] = []): boolean {
  const texts = recentUserText(store, owner);
  if (saidAmount(texts, cents)) return true;
  const fiado = openDebts(store, owner, "deuda");
  if (fiado.some((note) => owed(note) === cents)) return true;
  const perPerson = new Map<string, number>();
  for (const note of fiado) {
    const key = fold(note.who ?? note.concept);
    perPerson.set(key, (perPerson.get(key) ?? 0) + owed(note));
  }
  if ([...perPerson.values()].includes(cents)) return true;
  // Las cuentas se hacen sobre lo reciente: el último mensaje y los dos anteriores.
  const recent = texts.slice(-3);
  // "El doble", "súbele 50": la cuenta es sobre el último cobro, aunque se haya cancelado.
  const lastCharge = store.listCharges(owner).slice(-1)[0];
  const bases = [...extras, ...(lastCharge && lastCharge.amountCents > 0 ? [lastCharge.amountCents / 100] : [])];
  if (derivable(cents, recent, bases)) return true;
  return recent.some((text) => AMOUNT_WORDS.test(text));
}

/**
 * El monto que la persona escribió como dinero en su último mensaje ("$150",
 * "150 pesos", "0.01", "2.5k"), si hay uno solo. Con él la caja corrige al
 * modelo cuando manda otra cifra: lo que dijo la persona manda.
 */
function spokenMoney(store: Store, owner: string): number | null {
  const texts = recentUserText(store, owner);
  return soleMoney(texts[texts.length - 1] ?? "");
}

/** Lo que la persona escribió en sus últimos mensajes, del más viejo al más nuevo. */
function recentUserText(store: Store, owner: string, count = 8): string[] {
  return store
    .recentTurns(owner)
    .filter((turn) => turn.role === "user")
    .slice(-count)
    .map((turn) => turn.content);
}

const PLACEHOLDER_NAME = /^(yo|t[uú]|cliente|usuario|usuaria|desconocid[oa]|persona|due[ñn][oa]|negocio|sin nombre|n\/?a)$/i;

function lastAssistantText(store: Store, owner: string): string {
  const turns = store.recentTurns(owner);
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    if (turn && turn.role === "assistant") return turn.content;
  }
  return "";
}

/** ¿Dijo que ese celular es el suyo, o contestó con el puro número cuando se le pidió? */
function saidOwnPhone(texts: string[], phone: string): boolean {
  return texts.some((text) => {
    const digits = text.replace(/\D/g, "");
    if (!digits.endsWith(phone) && !digits.includes(phone)) return false;
    if (/^[\s\d()+.-]+$/.test(text)) return true;
    return /\bmi (propio )?(cel|celular|n[uú]mero|whats|whatsapp|tel[eé]fono)\b/i.test(text) && !/\bsu (cel|celular|n[uú]mero)\b/i.test(text);
  });
}

/** Cancela el cobro que espera confirmación. No toca la caja. */
function cancelWaiting(store: Store, owner: string): string {
  const waiting = store.listCharges(owner).filter((charge) => charge.status === "awaiting_confirm");
  if (!waiting.length) {
    return "No hay ningún cobro por confirmar. Uno que ya salió no se cancela desde aquí: si no lo pagan, vence solo.";
  }
  for (const charge of waiting) store.updateCharge({ ...charge, status: "cancelled" });
  const last = waiting[waiting.length - 1];
  const what = !last || last.openAmount ? "el cobro" : `el cobro de ${formatMxn(last.amountCents)}`;
  return `Cancelé ${what}. No se envió nada.`;
}

/** ¿La persona pidió un QR con sus palabras? Si no, un cobro con celular va por notificación. */
function askedForQr(texts: string[]): boolean {
  return texts.slice(-3).some((text) => /\bqr\b|c[oó]digo|escane/i.test(text));
}

const SELF_WORDS =
  /(c[oó]brame|c[oó]bramelo|cobrarme|a mí(?![a-záéíóúñ])|a mi(?=\s*($|[.,;!?]|\d))|a mi mism[oa]|quiero pagar|voy a pagar|me (lo |la )?cobras|yo pago|pago yo|hacer un pago|a mi (propio )?(celular|cel|n[uú]mero))/i;

/** ¿Quien escribe pidió que el cobro le llegue a él ("cóbrame", "quiero pagar")? */
function askedForSelf(store: Store, owner: string): boolean {
  return store
    .recentTurns(owner)
    .filter((turn) => turn.role === "user")
    .slice(-6)
    .some((turn) => SELF_WORDS.test(turn.content));
}

/** ¿Dijo ese monto como PRECIO ("a 100", "$100", "100 cada uno")? "cobra 3 gel" no pone el gel a 3 pesos. */
function saidAsPrice(text: string, cents: number): boolean {
  const pesos = cents / 100;
  return [String(pesos), pesos.toFixed(2)].some((raw) => {
    const n = raw.replace(".", "\\.");
    return new RegExp(
      `(\\ba|de a|\\ben|\\bpor|\\bx)\\s*\\$?\\s*${n}(?![\\d.])|\\$\\s*${n}(?![\\d.])|(?<![\\d.])${n}\\s*(pesos\\s*)?(c\\/u|cada|por (pieza|unidad|persona))`,
      "i",
    ).test(text);
  });
}

/** Los renglones del ticket con el precio del catálogo. */
function ticketOf(
  store: Store,
  owner: string,
  raw: unknown,
  verify: boolean,
): { items: ChargeItem[]; totalCents: number } | { error: string; direct?: boolean } | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  if (raw.length > 20) return { error: "son demasiados productos para un solo cobro." };
  const items: ChargeItem[] = [];
  for (const entry of raw) {
    const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const name = nameOf(row.name);
    if (!name) return { error: "falta el nombre de un producto." };
    const qty = row.qty === undefined || row.qty === null ? 1 : Number(row.qty);
    // "150 tamales" y "un corte y medio" son cantidades válidas.
    if (!Number.isFinite(qty) || qty <= 0 || qty > 9999 || Math.round(qty * 100) !== qty * 100) {
      return { error: `la cantidad de ${name} tiene que ser mayor a cero, de máximo 9,999 y con hasta dos decimales.` };
    }
    const product = store.findProduct(owner, name);
    const typed = row.price === undefined || row.price === null ? null : parsePesosToCents(row.price);
    // "2 cortes a 100 cada uno": un precio que la persona dijo vale para este cobro, sin tocar el catálogo.
    const quoted =
      product && typed && typed !== product.priceCents && verify && saidAsPrice(recentUserText(store, owner, 1)[0] ?? "", typed) ? typed : null;
    const unitCents = quoted ?? product?.priceCents ?? typed;
    // Sin precio en el catálogo y sin que la persona lo haya dicho, pregunta la caja: el modelo no adivina.
    if (!unitCents || (!product && verify && !knownAmount(store, owner, unitCents))) {
      return {
        error: `No tengo "${name}" en tu catálogo. ¿A cuánto lo cobro? Dime el precio y lo dejo guardado.`,
        direct: true,
      };
    }
    const label = product?.name ?? name;
    const same = items.find((item) => fold(item.name) === fold(label));
    if (same) same.qty += qty;
    else items.push({ name: label, qty, unitCents });
  }
  return { items, totalCents: items.reduce((total, item) => total + Math.round(item.qty * item.unitCents), 0) };
}

/** "55 2222 3333": así se llama en el libro a un cliente del que solo se sabe el celular. */
export function isNumberLabel(name: string): boolean {
  return /^\d{2} \d{4} \d{4}$/.test(name);
}

/**
 * El modelo mandó como "productos" algo que no está en el catálogo, pero la
 * persona sí dijo cuánto: "cobra 150 de uñas", "2 cortes a 150 cada uno".
 * Devuelve el total y el concepto, o null si de verdad falta el precio.
 */
function looseCharge(
  store: Store,
  owner: string,
  raw: Record<string, unknown>,
): { cents: number; concept: string } | null {
  const rows = (Array.isArray(raw.items) ? raw.items : [])
    .map((entry) => {
      const row = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      const qty = Number(row.qty);
      return { name: nameOf(row.name), qty: Number.isInteger(qty) && qty > 0 && qty < 100 ? qty : 1 };
    })
    .filter((row) => row.name);
  if (!rows.length) return null;
  // Si algo sí está en el catálogo es un ticket de verdad: lo que falta es el precio de lo otro.
  if (rows.some((row) => store.findProduct(owner, row.name))) return null;
  const texts = recentUserText(store, owner);
  const last = texts[texts.length - 1] ?? "";
  let cents: number | null = null;
  // "a 150 cada uno": el precio es por pieza.
  const unit = /\ba\s+\$?\s*(\d[\d.,]*)/i.exec(last);
  const single = rows[0];
  if (rows.length === 1 && single && unit?.[1] && /cada un[oa]|c\/u|por pieza|cada pieza|por cabeza/i.test(last)) {
    const each = parsePesosToCents(unit[1].replace(/[.,]+$/, ""));
    if (each) cents = each * single.qty;
  }
  if (cents === null) {
    const given = parsePesosToCents(raw.amount);
    if (given !== null && knownAmount(store, owner, given)) cents = given;
  }
  if (cents === null) cents = spokenMoney(store, owner);
  if (cents === null) return null;
  const concept = rows.map((row) => (row.qty > 1 ? `${row.qty} ${plural(row.name)}` : row.name)).join(", ");
  return { cents, concept: concept.slice(0, 80) };
}

/** Celulares distintos a los que una persona puede mandar notificaciones en un día, y notificaciones en total. */
const MAX_RECIPIENTS_PER_DAY = 10;
const MAX_PUSHES_PER_DAY = 30;

/** Palabras que piden ajustar el total de un ticket: descuento, propina, envío, IVA. */
const ADJUSTS = /descuento|rebaja|menos|m[aá]s|propina|env[ií]o|\biva\b|%|por ?ciento|mitad|doble|anticipo|redonde/i;

const GENERIC_PAYER = /^(cliente|clienta|clientes|usuario|usuaria|persona|alguien|desconocid[oa]|comprador|compradora|n\/?a)$/i;

/** Máximo de opciones que se ofrecen en una pregunta, y lo que cabe en un botón de WhatsApp. */
const MAX_OPTIONS = 3;
const MAX_LABEL = 20;

/** Lo que la caja le dice tal cual a la persona. Con opciones, la pregunta sale con botones. */
function direct(message: string, options?: string[]): { output: string; options?: string[] } {
  return { output: `${DIRECT}${message}`, ...(options && options.length >= 2 ? { options: options.slice(0, MAX_OPTIONS) } : {}) };
}

/** Otras formas de cobrar cuando la notificación no se puede: siempre hay QR; link si hay página pública. */
function otherWays(config: AppConfig): string[] {
  return config.publicBaseUrl ? ["Dame un QR", "Mejor por link"] : ["Dame un QR", "Cancelar cobro"];
}

/** Las palabras de un texto, sin acentos ni plurales, para cotejar productos. */
function wordsOf(text: string): Set<string> {
  return new Set(
    fold(text)
      .split(/[^a-z0-9ñ]+/)
      .filter((word) => word.length >= 3)
      .map((word) => word.replace(/s$/, "")),
  );
}

/**
 * ¿Lo que dijo la persona alcanza para saber cuál producto es? Si su palabra
 * ("corte") cabe en dos o más del catálogo y no dijo nada que los distinga,
 * la caja pregunta cuál, con botones si caben.
 */
function ambiguousProduct(store: Store, owner: string, names: string[], texts: string[]): ReturnType<typeof direct> | null {
  const heard = wordsOf(texts.join(" "));
  const products = store.listProducts(owner);
  const allHeard = (name: string) => [...wordsOf(name)].every((word) => heard.has(word));
  for (const name of names) {
    const shared = [...wordsOf(name)].filter((word) => heard.has(word));
    if (!shared.length) continue;
    const rivals = products.filter((product) => shared.every((word) => wordsOf(product.name).has(word)));
    if (rivals.length < 2) continue;
    // Dijo el nombre completo de este y de ningún otro: no hay duda.
    if (allHeard(name) && rivals.filter((product) => allHeard(product.name)).length === 1) continue;
    const labels = rivals.map((product) => product.name);
    if (labels.length <= MAX_OPTIONS && labels.every((label) => label.length <= MAX_LABEL)) {
      return direct("¿Cuál de estos cobro?", labels);
    }
    return direct(`¿Cuál cobro? En tu catálogo tengo: ${labels.slice(0, 6).join(", ")}.`);
  }
  return null;
}

/** Cuánto vive un cobro a medias: pasado ese rato, lo que conteste la persona ya es otra cosa. */
const DRAFT_MS = 15 * 60_000;
const DRAFT_KEYS = ["amount", "concept", "payerName", "payerPhone", "method", "tip", "fixed", "openAmount", "every", "items"] as const;
/** Un pedido nuevo, con todas sus letras: ese no hereda nada del cobro que quedó a medias. */
const NEW_ORDER = /c[oó]bra(le|me|selo|les)?\b|otro cobro|cobro nuevo|nuevo cobro|\bqr de\b|\blink de\b/i;

function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && !value.length);
}

/** El cobro a medias de esa persona, si sigue vigente. */
function draftOf(store: Store, owner: string, now: number): Record<string, unknown> | null {
  const draft = store.getProfile(owner).draft;
  return draft && now - draft.at < DRAFT_MS ? draft.args : null;
}

function setDraft(store: Store, owner: string, args: Record<string, unknown> | null, now: number): void {
  const { draft: _old, ...profile } = store.getProfile(owner);
  void _old;
  if (!args) {
    store.setProfile(profile);
    return;
  }
  const kept: Record<string, unknown> = {};
  for (const key of DRAFT_KEYS) if (given(args[key])) kept[key] = args[key];
  store.setProfile({ ...profile, draft: { args: kept, at: now } });
}

/**
 * El cobro no pierde el hilo. Si la caja tuvo que preguntar algo ("¿cuál es
 * su celular?", "¿cuál de los dos?"), lo que ya se sabía queda guardado; la
 * respuesta de la persona completa ESE cobro aunque el modelo solo mande el
 * dato nuevo. Todo se vuelve a cotejar contra lo que ella escribió.
 */
function chargeWithThread(
  store: Store,
  config: AppConfig,
  owner: string,
  now: number,
  raw: Record<string, unknown>,
  last: string,
): ReturnType<typeof prepareCharge> {
  const draft = NEW_ORDER.test(last) ? null : draftOf(store, owner, now);
  const args: Record<string, unknown> = { ...(draft ?? {}) };
  for (const [key, value] of Object.entries(raw)) if (given(value)) args[key] = value;
  // Un monto nuevo sin productos reemplaza al ticket anterior solo si el modelo no los repitió… y viceversa no aplica: se respetan los dos.
  const done = prepareCharge(store, config, owner, now, args, true);
  if (done.charge) setDraft(store, owner, null, now);
  else if (done.output.startsWith(DIRECT)) setDraft(store, owner, args, now);
  return done;
}

/** El cobro a medias, dicho en una línea para el modelo. */
function draftLine(store: Store, owner: string, now: number): string {
  const draft = draftOf(store, owner, now);
  if (!draft) return "";
  const parts = [
    given(draft.amount) ? `monto ${String(draft.amount)}` : "",
    Array.isArray(draft.items) ? `productos ${draft.items.map((item) => `${String((item as Record<string, unknown>).qty ?? 1)} ${String((item as Record<string, unknown>).name ?? "")}`).join(", ")}` : "",
    given(draft.concept) ? `concepto ${String(draft.concept)}` : "",
    given(draft.payerName) ? `para ${String(draft.payerName)}` : "",
    given(draft.payerPhone) ? `celular ${String(draft.payerPhone)}` : "",
    given(draft.every) ? `se repite ${String(draft.every)}` : "",
    given(draft.method) ? `por ${String(draft.method)}` : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  return `COBRO A MEDIAS (le preguntaste un dato y estás esperando la respuesta): ${parts.join(" · ")}. Lo que la persona conteste ahora completa ESE cobro: llama a prepare_charge con el dato nuevo; lo demás ya está guardado. No vuelvas a preguntar lo que ya dijo.`;
}

/** Lo último que preguntó Zaldo, para que una respuesta corta se lea como respuesta a eso. */
function threadLine(store: Store, owner: string): string {
  const said = lastAssistantText(store, owner).trim();
  if (!said || !said.includes("?")) return "";
  const question = said.split("\n").filter((line) => line.includes("?")).pop() ?? "";
  if (!question) return "";
  return `EL HILO: lo último que preguntaste fue "${question.slice(0, 200)}". Si el mensaje de la persona es corto (un monto, un nombre, un celular, un sí o un no, una opción), es la respuesta a esa pregunta: sigue ese hilo.`;
}

export function prepareCharge(
  store: Store,
  config: AppConfig,
  owner: string,
  now: number,
  raw: Record<string, unknown>,
  /** true cuando lo pide el modelo: todo lo que mande se coteja con lo que dijo la persona. */
  verify = false,
): { output: string; charge?: Charge; replaced?: string; options?: string[] } {
  const said = verify ? recentUserText(store, owner) : [];
  const last = said[said.length - 1] ?? "";
  const every = normalizeFrequency(raw.every);

  // Lo que la caja no cobra o no adivina, antes que nada.
  if (verify && foreignCurrency(last)) return direct("Solo cobro en pesos mexicanos. ¿Cuántos pesos son?");
  if (verify && asksDaily(last) && !/seman|quincen|\bmes\b|mensual/i.test(last)) {
    return direct("Los cobros que se repiten solos no pueden ser diarios. ¿Cada cuándo se lo cobro?", ["Cada semana", "Cada quincena", "Cada mes"]);
  }
  const either = verify ? eitherOr(last) : null;
  if (either) return direct("¿Cuál de los dos cobro?", [formatMxn(either[0]), formatMxn(either[1])]);

  const parsed = ticketOf(store, owner, raw.items, verify);
  // "Cobra 150 de uñas" mandado como producto que no está en el catálogo: si
  // la persona sí dijo el monto, es un cobro suelto y no hay nada que preguntar.
  const loose = parsed && "error" in parsed && parsed.direct && verify ? looseCharge(store, owner, raw) : null;
  if (parsed && "error" in parsed && !loose) {
    return { output: parsed.direct ? `${DIRECT}${parsed.error}` : fail(parsed.error) };
  }
  const ticket = parsed && !("error" in parsed) ? parsed : null;
  // "Cobra un corte" con corte de dama y de caballero en el catálogo: no se adivina, se pregunta.
  const doubt = ticket && verify ? ambiguousProduct(store, owner, ticket.items.map((item) => item.name), [last]) : null;
  if (doubt) return doubt;
  const askedOpen = /abiert|sin monto|monto libre|cualquier (monto|cantidad)|lo que (quiera|guste|gusten|sea)|que (el cliente|[eé]l|ella|cada quien) (ponga|escriba|elija|teclee)/i;
  const openAmount = raw.openAmount === true && !ticket && !loose && (!verify || askedOpen.test(said.slice(-2).join(" ")));
  const fixed = raw.fixed === true;
  // La propina solo si la persona la mencionó: "con tarjeta" no es "con propina".
  const tip = raw.tip === true && (!verify || mentionsTip(said));
  if (every && (fixed || openAmount)) {
    return { output: fail("un cobro recurrente va por notificación al celular del cliente, no por QR fijo. Elige uno.") };
  }
  const testCap = testCapFor(store, config, owner);
  if (openAmount && testCap) {
    return direct(
      `En modo de prueba no hago QR de monto abierto: no podría topar lo que te paguen, y ese dinero no se devuelve. Sí te hago un QR fijo de hasta ${formatMxn(testCap)}.`,
    );
  }
  // Más de un millón no se cobra por CoDi: se dice de una vez, sin pedir el monto otra vez.
  const asNumber = typeof raw.amount === "number" ? raw.amount : Number(String(raw.amount ?? "").replace(/[$,\s]/g, ""));
  const gaveAmount = raw.amount !== undefined && raw.amount !== null && raw.amount !== "";
  if (!openAmount && !ticket && Number.isFinite(asNumber) && asNumber > 1_000_000) {
    return direct("Ese monto no lo puedo cobrar: CoDi acepta hasta $1,000,000.00 por cobro. ¿De cuánto lo hago?");
  }
  if (!openAmount && !ticket && gaveAmount && Number.isFinite(asNumber) && asNumber <= 0) {
    return direct("Ese monto no se puede cobrar: tiene que ser mayor a cero. ¿De cuánto lo hago?");
  }
  let amount = openAmount ? 0 : loose ? loose.cents : ticket ? ticket.totalCents : parsePesosToCents(raw.amount);
  if (!openAmount && !ticket && !loose && verify && (amount === null || !knownAmount(store, owner, amount))) {
    // El modelo mandó una cifra que nadie dijo ("0.01" convertido en 1). Si la
    // persona escribió un solo monto, ese es; si no, la caja lo pregunta.
    amount = spokenMoney(store, owner);
    if (amount === null) {
      return direct('Me falta el monto. ¿De cuánto es el cobro? Escríbemelo en números, por ejemplo: "cobra 150".');
    }
  }
  // "Un centavo", "50 centavos": si el modelo mandó esa cifra como pesos, son centavos.
  const centavos = verify && !ticket && !loose ? /\b(un|\d{1,2})\s+centavos?\b/i.exec(last) : null;
  if (centavos && amount !== null && !/pesos?\s+(con|y)\b/i.test(last)) {
    const count = (centavos[1] ?? "").toLowerCase() === "un" ? 1 : Number(centavos[1]);
    if (amount === count * 100) amount = count;
  }
  // "150 más 20 de envío": si el modelo se quedó con uno de los dos, lo que se cobra es la suma.
  const pair = verify && !ticket && !loose && !openAmount ? plusPair(last) : null;
  if (pair && amount !== null) {
    const [a, b] = [Math.round(pair[0] * 100), Math.round(pair[1] * 100)];
    if (amount === a || amount === b) amount = a + b;
  }
  // Un ticket del catálogo con descuento, propina fija, envío o IVA: el modelo
  // manda el total y la caja lo acepta solo si sale de lo que dijo la persona.
  let adjustCents = 0;
  if (ticket && verify && gaveAmount && amount !== null) {
    const given = parsePesosToCents(raw.amount);
    const bases = [ticket.totalCents / 100, ...ticket.items.map((item) => item.unitCents / 100)];
    if (given !== null && given !== ticket.totalCents && ADJUSTS.test(last) && derivable(given, said.slice(-2), bases)) {
      adjustCents = given - ticket.totalCents;
      amount = given;
    }
  }
  if (amount === null || amount > 100_000_000) {
    return direct("Ese monto no lo puedo cobrar: tiene que ser en pesos, mayor a cero y de máximo $1,000,000.00. ¿De cuánto lo hago?");
  }
  if (testCap && amount > testCap) {
    return direct(
      `Esta caja está en modo de prueba: por ahora cobro máximo ${formatMxn(testCap)} por cobro, porque el pago va a la cuenta de pruebas de pey, no a tu banco, y no se devuelve. ¿Qué hacemos?`,
      ["Cobrar 1 centavo", "Registrar mi cuenta"],
    );
  }

  let concept = cleanConcept(conceptOf(raw.concept));
  if (!concept && ticket) {
    const text = itemsText(ticket.items);
    concept = text.length <= 80 ? text : `${ticket.items.reduce((n, item) => n + item.qty, 0)} productos`;
  }
  if (!concept && loose) concept = cleanConcept(loose.concept);
  // El modelo a veces deja fuera el "de renta" que la persona sí dijo.
  if (!concept && verify) concept = spokenConcept(said);
  // Se puede cobrar sin decir por qué: el concepto es opcional.
  if (!concept) concept = DEFAULT_CONCEPT;
  // El concepto le llega a quien paga, en la app de su banco: no puede engañar ni pedir nada.
  const violation = verify ? chargeViolation(concept, store.getProfile(owner).business ?? "") : null;
  if (violation) return direct(violation.message);

  let name = nameOf(raw.payerName);
  if (name.length > 40) return { output: fail("el nombre es demasiado largo.") };
  if (GENERIC_PAYER.test(name)) name = "";
  let self = isSelf(name);
  const mine = ownPhone(store, owner);
  // "cobra 2 cortes" es una venta a un cliente: sale QR. Al celular del dueño solo si él lo pidió.
  const demoted = self && verify && !askedForSelf(store, owner);
  if (demoted) {
    self = false;
    name = "";
  }
  // Un nombre que la persona nunca dijo (y que no es un cliente guardado) lo inventó el modelo.
  if (verify && name && !self) {
    const heard = fold(said.join(" "));
    const saidIt = fold(name)
      .split(" ")
      .some((word) => word.length >= 3 && heard.includes(word));
    const saved = store.listContacts(owner).some((contact) => fold(contact.name) === fold(name));
    if (!saidIt && !saved) name = "";
  }
  if (!name && !self && verify) {
    // El modelo deja fuera muy seguido a quién se le cobra: se lee de lo que dijo, del mensaje más nuevo hacia atrás.
    if (SELF_WORDS.test(last)) self = true;
    else {
      // Un pedido nuevo ("cobra 40 de agua") solo se lee a sí mismo; una respuesta corta sigue el hilo de lo anterior.
      const from = NEW_ORDER.test(last) ? [last] : said.slice(-3).reverse();
      name = from.map((text) => spokenPayer([text])).find((found) => !!found) ?? "";
    }
  }
  const rawPhone = typeof raw.payerPhone === "string" && raw.payerPhone.trim() ? raw.payerPhone : "";
  // Si dijo "yo" sin que nadie lo pidiera y el número es el del dueño, se descarta: es un cobro a un cliente.
  const typedPhone = demoted && toTenDigits(rawPhone) === mine ? "" : rawPhone;
  let phone = toTenDigits(typedPhone);
  if (typedPhone && !phone) return { output: fail("ese celular no tiene 10 dígitos. Pídelo otra vez.") };
  // Un celular que la persona nunca escribió (y que no es suyo ni de un cliente guardado) lo inventó el modelo.
  if (verify && phone && phone !== mine && !saidPhone(said, phone) && !store.listContacts(owner).some((c) => c.phone === phone)) {
    phone = null;
  }
  if (phone && !plausiblePhone(phone)) {
    return direct("Ese celular no parece de verdad: son 10 dígitos de un número real. ¿Me lo repites?");
  }
  if (self && phone && !store.getProfile(owner).phone) {
    // Su propio celular se pregunta una sola vez.
    store.setProfile({ ...store.getProfile(owner), phone });
  }
  if (!phone && self) phone = mine;
  if (!phone && name && !self) phone = store.findContact(owner, name)?.phone ?? null;

  const asked = raw.method;
  // Un QR solo si lo pidieron con sus palabras: con celular de por medio, lo natural es la notificación.
  const wantsQr = asked === "qr" && (!verify || !(phone || name) || askedForQr(said));
  let method: ChargeMethod;
  if (fixed || openAmount) method = "qr";
  else if (every) method = "push";
  else if (tip) method = "link";
  else if (wantsQr || asked === "link" || (asked === "push" && !demoted)) method = asked as ChargeMethod;
  else method = phone || name ? "push" : "qr";

  if (every && !phone) {
    return direct(
      "Para un cobro recurrente necesito el celular del cliente, porque cada periodo le llega la notificación a su banco. ¿A quién se lo cobro y cuál es su número de 10 dígitos?",
    );
  }
  if (method === "link" && !config.publicBaseUrl) {
    return { output: fail("el link de pago todavía no está disponible. Ofrece notificación CoDi o QR.") };
  }
  if (method === "push" && !phone) {
    if (self || !name) {
      return direct("¿A qué celular te mando la notificación? Escríbeme los 10 dígitos del que usas en la app de tu banco, o elige otra forma.", otherWays(config));
    }
    return direct(`No tengo el celular de ${name}. ¿Cuál es? Escríbeme sus 10 dígitos, o elige otra forma.`, otherWays(config));
  }
  if (method === "push") {
    // Un celular sin nombre que no es el del dueño es de un cliente: se le llama por su número.
    if (self || (!name && phone === mine)) name = PAYER_SELF;
    else if (!name) name = prettyPhone(phone ?? "");
  } else {
    name = self ? PAYER_SELF : name || PAYER_OPEN;
    phone = null;
  }

  const dayStart = mexicoDayStart(now);
  const used = store.confirmedCentsSince(owner, dayStart);
  if (used + amount > config.dailyCapCents) {
    const left = Math.max(0, config.dailyCapCents - used);
    return direct(`Ese monto pasa el tope de cobros de hoy: te quedan ${formatMxn(left)}. Mañana se reinicia.`);
  }
  if (method === "push" && phone) {
    const sent = store
      .listCharges(owner)
      .filter((charge) => charge.method === "push" && charge.status !== "awaiting_confirm" && charge.status !== "cancelled");
    const unpaid = sent.filter(
      (charge) =>
        charge.payerPhone === phone &&
        charge.createdAt >= now - 24 * 3_600_000 &&
        (charge.status === "pending" || charge.status === "expired"),
    ).length;
    if (unpaid >= MAX_UNPAID_PUSHES_PER_PHONE) {
      return direct(
        `Ese celular ya tiene ${unpaid} cobros sin pagar en las últimas 24 horas, así que no le mando otra notificación. ¿Cómo lo cobro?`,
        otherWays(config),
      );
    }
    // Nada de cobros en masa: hay un tope de celulares distintos y de notificaciones por día.
    if (phone !== mine) {
      const today = sent.filter((charge) => charge.createdAt >= dayStart && charge.payerPhone !== mine);
      const phones = new Set(today.map((charge) => charge.payerPhone));
      if (!phones.has(phone) && phones.size >= MAX_RECIPIENTS_PER_DAY) {
        return direct(
          `Hoy ya mandaste notificaciones a ${phones.size} celulares distintos, que es el tope del día. ¿Cómo cobro este?`,
          otherWays(config),
        );
      }
      if (today.length >= MAX_PUSHES_PER_DAY) {
        return direct(`Hoy ya salieron ${today.length} notificaciones, que es el tope del día. ¿Cómo cobro este?`, otherWays(config));
      }
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
    ...(adjustCents ? { adjustCents } : {}),
    ...(fixed ? { reusable: true } : {}),
    ...(openAmount ? { openAmount: true } : {}),
    ...(tip && method === "link" ? { tip: true } : {}),
    ...(every ? { repeat: every } : {}),
  };
  // Un cobro corregido antes de confirmar ("mejor 200") reemplaza al anterior: solo queda uno por confirmar.
  // Si el anterior era para otra persona, se avisa que ya no va: nadie confirma creyendo que eran dos.
  let replaced: string | undefined;
  for (const stale of store.listCharges(owner)) {
    if (stale.status !== "awaiting_confirm") continue;
    store.updateCharge({ ...stale, status: "cancelled" });
    // Iba para otro celular: eso es otro cobro, y se avisa. Completar un QR con su celular es el mismo cobro.
    if (stale.payerPhone && stale.payerPhone !== (phone ?? "")) {
      const who = stale.payerName === PAYER_OPEN || stale.payerName === PAYER_SELF ? "" : ` a ${stale.payerName}`;
      replaced = `Descarté el cobro de ${formatMxn(stale.amountCents)}${who} que no habías confirmado: solo armo uno a la vez.`;
    }
  }
  store.insertCharge(charge);
  if (name !== PAYER_SELF && name !== PAYER_OPEN && phone && !isNumberLabel(name)) {
    store.upsertContact({ owner, name, phone });
  }
  return { output: "OK", charge, ...(replaced ? { replaced } : {}) };
}

function addNote(store: Store, owner: string, now: number, raw: Record<string, unknown>): string {
  const kind = raw.kind;
  if (typeof kind !== "string" || !(NOTE_KINDS as readonly string[]).includes(kind)) {
    return fail("el apunte es gasto, ingreso, deuda o debo.");
  }
  const amount = parsePesosToCents(raw.amount);
  // Una venta en efectivo no necesita decir de qué fue.
  const concept = conceptOf(raw.concept) ?? (kind === "ingreso" ? "venta" : null);
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
    // "venta en efectivo · venta en efectivo" no dice nada: el concepto solo sale si aporta.
    const what = ["venta", "efectivo", "venta en efectivo", "pago en efectivo", "pago"].includes(fold(concept)) ? "" : ` · ${concept}`;
    return `Apuntado: venta en efectivo de ${formatMxn(amount)}${what}.${goal ? ` Meta del día: ${goal}.` : ""}`;
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
): { output: string; charge?: Charge; replaced?: string; confirm?: "yes"; dropped?: boolean; options?: string[] } {
  const raw = argsOf(call);
  const said = recentUserText(store, owner);
  const last = said[said.length - 1] ?? "";
  if (call.function.name === "prepare_charge" || call.function.name === "repeat_charge") {
    if (already) return { output: fail("ya preparé un cobro en este mensaje."), dropped: true };
  }
  switch (call.function.name) {
    case "prepare_charge":
      // Un saludo o una pregunta sobre Zaldo no es un cobro, aunque el modelo lo arme.
      if (!wantsCharge(store, owner, said)) {
        return { output: fail("la persona no pidió ningún cobro en este mensaje. Contesta lo que dijo, en una o dos líneas, sin armar cobros.") };
      }
      return chargeWithThread(store, config, owner, now, raw, last);
    case "ask_choice": {
      // Una duda con respuestas contadas: una pregunta corta y dos o tres botones. Nada de menús.
      const question = nameOf(raw.question).slice(0, 300);
      const labels = (Array.isArray(raw.options) ? raw.options : [])
        .map((item) => nameOf(item))
        .filter((label, index, all) => label && all.findIndex((other) => fold(other) === fold(label)) === index);
      if (question.length < 5 || !question.includes("?")) return { output: fail("falta la pregunta, corta y con signo de interrogación.") };
      if (labels.length < 2 || labels.length > MAX_OPTIONS) {
        return { output: fail("son dos o tres opciones distintas. Si la respuesta es abierta (un monto, un nombre, un celular), pregunta con texto normal.") };
      }
      if (labels.some((label) => label.length > MAX_LABEL)) return { output: fail(`cada opción cabe en ${MAX_LABEL} caracteres.`) };
      if (looksSensitive(question) || LEAKS.test(question) || labels.some((label) => LEAKS.test(label))) {
        return { output: fail("esa pregunta no se puede hacer. Pregunta solo lo que hace falta para el cobro o la caja.") };
      }
      return direct(question, labels);
    }
    case "confirm_charge": {
      const waiting = store.listCharges(owner).some((charge) => charge.status === "awaiting_confirm");
      if (!waiting) return { output: fail("no hay ningún cobro esperando confirmación. Si pidió uno nuevo, llama a prepare_charge.") };
      return { output: "OK", confirm: "yes" };
    }
    case "resume_recurring": {
      const done = resumeRecurring(store, owner, now, nameOf(raw.payerName));
      return { output: done.ok ? done.text : fail(done.text) };
    }
    case "list_contacts": {
      const contacts = store.listContacts(owner);
      if (!contacts.length) {
        return { output: "Todavía no tienes clientes guardados. Se guardan solos cuando le cobras a alguien con su nombre y su celular." };
      }
      return { output: ["Tus clientes", ...contacts.map((contact) => `${contact.name} · ${prettyPhone(contact.phone)}`)].join("\n") };
    }
    case "close_fixed_qr": {
      const open = store.listCharges(owner).filter((charge) => charge.reusable && charge.status === "pending");
      if (!open.length) return { output: "No tienes ningún QR fijo activo." };
      return {
        output:
          "Un QR fijo no se apaga desde aquí: mientras esté a la vista, quien lo escanee puede pagar, y yo te sigo avisando de cada pago. Si ya no lo quieres usar, retíralo del mostrador.",
      };
    }
    case "update_recurring": {
      const given = raw.amount !== undefined && raw.amount !== null && raw.amount !== "";
      const amount = given ? parsePesosToCents(raw.amount) : null;
      if (given && (amount === null || !knownAmount(store, owner, amount))) {
        return direct("¿De cuánto queda el cobro recurrente? Escríbemelo en números.");
      }
      const cap = testCapFor(store, config, owner);
      if (amount !== null && cap && amount > cap) {
        return direct(`Esta caja está en modo de prueba: por ahora cobro máximo ${formatMxn(cap)} por cobro. Para cobrar más, dime "registrar mi cuenta".`);
      }
      const every = normalizeFrequency(raw.every);
      if (!given && !every) return { output: fail("falta el monto nuevo o la frecuencia nueva.") };
      const done = updateRecurring(store, owner, now, {
        who: nameOf(raw.payerName),
        ...(amount !== null ? { amountCents: amount } : {}),
        ...(every ? { every } : {}),
      });
      return { output: done.ok ? done.text : fail(done.text) };
    }
    case "repeat_charge": {
      const name = fold(nameOf(raw.payerName));
      const previous = store
        .listCharges(owner)
        .filter((charge) => charge.status !== "cancelled" && charge.status !== "failed")
        .reverse()
        .find((charge) => !name || fold(charge.payerName) === name);
      if (!previous) return { output: fail(name ? "no tengo un cobro de ese cliente." : "todavía no hay cobros.") };
      // "Lo mismo a Luis": el mismo cobro, para otra persona.
      const toName = nameOf(raw.toName);
      const askedMethod = raw.method === "push" || raw.method === "qr" || raw.method === "link" ? raw.method : null;
      // El celular de la otra persona solo si lo escribieron o ya está guardado.
      const typedTo = toTenDigits(typeof raw.toPhone === "string" ? raw.toPhone : "");
      const toPhone =
        typedTo && (saidPhone(said, typedTo) || store.listContacts(owner).some((contact) => contact.phone === typedTo)) ? typedTo : undefined;
      // "Lo mismo pero de 200": el monto nuevo tiene que haberlo dicho.
      const newAmount = raw.amount !== undefined && raw.amount !== null && raw.amount !== "" ? parsePesosToCents(raw.amount) : null;
      const changed = newAmount !== null && newAmount !== previous.amountCents && knownAmount(store, owner, newAmount) ? newAmount : null;
      const samePayer =
        previous.payerName === PAYER_SELF ? "yo" : previous.payerName === PAYER_OPEN ? "" : previous.payerName;
      return prepareCharge(store, config, owner, now, {
        ...(changed !== null
          ? { amount: (changed / 100).toFixed(2) }
          : previous.openAmount
            ? { openAmount: true }
            : previous.items?.length && !previous.adjustCents
              ? { items: previous.items.map((item) => ({ name: item.name, qty: item.qty, price: item.unitCents / 100 })) }
              : { amount: (previous.amountCents / 100).toFixed(2) }),
        concept: previous.concept,
        payerName: toName || samePayer,
        payerPhone: toName ? toPhone : (previous.payerPhone ?? undefined),
        method: askedMethod ?? (toName && previous.method !== "link" && !previous.reusable ? "push" : previous.method),
        tip: previous.tip === true,
        // Un QR fijo repetido sigue siendo fijo.
        ...(previous.reusable && !toName && askedMethod !== "push" && askedMethod !== "link" ? { fixed: true } : {}),
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
            const amount = charge.openAmount && charge.status !== "paid" ? "monto abierto" : formatMxn(charge.amountCents);
            const state = charge.reusable && charge.status === "pending" ? "activo" : STATUS_LABEL[charge.status];
            const sales = charge.reusable
              ? store.listCharges(owner).filter((sale) => sale.parentId === charge.id && sale.status === "paid")
              : [];
            const total = sales.length
              ? ` · ${sales.length} ${sales.length === 1 ? "pago" : "pagos"}, ${formatMxn(sales.reduce((sum, sale) => sum + sale.amountCents, 0))}`
              : "";
            return `${chargeLabel(charge)}: ${amount} · ${charge.concept} · ${state}${total}`;
          })
          .join("\n"),
      };
    }
    case "cancel_charge":
      if (already) return { output: fail("acabas de armar ese cobro en este mensaje: no lo canceles.") };
      setDraft(store, owner, null, now);
      return { output: cancelWaiting(store, owner) };
    case "list_recurring": {
      const lines = recurringLines(store, owner, now);
      if (!lines.length) {
        return { output: 'No tienes cobros recurrentes. Dime, por ejemplo: "cóbrale 500 a Ana cada mes".' };
      }
      return { output: ["Tus cobros recurrentes", ...lines].join("\n") };
    }
    case "cancel_recurring": {
      const done = cancelRecurrings(store, owner, nameOf(raw.payerName));
      return { output: done.ok ? done.text : fail(done.text) };
    }
    case "remember": {
      const fact = cleanNote(nameOf(raw.fact));
      if (fact.length < 3) return { output: fail("falta la nota.") };
      const asked = wantsMemory(last);
      // Un cobro no es un dato para las notas: de eso ya se encarga la caja. Un "por cierto…" sin cifras sí lo es.
      if (!asked && /[0-9]/.test(fact) && (ORDERS_CHARGE.test(last) || /^\s*(cobra|c[oó]brale|c[oó]brame)\b/i.test(last))) {
        return { output: "OK: eso es un cobro, no va en tus notas. Sigue con lo que la persona pidió." };
      }
      if (looksSensitive(fact) || (asked && looksSensitive(last))) {
        return asked
          ? direct("Eso no lo guardo: contraseñas, NIP, tarjetas y CLABE no se le dan a nadie por chat, tampoco a mí.")
          : { output: "OK: eso es un dato privado y no va en tus notas. Sigue con lo que la persona pidió." };
      }
      if (looksLikeInstruction(fact)) {
        return asked
          ? direct("Eso no lo puedo tener presente: recuerdo cosas de tu negocio (horarios, clientes, cómo cobras), no cambios a cómo trabajo.")
          : { output: "OK: eso no es un dato del negocio y no va en tus notas. Sigue con lo que la persona pidió." };
      }
      // Solo entra lo que la persona escribió: una nota no trae datos que nadie dijo.
      if (!grounded(fact, said)) {
        return { output: "OK: eso no lo dijo la persona, así que no se anotó. Sigue con lo que pidió." };
      }
      const profile = store.getProfile(owner);
      store.setProfile({ ...profile, memory: addMemory(memoryOf(profile), sectionOf(raw.section), fact) });
      return {
        output: asked
          ? 'OK: anotado. Contesta en una frase corta y natural que lo tendrás presente (por ejemplo "Va, lo tengo presente"), sin decir "memoria", "notas" ni "guardado".'
          : "OK: anotado en silencio. No lo menciones: sigue con lo que la persona pidió.",
      };
    }
    case "forget": {
      const query = fold(nameOf(raw.fact));
      const profile = store.getProfile(owner);
      const memory = memoryOf(profile);
      if (/^todo( lo (que )?(sabes|recuerdas|guardaste|anotaste))?$/.test(query) || query === "todos") {
        if (!countNotes(memory)) return { output: "No tengo nada tuyo que olvidar." };
        store.setProfile({ ...profile, memory: "", facts: [] });
        return { output: "Listo: olvidé lo que me habías contado de tu negocio. Tus cobros y tu caja siguen igual." };
      }
      const dropped = dropNotes(memory, query);
      if (!dropped.gone.length) return { output: fail("no tengo presente nada parecido.") };
      store.setProfile({ ...profile, memory: dropped.markdown, facts: [] });
      return { output: dropped.gone.map((item) => `Listo, eso ya no lo tomo en cuenta: "${item}".`).join("\n") };
    }
    case "show_help":
      return { output: HELP };
    case "connect_bank": {
      const bank = store.getProfile(owner).bank;
      if (bank && bank.status !== "ERROR" && raw.replace !== true) {
        return {
          output:
            bank.status === "ACTIVE"
              ? `Tus cobros ya caen directo en tu cuenta terminada en ${bank.last4}. Si quieres cambiarla dime "cambiar mi cuenta".`
              : `Tu cuenta terminada en ${bank.last4} ya está registrada; Banxico la activa en hasta 5 días hábiles y yo te aviso. Si te equivocaste dime "cambiar mi cuenta".`,
        };
      }
      const link = accountLink(config, owner, now);
      if (!link) return { output: fail("el registro de cuentas no está disponible: falta la URL pública del servidor.") };
      const url = bank && raw.replace === true ? `${link}&cambiar=1` : link;
      return {
        output: `Para recibir tus cobros directo en tu banco, registra tu cuenta en esta página segura. El enlace es solo tuyo y vale 30 minutos:\n${url}\nNo me mandes tu CLABE por el chat: va solo en esa página.`,
      };
    }
    case "set_product": {
      const name = nameOf(raw.name);
      if (!name || name.length > 40) return { output: fail("falta el nombre del producto, de hasta 40 caracteres.") };
      const zero = raw.price === 0 || raw.price === "0";
      const price = zero ? 0 : parsePesosToCents(raw.price);
      if (price === null) return { output: fail("falta el precio en pesos.") };
      // Cobrar algo no cambia el catálogo: solo si lo pidieron, o si contestan el precio que Zaldo preguntó.
      const askedPrice = /a cu[aá]nto|qu[eé] precio|cat[aá]logo/i.test(lastAssistantText(store, owner));
      if (!wantsCatalogChange(last) && !askedPrice) {
        return { output: fail("la persona no pidió cambiar su catálogo: no guardes productos y atiende lo que sí pidió.") };
      }
      if (price === 0 && !/quita|borra|elimina|saca|ya no (vendo|manejo|tengo)/i.test(last)) {
        return { output: fail("la persona no pidió quitar ese producto.") };
      }
      if (price > 0 && !saidAmount(said.slice(-3), price)) {
        return direct(`¿A cuánto dejo ${name}? Escríbeme el precio en números.`);
      }
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
      if (PLACEHOLDER_NAME.test(name) || GENERIC_PAYER.test(name)) return { output: fail("falta el nombre de verdad del cliente.") };
      // Un celular que la persona no escribió lo inventó el modelo.
      if (!saidPhone(said, phone)) return direct(`¿Cuál es el celular de ${name}? Son 10 dígitos.`);
      if (!plausiblePhone(phone)) return direct("Ese celular no parece de verdad: son 10 dígitos de un número real. ¿Me lo repites?");
      store.upsertContact({ owner, name, phone });
      return { output: `Cliente guardado: ${name}, ${prettyPhone(phone)}.` };
    }
    case "set_profile": {
      const profile = store.getProfile(owner);
      const said = recentUserText(store, owner);
      let name = nameOf(raw.name).slice(0, 40);
      // El perfil es de quien escribe. Un nombre inventado, o el de un cliente, no entra.
      if (name && (PLACEHOLDER_NAME.test(name) || !saidOwnName(said, name))) {
        if (!raw.phone) {
          return {
            output: fail(
              "set_profile es solo para el nombre de quien escribe, y solo si lo dijo (\"soy…\", \"me llamo…\"). Si es un cliente, va en payerName del cobro.",
            ),
          };
        }
        name = "";
      }
      const typed = typeof raw.phone === "string" && raw.phone.trim() ? raw.phone : "";
      let phone = toTenDigits(typed);
      if (typed && !phone) return { output: fail("ese celular no tiene 10 dígitos.") };
      // Su celular solo si dijo que es suyo, o si contestó con el puro número.
      if (phone && !saidOwnPhone(said, phone)) {
        if (!name) {
          return {
            output: fail(
              "ese celular no es de quien escribe: es de un cliente. Úsalo en payerPhone del cobro o guárdalo con save_contact.",
            ),
          };
        }
        phone = null;
      }
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
      if (business) {
        // El nombre del negocio es el que la persona escribió, y no el de un banco ni una dependencia.
        if (!said.some((text) => fold(text).includes(fold(business)))) {
          return { output: fail("la persona no dijo ese nombre de negocio: no lo guardes.") };
        }
        if (looksSensitive(business) || chargeViolation(business, "")) {
          return direct("Ese nombre no lo puedo usar para tu negocio: no puede ser el de un banco, una dependencia u otra empresa, ni llevar datos privados.");
        }
      }
      if (hasGoal && goal !== null && goal > 0 && !knownAmount(store, owner, goal)) {
        return direct("¿De cuánto es tu meta del día? Escríbemela en números.");
      }
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
    case "add_note": {
      // "¿Qué pasaría si gasto 3000?" es una pregunta, no un movimiento.
      if (hypothetical(last)) {
        return { output: fail("es una pregunta hipotética: no apuntes nada. Contesta con las cifras del corte (get_balance) si hace falta.") };
      }
      const cents = parsePesosToCents(raw.amount);
      if (cents !== null && !knownAmount(store, owner, cents)) {
        return direct("¿De cuánto fue? Escríbeme el monto en números y lo apunto.");
      }
      // "Ana me abonó 120": si Ana tiene fiado abierto, eso es un abono, no una venta nueva.
      if (raw.kind === "ingreso" && saysPayment(last)) {
        const debtor = openDebts(store, owner, "deuda")
          .map((item) => item.who ?? "")
          .find((who) => who && (fold(nameOf(raw.who)) === fold(who) || fold(last).includes(fold(who))));
        if (debtor) {
          const done = settleDebts(store, owner, "deuda", debtor, cents);
          if (done.found) {
            const rest = done.leftCents > 0 ? `Quedan ${formatMxn(done.leftCents)}.` : "Quedó saldado.";
            return { output: `Listo: ${debtor} te pagó ${formatMxn(done.paidCents)}. ${rest}` };
          }
        }
      }
      return { output: addNote(store, owner, now, raw) };
    }
    case "settle_debt": {
      const who = nameOf(raw.who);
      const kind = raw.direction === "pague" ? "debo" : "deuda";
      const given = raw.amount !== undefined && raw.amount !== null && raw.amount !== "";
      const amount = given ? parsePesosToCents(raw.amount) : null;
      if (!who) return { output: fail("falta el nombre de la otra persona.") };
      if (given && amount === null) return { output: fail("el monto del abono no es válido.") };
      // Una deuda solo se salda si la persona dijo que hubo un pago.
      if (!saysPayment(last)) {
        return { output: fail("la persona no dijo que hubo un pago o un abono: no saldes nada.") };
      }
      if (amount !== null && !knownAmount(store, owner, amount)) {
        return direct("¿De cuánto fue el abono? Escríbemelo en números.");
      }
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
      // "Ya no", "mejor cancélalo" con un cobro por confirmar es cancelar el cobro, no borrar un apunte.
      if (store.listCharges(owner).some((charge) => charge.status === "awaiting_confirm")) {
        if (!wantsDelete(last) && !/cancel|ya no|mejor no|olv[ií]dalo|d[eé]jalo/i.test(last)) {
          return { output: fail("la persona no pidió cancelar ni borrar nada.") };
        }
        return { output: cancelWaiting(store, owner) };
      }
      // Un apunte solo se borra si lo pidieron: un gasto nuevo no borra el anterior.
      if (!wantsDelete(last)) {
        return { output: fail("la persona no pidió borrar nada: no borres apuntes y atiende lo que sí pidió.") };
      }
      // El más reciente; con la misma hora gana el que se apuntó al final.
      const newest = store.listNotes(owner).reduce<Note | null>(
        (latest, note) => (!latest || note.createdAt >= latest.createdAt ? note : latest),
        null,
      );
      if (!newest) return { output: fail("no hay apuntes que borrar.") };
      store.removeNote(newest.id);
      return { output: `Borré: ${NOTE_LABEL[newest.kind]} de ${formatMxn(newest.amountCents)} · ${newest.concept}.` };
    }
    default:
      return { output: fail("herramienta desconocida.") };
  }
}

const VIA: Record<string, string> = { API_CODI_QR: "QR", API_CODI_PN: "notificación", PAYMENT_LINK: "link" };

/** Lo que pey registró de verdad: fecha, monto, por dónde entró y su comisión. */
async function paymentsText(services: AgentServices): Promise<string> {
  if (!services.payments) return fail("desde aquí no puedo consultar los pagos en pey.");
  let items: PeyTransaction[];
  try {
    items = await services.payments();
  } catch {
    return `${DIRECT}pey no me contestó ahorita. Pregúntame otra vez en un minuto.`;
  }
  const paid = items.filter((tx) => tx.status === "PAID").slice(0, 8);
  if (!paid.length) return "pey todavía no registra pagos recibidos en esta cuenta.";
  const lines = paid.map((tx) => {
    const fee = tx.breakdown?.feeCents ? ` (comisión ${formatMxn(tx.breakdown.feeCents)})` : "";
    const tip = tx.breakdown?.tipCents ? ` (propina ${formatMxn(tx.breakdown.tipCents)})` : "";
    const via = tx.payableType ? (VIA[tx.payableType] ?? "CoDi") : "CoDi";
    const what = tx.description ? ` · ${tx.description.slice(0, 40)}` : "";
    return `${shortDateTime(tx.datePaid ?? tx.dateCreated ?? 0)} · ${formatMxn(tx.amountCents)} · ${via}${what}${tip}${fee}`;
  });
  const total = paid.reduce((sum, tx) => sum + tx.amountCents, 0);
  return ["Últimos pagos según pey", ...lines, `Suman ${formatMxn(total)} en ${paid.length} ${paid.length === 1 ? "pago" : "pagos"}.`].join("\n");
}

/** A dónde cae el dinero y en qué estado está esa cuenta. */
async function accountText(
  store: Store,
  config: AppConfig,
  owner: string,
  now: number,
  services: AgentServices,
): Promise<string> {
  const lines: string[] = [];
  const own = store.getProfile(owner).bank;
  if (own?.status === "ACTIVE") {
    lines.push(`Tus cobros caen directo en tu cuenta terminada en ${own.last4}: activa en CoDi.`);
  } else if (own && own.status !== "ERROR") {
    lines.push(`Tu cuenta terminada en ${own.last4} está en activación con Banxico (hasta 5 días hábiles). Te aviso cuando quede.`);
  } else if (own) {
    lines.push(`Tu cuenta terminada en ${own.last4} no se pudo activar. Dime "registrar mi cuenta" para intentar con otra.`);
  }
  if (own?.status === "ACTIVE") {
    // Con cuenta propia activa no hace falta hablar de la del negocio.
  } else if (config.peyBankAccountId) {
    let account: PeyBankAccount | null = null;
    try {
      account = (await services.account?.()) ?? null;
    } catch {
      /* pey no contestó: se dice lo que se sabe */
    }
    const state =
      account?.codiStatus === "ACTIVE"
        ? "activa en CoDi"
        : account?.codiStatus === "ERROR"
          ? `con error en CoDi${account.errorMessage ? `: ${account.errorMessage}` : ""}`
          : account?.codiStatus
            ? "en activación con Banxico (hasta 5 días hábiles)"
            : "no pude leer su estado en pey";
    const which = account?.clabeLast4 ? `la cuenta con CLABE terminada en ${account.clabeLast4}` : "la cuenta registrada en pey";
    lines.push(`Los cobros caen en ${which}: ${state}.`);
  } else lines.push("Los cobros caen en la cuenta CoDi ligada a la llave de pey del negocio.");
  const testCap = testCapFor(store, config, owner);
  if (testCap) {
    lines.push(
      `Estás en modo de prueba: máximo ${formatMxn(testCap)} por cobro. Ese dinero va a la cuenta de pruebas de pey, no a tu banco, y no se devuelve. Para recibir en tu banco dime "registrar mi cuenta".`,
    );
  }
  const left = Math.max(0, config.dailyCapCents - store.confirmedCentsSince(owner, mexicoDayStart(now)));
  lines.push(`Tope de cobros de hoy: te quedan ${formatMxn(left)} de ${formatMxn(config.dailyCapCents)}.`);
  return lines.join("\n");
}

/** Las herramientas que hablan con pey esperan su respuesta; el resto es el libro. */
async function run(
  store: Store,
  config: AppConfig,
  owner: string,
  now: number,
  call: ToolCall,
  already: boolean,
  services: AgentServices,
): Promise<ReturnType<typeof execute>> {
  const name = call.function.name;
  if (name === "pey_payments") return { output: await paymentsText(services) };
  if (name === "account_status") return { output: await accountText(store, config, owner, now, services) };
  let news: string[] = [];
  if (name === "charge_status") {
    // "¿Ya pagó?" se contesta con lo que diga pey ahora, no con lo último que supimos.
    try {
      news = (await services.refresh?.(owner)) ?? [];
    } catch {
      /* sin pey, el estado del libro */
    }
  }
  const done = execute(store, config, owner, now, call, already);
  // Si al consultar cayó el pago de otro cobro, ese aviso no se pierde.
  if (news.length && !done.output.startsWith(FAILED)) {
    // El aviso ya dice que cayó: la línea "pagado" del mismo cobro y el "no hay abiertos" sobran.
    const rest = done.output
      .split("\n")
      .filter((line) => !line.endsWith(`· ${STATUS_LABEL.paid}`) && line !== "No hay cobros abiertos." && line !== "No tengo cobros con ese dato.");
    return { ...done, output: [...news, ...rest].join("\n") };
  }
  return done;
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

/** ¿Dos llamadas piden el mismo cobro? El modelo a veces repite la llamada en el mismo mensaje. */
function sameCharge(first: string, second: string): boolean {
  try {
    const a = JSON.parse(first) as Record<string, unknown>;
    const b = JSON.parse(second) as Record<string, unknown>;
    // Mismo cliente y mismos productos (o mismo monto): es el mismo cobro dicho dos veces, no dos cobros.
    const payer = (raw: Record<string, unknown>) => JSON.stringify([fold(String(raw.payerName ?? "")), String(raw.payerPhone ?? "")]);
    if (payer(a) !== payer(b)) return false;
    const items = (raw: Record<string, unknown>) =>
      Array.isArray(raw.items) && raw.items.length
        ? JSON.stringify(raw.items.map((item) => [fold(String((item as Record<string, unknown>).name ?? "")), Number((item as Record<string, unknown>).qty ?? 1)]))
        : null;
    if (items(a) !== null && items(a) === items(b)) return true;
    return items(a) === null && items(b) === null && String(a.amount ?? "") === String(b.amount ?? "");
  } catch {
    return first === second;
  }
}

export async function runAgent(input: {
  store: Store;
  config: AppConfig;
  owner: string;
  now: number;
  complete: Completer;
  /** Consultas en vivo a pey. Sin ellas, el agente contesta con lo que hay en el libro. */
  services?: AgentServices;
}): Promise<{
  charge: Charge | null;
  reply: string | null;
  tools: TurnTool[];
  confirm?: "yes" | "no";
  notice?: string;
  /** Si la respuesta es una pregunta con respuestas contadas: sale con botones. */
  options?: string[];
}> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${SYSTEM}\n\n${contextBlock(input.store, input.owner, input.config, input.now)}`,
    },
    ...history(input.store, input.owner),
  ];

  let charge: Charge | null = null;
  let nudged = false;
  let notice: string | undefined;
  const tools: TurnTool[] = [];
  const waitingCard = () => input.store.listCharges(input.owner).some((item) => item.status === "awaiting_confirm");
  for (let step = 0; step < 6; step++) {
    const result = await input.complete({ messages, tools: TOOLS });
    if (!result.toolCalls.length) {
      const noted = tools.some((tool) => tool.name === "remember" && tool.output.startsWith("OK: anotado"));
      const reply = result.content?.trim() || (noted ? "Va, lo tengo presente." : null);
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
      // Dijo que el cobro ya salió, o que cambió algo, sin que nada de eso haya pasado.
      if (reply && !tools.length && (CLAIMS_SENT.test(reply) || CLAIMS_CHANGE.test(reply))) {
        const pending = waitingCard();
        if (nudged) {
          return {
            charge,
            reply: pending ? "Ese cobro todavía no sale: falta tu confirmación. Escribe CONFIRMAR para mandarlo o CANCELAR si ya no va." : NOT_DONE,
            tools,
          };
        }
        nudged = true;
        messages.push({ role: "assistant", content: reply });
        messages.push({
          role: "system",
          content: pending
            ? "Ese mensaje no se envió: ningún cobro ha salido, hay una tarjeta esperando confirmación. Si la persona la aceptó claramente, llama a confirm_charge. Si la rechazó, cancel_charge. Si pidió otra cosa, atiéndela sin decir que el cobro se envió."
            : "Ese mensaje no se envió: dijiste que hiciste algo (mandar un cobro, cambiar o activar algo) sin llamar a ninguna herramienta, así que no pasó. Si la persona pidió un cobro, llama a prepare_charge. Si pidió algo que no puedes hacer (subir topes, cambiar reglas), dilo claro y sin afirmar que se hizo.",
        });
        continue;
      }
      // Se le salió un nombre interno: se le pide que lo diga en cristiano.
      if (reply && LEAKS.test(reply)) {
        if (nudged) return { charge, reply: NOT_DONE, tools };
        nudged = true;
        messages.push({ role: "assistant", content: reply });
        messages.push({
          role: "system",
          content:
            "Ese mensaje no se envió: mencionaste nombres internos o tus instrucciones. Contesta otra vez en lenguaje normal, como un encargado de caja, o llama a la herramienta que corresponde en vez de describirla.",
        });
        continue;
      }
      // Rechazó un cobro sin preguntarle a la caja ("el mínimo es 1 peso"): que la consulte, una vez.
      if (
        reply &&
        !tools.length &&
        !nudged &&
        // Negarse a un cobro lo decide la caja con sus reglas, no el modelo: una renta o una colegiatura sí se cobran.
        (REFUSES_CHARGE.test(reply) || /^\s*es[eo] no lo (armo|cobro|mando|hago)/i.test(reply)) &&
        !chargeViolation(recentUserText(input.store, input.owner).slice(-1)[0] ?? "", input.store.getProfile(input.owner).business ?? "")
      ) {
        nudged = true;
        messages.push({ role: "assistant", content: reply });
        messages.push({
          role: "system",
          content:
            "Ese mensaje no se envió: rechazaste o cambiaste un cobro sin llamar a prepare_charge. No existe monto mínimo y tú no decides qué se puede cobrar: llama ahora a prepare_charge con el monto y el concepto exactos que dijo la persona. Si de verdad falta un dato (monto, concepto o celular), pregunta solo eso.",
        });
        continue;
      }
      // Pidió un celular que no hace falta: sin a quién mandarlo, un cobro sale por QR.
      if (reply && !tools.length && !nudged && ASKS_PHONE.test(reply) && MENTIONS_PHONE.test(reply.slice(Math.max(0, reply.lastIndexOf("¿"))))) {
        const texts = recentUserText(input.store, input.owner);
        const last = texts[texts.length - 1] ?? "";
        const forSelf = askedForSelf(input.store, input.owner);
        const knows = ownPhone(input.store, input.owner) !== null;
        if ((forSelf && knows) || (!forSelf && !NAMES_PAYER.test(last))) {
          nudged = true;
          messages.push({ role: "assistant", content: reply });
          messages.push({
            role: "system",
            content: forSelf
              ? "Ese mensaje no se envió: pediste un celular que ya sabes (está en el contexto). Llama ahora a prepare_charge con payerName \"yo\" y lo demás que dijo la persona."
              : "Ese mensaje no se envió: pediste un celular que no hace falta. Un cobro sin persona a quien mandarlo sale por QR (o por link si lo pidió). Llama ahora a prepare_charge con el monto que dijo la persona, sin payerName ni payerPhone. Si lo que falta es el monto, pregunta solo el monto.",
          });
          continue;
        }
      }
      // Habló del estado de la cuenta o del modo de prueba sin consultarlo.
      if (reply && !tools.length && !nudged && CLAIMS_ACCOUNT.test(reply)) {
        nudged = true;
        messages.push({ role: "assistant", content: reply });
        messages.push({
          role: "system",
          content:
            "Ese mensaje no se envió: hablaste del estado de la cuenta o del modo de prueba sin consultarlo. Si la persona preguntó por eso, llama ahora a account_status. Si no lo preguntó, contesta sin mencionarlo.",
        });
        continue;
      }
      return { charge, reply, tools };
    }
    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
    const outputs: string[] = [];
    /** Lo que otras herramientas contestaron en el mismo mensaje que armó un cobro. */
    const aside: string[] = [];
    let final = true;
    let dropped = false;
    let offered: string[] | undefined;
    const said = recentUserText(input.store, input.owner);
    const lastSaid = said[said.length - 1] ?? "";
    const charging = result.toolCalls.some((call) => call.function.name === "prepare_charge" || call.function.name === "repeat_charge");
    let firstCharge: string | null = null;
    for (const call of result.toolCalls) {
      const name = call.function.name;
      // El descuento, el IVA o el envío de un cobro no son además un gasto ni un producto nuevo.
      const partOfCharge =
        charging && ADJUSTS.test(lastSaid) && (name === "add_note" || (name === "set_product" && !wantsCatalogChange(lastSaid)));
      const repeated = name === "prepare_charge" && firstCharge !== null && sameCharge(firstCharge, call.function.arguments);
      if (name === "prepare_charge" && firstCharge === null) firstCharge = call.function.arguments;
      const done: Awaited<ReturnType<typeof run>> = partOfCharge
        ? { output: fail("eso ya va dentro del cobro: no se apunta ni se guarda aparte.") }
        : repeated
          ? { output: fail("ese cobro ya está armado en este mensaje.") }
          : await run(
        input.store,
        input.config,
        input.owner,
        input.now,
        call,
        charge !== null,
        input.services ?? {},
      );
      if ("charge" in done && done.charge) charge = done.charge;
      if ("replaced" in done && done.replaced) notice = done.replaced;
      messages.push({ role: "tool", tool_call_id: call.id, content: done.output });
      tools.push({ name: call.function.name, args: call.function.arguments, output: done.output });
      // La persona aceptó la tarjeta con sus palabras: la caja decide si eso alcanza para mandarla.
      if ("confirm" in done && done.confirm) return { charge: null, reply: null, tools, confirm: done.confirm };
      outputs.push(done.output);
      if ("dropped" in done && done.dropped) dropped = true;
      if ("options" in done && done.options && !offered) offered = done.options;
      if (!FINAL_TOOLS.has(call.function.name) || done.output.startsWith(FAILED)) final = false;
      else aside.push(done.output.startsWith(DIRECT) ? done.output.slice(DIRECT.length) : done.output);
    }
    // Dos cobros en un mensaje: sale el primero, y se dice que el otro quedó pendiente.
    if (charge && dropped) aside.push("Armo un cobro a la vez: cuando confirmes este, dime el siguiente.");
    // "Agrega café a 35, cobra 2 y dime el corte": la tarjeta sale, y lo demás va antes, no se pierde.
    if (charge) return { charge, reply: aside.length ? aside.join("\n") : null, tools, ...(notice ? { notice } : {}) };
    const warning = outputs.find((output) => output.startsWith(DIRECT));
    if (warning) return { charge, reply: warning.slice(DIRECT.length), tools, ...(offered ? { options: offered } : {}) };
    // Todo salió bien y el resultado ya es el mensaje: se manda tal cual, con sus cifras exactas.
    if (final) return { charge, reply: outputs.join("\n"), tools };
  }
  return { charge, reply: "Se me enredó el mensaje. Dímelo otra vez en una frase.", tools };
}
