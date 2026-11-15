/**
 * La caja de Zaldo: periodos, gastos del negocio, fiado y el corte.
 * Todo es aritmética sobre el libro (store); el modelo nunca escribe estas cifras.
 */
import { formatMxn, mexicoDayStart } from "./money.js";
import { fold, type Charge, type ChargeItem, type Frequency, type Note, type Store } from "./store.js";

/** Gastos de un negocio chico. Lo raro cae en "otros". */
export const CATEGORIES = [
  "insumos",
  "renta",
  "servicios",
  "sueldos",
  "transporte",
  "publicidad",
  "comida",
  "otros",
] as const;
export type Category = (typeof CATEGORIES)[number];

export function normalizeCategory(value: unknown): Category {
  if (typeof value !== "string") return "otros";
  const key = fold(value);
  return (CATEGORIES as readonly string[]).includes(key) ? (key as Category) : "otros";
}

export type Period = "hoy" | "ayer" | "semana" | "mes" | "mes_pasado";

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Ciudad de México: UTC−6 todo el año (sin horario de verano desde 2022). */
const OFFSET = 6 * HOUR;

export function normalizePeriod(value: unknown): Period {
  const key = typeof value === "string" ? fold(value).replace(/\s+/g, "_") : "";
  if (key === "ayer" || key === "semana" || key === "mes" || key === "mes_pasado") return key;
  return "hoy";
}

/** [start, end) en milisegundos y cómo se le dice a ese periodo. */
export function periodRange(period: Period, now: number): { start: number; end: number; label: string } {
  const dayStart = mexicoDayStart(now);
  const local = new Date(dayStart - OFFSET);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  if (period === "ayer") return { start: dayStart - DAY, end: dayStart, label: "ayer" };
  if (period === "semana") {
    const sinceMonday = (local.getUTCDay() + 6) % 7;
    return { start: dayStart - sinceMonday * DAY, end: now + 1, label: "esta semana" };
  }
  if (period === "mes") {
    return { start: Date.UTC(year, month, 1) + OFFSET, end: now + 1, label: MONTHS[month] ?? "este mes" };
  }
  if (period === "mes_pasado") {
    const start = Date.UTC(year, month - 1, 1) + OFFSET;
    const label = MONTHS[new Date(start - OFFSET).getUTCMonth()] ?? "el mes pasado";
    return { start, end: Date.UTC(year, month, 1) + OFFSET, label };
  }
  return { start: dayStart, end: now + 1, label: "hoy" };
}

function within(at: number, range: { start: number; end: number }): boolean {
  return at >= range.start && at < range.end;
}

function sum(notes: Note[]): number {
  return notes.reduce((total, note) => total + note.amountCents, 0);
}

function percent(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 100);
}

/** "2 uñas acrílicas, 1 gel": el ticket en una línea. */
export function itemsText(items: ChargeItem[]): string {
  return items.map((item) => `${item.qty} ${item.qty > 1 ? plural(item.name) : item.name}`).join(", ");
}

/** "corte" → "cortes", "tamal" → "tamales". Los nombres de varias palabras se quedan como están. */
export function plural(name: string): string {
  if (name.includes(" ") || name.length < 3) return name;
  const last = name.slice(-1).toLowerCase();
  if (last === "s" || last === "x") return name;
  if ("aeiouáéó".includes(last)) return `${name}s`;
  if (last === "z") return `${name.slice(0, -1)}ces`;
  return `${name}es`;
}

/** Lo que falta por pagar de una deuda. */
export function owed(note: Note): number {
  return Math.max(0, note.amountCents - (note.paidCents ?? 0));
}

export function openDebts(store: Store, owner: string, kind: "deuda" | "debo"): Note[] {
  return store.listNotes(owner).filter((note) => note.kind === kind && owed(note) > 0);
}

/** "Ana $150.00, Luis $80.00": una línea por persona, sumando sus deudas. */
export function debtsByPerson(notes: Note[]): string {
  const totals = new Map<string, { name: string; cents: number }>();
  for (const note of notes) {
    const name = note.who ?? note.concept;
    const entry = totals.get(fold(name)) ?? { name, cents: 0 };
    entry.cents += owed(note);
    totals.set(fold(name), entry);
  }
  return [...totals.values()].map((entry) => `${entry.name} ${formatMxn(entry.cents)}`).join(", ");
}

/**
 * Abona a las deudas abiertas de esa persona, de la más vieja a la más nueva.
 * Sin monto, las salda todas. Devuelve lo abonado y lo que aún queda.
 */
export function settleDebts(
  store: Store,
  owner: string,
  kind: "deuda" | "debo",
  who: string,
  amountCents: number | null,
): { paidCents: number; leftCents: number; found: boolean } {
  const key = fold(who);
  const mine = () =>
    openDebts(store, owner, kind)
      .filter((note) => fold(note.who ?? note.concept) === key)
      .sort((a, b) => a.createdAt - b.createdAt);
  const debts = mine();
  if (!debts.length) return { paidCents: 0, leftCents: 0, found: false };
  let budget = amountCents ?? Number.MAX_SAFE_INTEGER;
  let paid = 0;
  for (const debt of debts) {
    if (budget <= 0) break;
    const part = Math.min(owed(debt), budget);
    store.updateNote({ ...debt, paidCents: (debt.paidCents ?? 0) + part });
    budget -= part;
    paid += part;
  }
  return { paidCents: paid, leftCents: mine().reduce((total, debt) => total + owed(debt), 0), found: true };
}

/** Lo vendido hoy: cobros CoDi pagados más el efectivo apuntado. */
export function soldToday(store: Store, owner: string, now: number): number {
  const range = periodRange("hoy", now);
  const codi = store
    .listCharges(owner)
    .filter((charge) => charge.status === "paid" && within(charge.paidAt ?? 0, range))
    .reduce((total, charge) => total + charge.amountCents, 0);
  const cash = sum(store.listNotes(owner).filter((note) => note.kind === "ingreso" && within(note.createdAt, range)));
  return codi + cash;
}

/** "$1,650.00 de $2,000.00 (83%)" o null si no hay meta. */
export function goalLine(store: Store, owner: string, now: number): string | null {
  const goal = store.getProfile(owner).dailyGoalCents ?? 0;
  if (goal <= 0) return null;
  const sold = soldToday(store, owner, now);
  const left = goal - sold;
  const tail = left <= 0 ? "¡meta cumplida!" : `faltan ${formatMxn(left)}`;
  return `${formatMxn(sold)} de ${formatMxn(goal)} (${percent(sold, goal)}%), ${tail}`;
}

const METHOD_LABEL: Record<Charge["method"], string> = { push: "notificación", qr: "QR", link: "link" };

/**
 * El corte de caja de un periodo, listo para mandar. Solo salen las líneas con datos.
 * Una venta cuenta cuando el banco confirma el pago, no cuando se manda el cobro.
 */
export function corteText(store: Store, owner: string, period: Period, now: number): string {
  const range = periodRange(period, now);
  const profile = store.getProfile(owner);
  const charges = store.listCharges(owner);
  const notes = store.listNotes(owner).filter((note) => within(note.createdAt, range));
  const paid = charges.filter((charge) => charge.status === "paid" && within(charge.paidAt ?? 0, range));
  const cashNotes = notes.filter((note) => note.kind === "ingreso");
  const gastos = notes.filter((note) => note.kind === "gasto");

  const codi = paid.reduce((total, charge) => total + charge.amountCents, 0);
  const cash = sum(cashNotes);
  const sold = codi + cash;
  const spent = sum(gastos);

  const lines: string[] = [`Corte de ${range.label}${profile.business ? ` · ${profile.business}` : ""}`];
  if (paid.length) {
    const average = Math.round(codi / paid.length);
    lines.push(
      `Ventas CoDi: ${formatMxn(codi)} en ${paid.length} ${paid.length === 1 ? "cobro" : "cobros"} (ticket promedio ${formatMxn(average)})`,
    );
    const byMethod = new Map<Charge["method"], number>();
    for (const charge of paid) byMethod.set(charge.method, (byMethod.get(charge.method) ?? 0) + charge.amountCents);
    if (byMethod.size > 1) {
      lines.push(
        `Cómo pagaron: ${[...byMethod.entries()].map(([method, cents]) => `${METHOD_LABEL[method]} ${formatMxn(cents)}`).join(" · ")}`,
      );
    }
  } else lines.push("Ventas CoDi: $0.00");
  if (cash > 0) lines.push(`Efectivo y otros: ${formatMxn(cash)}`);
  const tips = paid.reduce((total, charge) => total + (charge.tipCents ?? 0), 0);
  if (tips > 0) lines.push(`Propinas: ${formatMxn(tips)} (aparte de lo vendido)`);
  lines.push(`Total vendido: ${formatMxn(sold)}`);

  // Lo más vendido: por producto si la venta salió del catálogo, si no por concepto.
  const sellers = new Map<string, { name: string; qty: number; cents: number }>();
  const count = (name: string, qty: number, cents: number) => {
    const entry = sellers.get(fold(name)) ?? { name, qty: 0, cents: 0 };
    entry.qty += qty;
    entry.cents += cents;
    sellers.set(fold(name), entry);
  };
  for (const charge of paid) {
    if (charge.items?.length) for (const item of charge.items) count(item.name, item.qty, item.qty * item.unitCents);
    else count(charge.concept, 1, charge.amountCents);
  }
  for (const note of cashNotes) count(note.concept, 1, note.amountCents);
  const top = [...sellers.values()].sort((a, b) => b.cents - a.cents).slice(0, 5);
  if (top.length > 1 || (top[0] && top[0].qty > 1)) {
    lines.push(`Lo más vendido: ${top.map((entry) => `${entry.name} ×${entry.qty} (${formatMxn(entry.cents)})`).join(" · ")}`);
  }

  if (spent > 0) {
    const byCategory = new Map<Category, number>();
    for (const note of gastos) {
      const category = normalizeCategory(note.category);
      byCategory.set(category, (byCategory.get(category) ?? 0) + note.amountCents);
    }
    const detail = [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, cents]) => `${category} ${formatMxn(cents)}`)
      .join(" · ");
    lines.push(`Gastos: ${formatMxn(spent)} (${detail})`);
    lines.push(`Te queda: ${formatMxn(sold - spent)}`);
  }

  if (period === "hoy") {
    const goal = goalLine(store, owner, now);
    if (goal) lines.push(`Meta del día: ${goal}`);
  }
  if (period !== "mes_pasado" && period !== "ayer") {
    // Un QR fijo siempre está abierto: no es un cobro que alguien deba.
    const waiting = charges.filter((charge) => charge.status === "pending" && !charge.reusable);
    if (waiting.length) {
      const total = waiting.reduce((t, charge) => t + charge.amountCents, 0);
      lines.push(`Por cobrar: ${waiting.length} ${waiting.length === 1 ? "cobro esperando" : "cobros esperando"} pago (${formatMxn(total)})`);
    }
    const expired = charges.filter((charge) => charge.status === "expired" && within(charge.createdAt, range)).length;
    if (expired) lines.push(`Vencidos sin pagar: ${expired}`);
    const fiado = openDebts(store, owner, "deuda");
    if (fiado.length) lines.push(`Fiado: ${formatMxn(fiado.reduce((t, n) => t + owed(n), 0))} (${debtsByPerson(fiado)})`);
    const debo = openDebts(store, owner, "debo");
    if (debo.length) lines.push(`Debes: ${formatMxn(debo.reduce((t, n) => t + owed(n), 0))} (${debtsByPerson(debo)})`);
  }
  return lines.join("\n");
}

const FREQUENCY_LABEL: Record<Frequency, string> = {
  semanal: "cada semana",
  quincenal: "cada quincena",
  mensual: "cada mes",
};

export function frequencyLabel(every: Frequency): string {
  return FREQUENCY_LABEL[every];
}

export function normalizeFrequency(value: unknown): Frequency | null {
  const key = typeof value === "string" ? fold(value) : "";
  if (key === "semanal" || key === "quincenal" || key === "mensual") return key;
  return null;
}

/**
 * Cuándo toca el siguiente cobro recurrente. Semanal y quincenal suman días;
 * mensual cae el mismo día del mes siguiente (un 31 se recorre al último día).
 */
export function nextOccurrence(from: number, every: Frequency): number {
  if (every === "semanal") return from + 7 * DAY;
  if (every === "quincenal") return from + 15 * DAY;
  const local = new Date(from - OFFSET);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(local.getUTCDate(), lastDay);
  return (
    Date.UTC(year, month, day, local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()) + OFFSET
  );
}

/** "15 dic": una fecha corta en hora de México. */
export function shortDate(at: number): string {
  const local = new Date(at - OFFSET);
  return `${local.getUTCDate()} ${(MONTHS[local.getUTCMonth()] ?? "").slice(0, 3)}`;
}

/** "15 dic 12:03". */
export function shortDateTime(at: number): string {
  const local = new Date(at - OFFSET);
  const time = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  return `${shortDate(at)} ${time}`;
}
