import { randomUUID } from "node:crypto";
import type { AppConfig } from "./config.js";
import { formatMxn, mexicoDayStart, parsePesosToCents } from "./money.js";
import { toTenDigits } from "./phone.js";
import { Store, type Charge, type ChargeMethod, type Note } from "./store.js";

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

const SYSTEM = `Eres Zaldo, el asistente de saldo de la persona que escribe en este chat. Hablas español de México, en frases cortas, sin markdown ni listas largas.

Cobras con CoDi. Nunca digas que un pago ya cayó: eso solo lo confirma el banco. Tú preparas el cobro con prepare_charge y la persona lo confirma con un botón.

Si no nombra a otra persona, el cobro es para quien escribe, a su propio celular, para que el push le llegue en la app de su banco.
Si nombra un contacto guardado, usa ese celular.
Si pide QR, method "qr". Si pide tarjeta o link, method "link". Si no dice nada, push.
Hace falta monto y concepto. Si falta uno, pregunta solo eso.
Para saldo, deudas, gastos y "¿ya pagó?", usa las herramientas y copia las cifras que te devuelvan. No inventes números.
Apuntar un gasto o una deuda no mueve dinero.
Un solo cobro por mensaje.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "prepare_charge",
      description: "Prepara un cobro CoDi. No lo envía: la persona lo confirma con un botón.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["amount", "concept"],
        properties: {
          amount: { type: "number", description: "Monto en pesos mexicanos." },
          concept: { type: "string", description: "Concepto que verá quien paga." },
          payerName: { type: "string", description: "Nombre de quien paga. Vacío si es la persona del chat." },
          payerPhone: { type: "string", description: "Celular de quien paga, si lo dijo." },
          method: { type: "string", enum: ["push", "qr", "link"] },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repeat_charge",
      description: "Prepara otra vez el último cobro, o el último de una persona. También pide confirmación.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          payerName: { type: "string", description: "Nombre, si hay que repetir el de esa persona." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "charge_status",
      description: "Estado de los cobros: pendiente, pagado o vencido.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Nombre o concepto. Vacío lista los abiertos." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_contact",
      description: "Guarda un nombre con su celular de 10 dígitos.",
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
      name: "add_note",
      description: "Apunta un gasto, una deuda o un ingreso sin mover dinero.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "amount", "concept"],
        properties: {
          kind: { type: "string", enum: ["gasto", "deuda", "ingreso"] },
          amount: { type: "number" },
          concept: { type: "string" },
          who: { type: "string" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_balance",
      description: "Saldo de hoy: cobrado, gastos apuntados, deudas y cobros abiertos.",
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

function contextBlock(store: Store, owner: string, config: AppConfig, now: number): string {
  const contacts = store
    .listContacts(owner)
    .map((contact) => `${contact.name} ${contact.phone}`)
    .join(", ");
  const used = store.confirmedCentsSince(owner, mexicoDayStart(now));
  const left = Math.max(0, config.dailyCapCents - used);
  return `Contactos: ${contacts || "ninguno"}. Tope de hoy: quedan ${formatMxn(left)}.`;
}

export function chargeCard(charge: Charge): string {
  const via = charge.method === "push" ? "Push CoDi" : charge.method === "qr" ? "QR CoDi" : "Link de pago";
  const phone = charge.payerPhone ? ` · ${charge.payerPhone}` : "";
  return [
    `Cobro de ${formatMxn(charge.amountCents)}`,
    `Para: ${charge.payerName}${phone}`,
    `Concepto: ${charge.concept}`,
    `Por: ${via}`,
  ].join("\n");
}

function fail(message: string): string {
  return message;
}

export function prepareCharge(
  store: Store,
  config: AppConfig,
  owner: string,
  now: number,
  raw: Record<string, unknown>,
): { output: string; charge?: Charge } {
  const amount = parsePesosToCents(raw.amount);
  if (amount === null) return { output: fail("el monto tiene que ser en pesos, mayor a cero y con centavos.") };
  const concept = conceptOf(raw.concept);
  if (!concept) return { output: fail("falta el concepto, de hasta 80 caracteres.") };

  const methodRaw = raw.method;
  const method: ChargeMethod =
    methodRaw === "qr" || methodRaw === "link" || methodRaw === "push" ? methodRaw : "push";
  if (method === "link" && !config.publicBaseUrl) {
    return { output: fail("el link de pago todavía no está disponible. Usa push o QR.") };
  }

  let name = typeof raw.payerName === "string" ? raw.payerName.replace(/\s+/g, " ").trim() : "";
  if (name.length > 40) return { output: fail("el nombre es demasiado largo.") };
  let phone = toTenDigits(typeof raw.payerPhone === "string" ? raw.payerPhone : "");
  if (!phone && name) phone = store.findContact(owner, name)?.phone ?? null;
  if (method === "push" && !phone) phone = toTenDigits(owner);
  if (method === "push" && !phone) {
    return { output: fail("necesito un celular de 10 dígitos para el push CoDi.") };
  }
  if (!name) name = "ti";

  const used = store.confirmedCentsSince(owner, mexicoDayStart(now));
  if (used + amount > config.dailyCapCents) {
    const left = Math.max(0, config.dailyCapCents - used);
    return { output: fail(`ese monto pasa el tope de hoy. Quedan ${formatMxn(left)}.`) };
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
  };
  store.insertCharge(charge);
  if (name !== "ti" && phone) store.upsertContact({ owner, name, phone });
  return { output: "Cobro preparado. El botón de confirmar ya sale en el chat. No digas que ya se envió.", charge };
}

function balanceText(store: Store, config: AppConfig, owner: string, now: number): string {
  const start = mexicoDayStart(now);
  const charges = store.listCharges(owner);
  const paid = charges
    .filter((charge) => charge.status === "paid" && (charge.paidAt ?? 0) >= start)
    .reduce((sum, charge) => sum + charge.amountCents, 0);
  const gastos = store
    .listNotes(owner)
    .filter((note) => note.kind === "gasto" && note.createdAt >= start)
    .reduce((sum, note) => sum + note.amountCents, 0);
  const deudas = store.listNotes(owner).filter((note) => note.kind === "deuda");
  const deuda = deudas.reduce((sum, note) => sum + note.amountCents, 0);
  const open = charges.filter(
    (charge) => charge.status === "pending" || charge.status === "awaiting_confirm",
  ).length;
  const left = Math.max(0, config.dailyCapCents - store.confirmedCentsSince(owner, start));
  const deudaDetail = deudas
    .map((note) => `${formatMxn(note.amountCents)} ${note.who ?? note.concept}`)
    .join(", ");
  return [
    `Cobrado hoy: ${formatMxn(paid)}.`,
    `Gastos apuntados hoy: ${formatMxn(gastos)}.`,
    `Deudas apuntadas: ${deuda ? `${formatMxn(deuda)} (${deudaDetail})` : "ninguna"}.`,
    `Cobros abiertos: ${open}.`,
    `Tope restante hoy: ${formatMxn(left)}.`,
  ].join(" ");
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
      return prepareCharge(store, config, owner, now, raw);
    case "repeat_charge": {
      const name = typeof raw.payerName === "string" ? raw.payerName.trim().toLocaleLowerCase("es-MX") : "";
      const previous = store
        .listCharges(owner)
        .filter((charge) => charge.status !== "cancelled" && charge.status !== "failed")
        .reverse()
        .find((charge) => !name || charge.payerName.toLocaleLowerCase("es-MX") === name);
      if (!previous) return { output: fail(name ? "no tengo un cobro de esa persona." : "todavía no hay cobros.") };
      return prepareCharge(store, config, owner, now, {
        amount: (previous.amountCents / 100).toFixed(2),
        concept: previous.concept,
        payerName: previous.payerName,
        payerPhone: previous.payerPhone ?? undefined,
        method: previous.method,
      });
    }
    case "charge_status": {
      const query = typeof raw.query === "string" ? raw.query.trim().toLocaleLowerCase("es-MX") : "";
      const charges = store.listCharges(owner).filter((charge) => {
        if (!query) return charge.status === "pending" || charge.status === "awaiting_confirm" || charge.status === "expired";
        return (
          charge.payerName.toLocaleLowerCase("es-MX").includes(query) ||
          charge.concept.toLocaleLowerCase("es-MX").includes(query)
        );
      });
      if (!charges.length) return { output: query ? "No tengo cobros con ese dato." : "No hay cobros abiertos." };
      return {
        output: charges
          .slice(-6)
          .map(
            (charge) =>
              `${charge.payerName}: ${formatMxn(charge.amountCents)} · ${charge.concept} · ${STATUS_LABEL[charge.status]}`,
          )
          .join("\n"),
      };
    }
    case "save_contact": {
      const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
      const phone = toTenDigits(typeof raw.phone === "string" ? raw.phone : "");
      if (!name || name.length > 40 || !phone) return { output: fail("necesito nombre y celular de 10 dígitos.") };
      store.upsertContact({ owner, name, phone });
      return { output: `Guardé a ${name} con ${phone}.` };
    }
    case "add_note": {
      const kind = raw.kind;
      if (kind !== "gasto" && kind !== "deuda" && kind !== "ingreso") {
        return { output: fail("el apunte es gasto, deuda o ingreso.") };
      }
      const amount = parsePesosToCents(raw.amount);
      const concept = conceptOf(raw.concept);
      if (amount === null || !concept) return { output: fail("falta monto o concepto.") };
      const who = typeof raw.who === "string" && raw.who.trim() ? raw.who.trim().slice(0, 40) : null;
      const note: Note = { id: randomUUID(), owner, kind, amountCents: amount, concept, who, createdAt: now };
      store.insertNote(note);
      return { output: `Apuntado: ${kind} ${formatMxn(amount)} · ${concept}. No moví dinero.` };
    }
    case "get_balance":
      return { output: balanceText(store, config, owner, now) };
    default:
      return { output: fail("herramienta desconocida.") };
  }
}

export async function runAgent(input: {
  store: Store;
  config: AppConfig;
  owner: string;
  now: number;
  complete: Completer;
}): Promise<{ charge: Charge | null; reply: string | null }> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `${SYSTEM}\n\n${contextBlock(input.store, input.owner, input.config, input.now)}`,
    },
    ...input.store.recentTurns(input.owner).map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
  ];

  let charge: Charge | null = null;
  for (let step = 0; step < 4; step++) {
    const result = await input.complete({ messages, tools: TOOLS });
    if (!result.toolCalls.length) {
      return { charge, reply: result.content?.trim() || null };
    }
    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
    for (const call of result.toolCalls) {
      const done = execute(input.store, input.config, input.owner, input.now, call, charge !== null);
      if (done.charge) charge = done.charge;
      messages.push({ role: "tool", tool_call_id: call.id, content: done.output });
    }
    if (charge) return { charge, reply: null };
  }
  return { charge, reply: "Se me enredó el mensaje. Repítemelo en una frase." };
}
