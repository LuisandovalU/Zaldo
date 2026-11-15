/**
 * Los cobros recurrentes de una persona: encontrarlos por como los nombra
 * ("el de Ana", "el mío", un celular), cambiarlos, cancelarlos, retomarlos y
 * listarlos. Todo sobre el libro: desde aquí no sale ningún cobro.
 */
import { frequencyLabel, nextOccurrence, shortDate } from "./caja.js";
import { formatMxn } from "./money.js";
import { toTenDigits } from "./phone.js";
import { fold, type Frequency, type Recurring, type Store } from "./store.js";

/** Los mismos literales que usa agent.ts (no se importan de ahí para no hacer un ciclo). */
const PAYER_SELF = "ti";
const DEFAULT_CONCEPT = "Cobro";
const MAX_CENTS = 100_000_000;

/**
 * Lo que distingue a un plan de otro: a quién, cada cuándo y por qué. "500 de
 * renta cada mes" y "200 de internet cada mes" a Ana son dos planes, no uno.
 */
export function planKey(plan: { payerPhone: string; every: Frequency; concept: string }): string {
  return `${plan.payerPhone}|${plan.every}|${fold(plan.concept)}`;
}

const LEAD = /^(a|al|de|del|para|con)\s+/;
const SELF = /^(yo|mi|mi mismo|mi misma|ti|conmigo|me|mio|el mio|mi celular|mi numero)$/;
const NUMERIC = /^[\d\s+().-]+$/;
const TITLES = new Set([
  "el", "la", "los", "las", "mi", "don", "dona", "senor", "senora", "senorita", "sr", "sra", "srita", "profe",
  "doctor", "doctora", "dr", "dra",
]);

function nameWords(value: string): string[] {
  return fold(value)
    .split(/[^a-z0-9ñ]+/)
    .filter((word) => word && !TITLES.has(word));
}

/** ¿`who` nombra a quien paga ese plan? Por celular, por "yo" / "a mí", o por nombre. */
function names(store: Store, owner: string, who: string, plan: Recurring): boolean {
  const key = fold(String(who ?? "")).replace(LEAD, "");
  if (!key) return false;
  if (NUMERIC.test(key)) {
    const phone = toTenDigits(key);
    return !!phone && plan.payerPhone === phone;
  }
  if (SELF.test(key)) {
    const mine = toTenDigits(store.getProfile(owner).phone);
    return plan.payerName === PAYER_SELF || (!!mine && plan.payerPhone === mine);
  }
  if (fold(plan.payerName) === key) return true;
  // "María" encuentra a "la señora María", y "Ana López" a "Ana".
  const words = nameWords(key);
  const name = nameWords(plan.payerName);
  return (
    words.length > 0 &&
    name.length > 0 &&
    (name.every((word) => words.includes(word)) || words.every((word) => name.includes(word)))
  );
}

/**
 * Los planes activos de ese cliente. `who` puede ser su nombre (sin importar
 * acentos ni mayúsculas, con o sin "la señora"), su celular, o "yo" / "a mí"
 * para el que la persona se cobra a sí misma.
 */
export function findRecurrings(store: Store, owner: string, who: string): Recurring[] {
  const active = store.listRecurrings(owner).filter((plan) => plan.active);
  const key = fold(String(who ?? "")).replace(LEAD, "");
  // Si el nombre coincide tal cual, ese es: "Ana" no se lleva también a "Ana López".
  const exact = active.filter((plan) => fold(plan.payerName) === key);
  if (exact.length && !NUMERIC.test(key) && !SELF.test(key)) return exact;
  return active.filter((plan) => names(store, owner, who, plan));
}

function conceptTail(plan: Recurring): string {
  return plan.concept === DEFAULT_CONCEPT ? "" : ` · ${plan.concept}`;
}

function planLine(plan: Recurring, now?: number): string {
  const name = plan.payerName === PAYER_SELF ? "Tú" : plan.payerName;
  const next = now !== undefined && plan.nextAt <= now ? "hoy" : shortDate(plan.nextAt);
  const retry = plan.failures ? " · reintentando" : "";
  return `${name} · ${formatMxn(plan.amountCents)} ${frequencyLabel(plan.every)} · ${plan.concept} · siguiente ${next}${retry}`;
}

/** Una línea por cada cobro recurrente activo, el que toca primero arriba. Vacío si no hay. */
export function recurringLines(store: Store, owner: string, now: number): string[] {
  return store
    .listRecurrings(owner)
    .filter((plan) => plan.active)
    .sort((a, b) => a.nextAt - b.nextAt)
    .map((plan) => planLine(plan, now));
}

/** Los planes de los que se habla: los de ese cliente o, si no dijo de quién, todos los activos. */
function pick(store: Store, owner: string, who: string, concept?: string): Recurring[] {
  const named = fold(String(who ?? ""));
  let plans = named ? findRecurrings(store, owner, who) : store.listRecurrings(owner).filter((plan) => plan.active);
  const about = concept ? fold(concept) : "";
  if (plans.length > 1 && about) {
    const narrowed = plans.filter((plan) => fold(plan.concept).includes(about));
    if (narrowed.length) plans = narrowed;
  }
  return plans;
}

const NONE = 'No hay un cobro recurrente activo con ese cliente. Para ver los que tienes dime "mis cobros recurrentes".';

/**
 * Cambia el monto o la frecuencia de un cobro recurrente. No manda nada: el
 * próximo periodo sale con lo nuevo. `concept` no se cambia: sirve para decir
 * cuál, cuando ese cliente tiene más de un plan.
 */
export function updateRecurring(
  store: Store,
  owner: string,
  now: number,
  change: { who: string; amountCents?: number; every?: Frequency; concept?: string },
): { ok: boolean; text: string } {
  const plans = pick(store, owner, change.who, change.concept);
  if (!plans.length) return { ok: false, text: NONE };
  if (plans.length > 1) {
    return {
      ok: false,
      text: ["Hay más de un cobro recurrente ahí. ¿Cuál cambio?", ...plans.map((plan) => planLine(plan, now))].join("\n"),
    };
  }
  const plan = plans[0] as Recurring;
  const amount = change.amountCents;
  if (amount !== undefined && (!Number.isInteger(amount) || amount <= 0 || amount > MAX_CENTS)) {
    return { ok: false, text: "Ese monto no se puede cobrar: tiene que ser mayor a cero y de máximo $1,000,000.00." };
  }
  const every = change.every ?? plan.every;
  const amountCents = amount ?? plan.amountCents;
  if (every === plan.every && amountCents === plan.amountCents) {
    return { ok: false, text: `Ese cobro recurrente ya está así: ${planLine(plan, now)}.` };
  }
  const twin = store
    .listRecurrings(owner)
    .find((other) => other.active && other.id !== plan.id && planKey(other) === planKey({ ...plan, every }));
  if (twin) {
    return { ok: false, text: `Ya hay otro cobro recurrente igual: ${planLine(twin, now)}. Cancela uno de los dos primero.` };
  }
  // Con otra frecuencia, el siguiente no se aleja: sale en la fecha que ya tocaba o antes.
  const nextAt = every === plan.every ? plan.nextAt : Math.min(plan.nextAt, nextOccurrence(now, every));
  store.upsertRecurring({ ...plan, amountCents, every, nextAt });
  const whom = plan.payerName === PAYER_SELF ? "tu cobro recurrente" : `el cobro recurrente de ${plan.payerName}`;
  return {
    ok: true,
    text: `Listo: ${whom} queda en ${formatMxn(amountCents)} ${frequencyLabel(every)}${conceptTail(plan)}. El siguiente sale el ${shortDate(nextAt)}; ahorita no mandé nada.`,
  };
}

/**
 * Detiene los cobros recurrentes de ese cliente (todos, o el de ese concepto).
 * Sin decir de quién, solo si hay uno. No toca lo que ya se mandó.
 */
export function cancelRecurrings(store: Store, owner: string, who: string, concept?: string): { ok: boolean; text: string } {
  const named = fold(String(who ?? ""));
  const plans = pick(store, owner, who, concept);
  if (!plans.length) return { ok: false, text: NONE };
  if (!named && plans.length > 1) {
    return {
      ok: false,
      text: ["Tienes más de un cobro recurrente. ¿Cuál detengo?", ...plans.map((plan) => planLine(plan))].join("\n"),
    };
  }
  for (const plan of plans) store.upsertRecurring({ ...plan, active: false });
  return {
    ok: true,
    text: plans
      .map((plan) =>
        plan.payerName === PAYER_SELF
          ? `Listo: ya no te cobro a ti ${frequencyLabel(plan.every)} (${formatMxn(plan.amountCents)} · ${plan.concept}).`
          : `Listo: ya no le cobro a ${plan.payerName} ${frequencyLabel(plan.every)} (${formatMxn(plan.amountCents)} · ${plan.concept}).`,
      )
      .join("\n"),
  };
}

/**
 * Retoma un cobro recurrente que se pausó solo (tres periodos sin pagar, o pey
 * sin dejarlo salir) o que se canceló. No manda nada hoy: el siguiente sale en
 * un periodo. Sin decir de quién, retoma el que se detuvo al último.
 */
export function resumeRecurring(store: Store, owner: string, now: number, who: string): { ok: boolean; text: string } {
  const named = fold(String(who ?? ""));
  const stopped = store
    .listRecurrings(owner)
    .filter((plan) => !plan.active && (!named || names(store, owner, who, plan)));
  const plan = stopped[stopped.length - 1];
  if (!plan) return { ok: false, text: "No encontré un cobro recurrente detenido con ese cliente." };
  const twin = store.listRecurrings(owner).find((other) => other.active && planKey(other) === planKey(plan));
  if (twin) return { ok: false, text: `Ese cobro recurrente ya está activo: ${planLine(twin, now)}.` };
  const nextAt = nextOccurrence(now, plan.every);
  const { dueAt: _dueAt, ...rest } = plan;
  store.upsertRecurring({ ...rest, active: true, missed: 0, failures: 0, lastChargeId: null, nextAt });
  const whom = plan.payerName === PAYER_SELF ? "tu cobro recurrente" : `el cobro recurrente de ${plan.payerName}`;
  return {
    ok: true,
    text: `Listo: retomé ${whom}: ${formatMxn(plan.amountCents)} ${frequencyLabel(plan.every)}${conceptTail(plan)}. El siguiente sale el ${shortDate(nextAt)}; ahorita no mandé nada.`,
  };
}
