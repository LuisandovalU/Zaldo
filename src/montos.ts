/**
 * Leer montos como los escribe la gente, y decidir si una cifra "sale" de lo
 * que la persona dijo.
 *
 * La caja no deja pasar un monto que el modelo se inventó. Pero la gente no
 * siempre escribe el total: dice "2.5k", "15 mil", "1 500", "el doble", "150
 * más 20 de envío", "con 10% de descuento", "100 por persona y somos 4". Aquí
 * se leen esas formas y se comprueba que el monto del cobro se pueda obtener
 * con una cuenta sencilla sobre los números que sí se dijeron.
 */

/** Pesos (150.5) a centavos, redondeando. null si no es un monto cobrable. */
function cents(pesos: number): number | null {
  if (!Number.isFinite(pesos) || pesos <= 0) return null;
  const value = Math.round(pesos * 100);
  return value > 0 && value <= 100_000_000 ? value : null;
}

const MULTIPLIER = /^\s*(k\b|mil(?:es)?\b|mill[oó]n(?:es)?\b|millones\b)/i;

/**
 * Las lecturas posibles, en pesos, de un número escrito. "1,500" es mil
 * quinientos; "1.500" casi siempre también (así se escribe en media
 * Latinoamérica), aunque podría ser uno cincuenta: se devuelven las dos, la
 * más probable primero.
 */
export function readings(raw: string): number[] {
  const text = raw.replace(/^\$\s*/, "").trim();
  if (!text) return [];
  // 1 500 · 12 000 000
  if (/^\d{1,3}( \d{3})+$/.test(text)) return [Number(text.replace(/ /g, ""))];
  // 1,500 · 1,500.50
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) return [Number(text.replace(/,/g, ""))];
  // 1.500 · 15.000 · 1.500,50
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(text)) {
    const thousands = Number(text.replace(/\./g, "").replace(",", "."));
    const plain = /^\d+\.\d{3}$/.test(text) ? Number(text) : null;
    return plain !== null && plain !== thousands ? [thousands, plain] : [thousands];
  }
  // 150,50
  if (/^\d+,\d{1,2}$/.test(text)) return [Number(text.replace(",", "."))];
  // 150 · 150.5 · .50
  if (/^\d*\.?\d+$/.test(text)) return [Number(text)];
  return [];
}

export interface Mention {
  /** Lecturas en pesos, la más probable primero. */
  values: number[];
  /** Se dijo como dinero: con $, con "pesos", con decimales o con "k"/"mil". */
  money: boolean;
  /** Es un porcentaje ("10%", "10 por ciento"). */
  percent: boolean;
}

const NUMBER = /\$?\s*(?:\d{1,3}(?: \d{3})+(?!\d)|\d[\d.,]*\d|\d|\.\d+)/g;

/** Todos los números de un texto, con cómo se dijeron. Los celulares y las CLABE no cuentan. */
export function mentions(text: string): Mention[] {
  const found: Mention[] = [];
  const clean = text.replace(/\d{1,2}\s*centavos?/gi, " ");
  for (const match of clean.matchAll(NUMBER)) {
    const raw = match[0].trim().replace(/[.,]+$/, "");
    const digits = raw.replace(/\D/g, "");
    // Un celular (10 dígitos), una CLABE o cualquier ristra larga sin separadores no es un monto.
    if (digits.length >= 8 && !/[.,$ ]/.test(raw.replace(/^\$\s*/, ""))) continue;
    let values = readings(raw);
    if (!values.length) continue;
    const after = clean.slice((match.index ?? 0) + match[0].length);
    const before = clean.slice(0, match.index ?? 0);
    const multiplier = MULTIPLIER.exec(after);
    let money = raw.startsWith("$") || /[.,]\d{1,2}$/.test(raw) || /^\s*(pesos?|varos?|bolas?|mxn|m\.n\.)\b/i.test(after);
    if (multiplier) {
      const word = (multiplier[1] ?? "").toLowerCase();
      const factor = word.startsWith("mill") ? 1_000_000 : 1_000;
      // "2.5k" es dos mil quinientos: aquí el punto es decimal, no de miles.
      const base = /^\d+[.,]\d{1,2}$/.test(raw.replace(/^\$\s*/, "")) ? [Number(raw.replace(/^\$\s*/, "").replace(",", "."))] : values;
      values = base.map((value) => value * factor);
      money = true;
    }
    const percent = /^\s*(%|por ?ciento)/i.test(after);
    if (/medio\s*$/i.test(before) && multiplier) values = values.map((value) => value / 2);
    found.push({ values, money: money && !percent, percent });
  }
  // "medio millón", "medio kilo" no: solo el millón.
  if (/\bmedio mill[oó]n\b/i.test(text) && !found.some((item) => item.values.includes(500_000))) {
    found.push({ values: [500_000], money: true, percent: false });
  }
  // "50 centavos": se leen aparte para no confundirlos con 50 pesos.
  for (const match of text.matchAll(/(\d{1,2})\s*centavos?/gi)) {
    found.push({ values: [Number(match[1]) / 100], money: true, percent: false });
  }
  return found;
}

/** "150 pesos con 50 centavos" son 150.50: los centavos que vienen pegados a un monto en pesos. */
function joined(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(/(\d[\d.,]*)\s*pesos?\s*(?:con|y)\s*(\d{1,2})\s*centavos?/gi)) {
    const pesos = readings((match[1] ?? "").replace(/[.,]+$/, ""))[0];
    if (pesos !== undefined) out.push(pesos + Number(match[2]) / 100);
  }
  return out;
}

/** ¿La persona escribió ese monto, en cualquiera de sus formas? */
export function saidAmount(texts: string[], amountCents: number): boolean {
  for (const text of texts) {
    for (const pesos of joined(text)) if (cents(pesos) === amountCents) return true;
    for (const item of mentions(text)) {
      if (item.percent) continue;
      if (item.values.some((value) => cents(value) === amountCents)) return true;
    }
  }
  return false;
}

/**
 * El único monto que la persona escribió como dinero en un mensaje, en
 * centavos. null si no hay ninguno o si hay más de uno (no se adivina cuál).
 */
export function soleMoney(text: string): number | null {
  const found = new Set<number>();
  for (const pesos of joined(text)) {
    const value = cents(pesos);
    if (value !== null) found.add(value);
  }
  if (found.size === 1) return [...found][0] ?? null;
  for (const item of mentions(text)) {
    if (!item.money) continue;
    const value = cents(item.values[0] ?? NaN);
    if (value !== null) found.add(value);
  }
  return found.size === 1 ? ([...found][0] ?? null) : null;
}

/** "150 o 200": dos montos entre los que la persona duda. */
export function eitherOr(text: string): [number, number] | null {
  const match = /(\$?\s*\d[\d.,]*)\s*(?:pesos\s*)?\bo\b\s*(?:como\s*|de\s*)?(\$?\s*\d[\d.,]*)/i.exec(text);
  if (!match) return null;
  const a = cents(readings((match[1] ?? "").trim().replace(/[.,]+$/, ""))[0] ?? NaN);
  const b = cents(readings((match[2] ?? "").trim().replace(/[.,]+$/, ""))[0] ?? NaN);
  return a !== null && b !== null && a !== b ? [a, b] : null;
}

const FOREIGN = /\b(d[oó]lar(es)?|dls?|usd|euros?|eur|libras?|yenes?|bitcoin|btc|usdt)\b/i;

/** Zaldo cobra en pesos: "150 dls" no son 150 pesos. */
export function foreignCurrency(text: string): boolean {
  return FOREIGN.test(text);
}

/** Palabras que piden una cuenta sobre lo ya dicho o lo ya cobrado. */
const REFERS = /doble|triple|mitad|medio|s[uú]bele|b[aá]jale|qu[ií]tale|agr[eé]gale|m[aá]s|menos|descuento|rebaja|propina|env[ií]o|iva\b|%|por ?ciento|cada un[oa]|c\/u|por persona|por cabeza|entre\b|anticipo|resto|falta|lo mismo|igual|otro/i;

/**
 * ¿Se llega a ese monto con una cuenta sencilla sobre los números que dijo la
 * persona? `extras` son cifras del libro que también cuentan si el mensaje se
 * refiere a ellas (el cobro anterior, el total del ticket), en pesos.
 */
export function derivable(amountCents: number, texts: string[], extras: number[] = []): boolean {
  const text = texts.join(" \n ");
  const refers = REFERS.test(text);
  const bases: number[] = [];
  const percents: number[] = [];
  for (const item of texts.flatMap((part) => mentions(part))) {
    if (item.percent) percents.push(item.values[0] ?? 0);
    else bases.push(...item.values);
  }
  if (/\biva\b/i.test(text)) percents.push(16);
  if (refers) bases.push(...extras);
  const numbers = [...new Set(bases.filter((value) => Number.isFinite(value) && value > 0))].slice(0, 10);
  if (!numbers.length) return false;
  const hit = (pesos: number) => {
    const value = cents(pesos);
    return value !== null && Math.abs(value - amountCents) <= 1;
  };
  const withPercents = (value: number) =>
    percents.some((p) => hit((value * p) / 100) || hit(value * (1 + p / 100)) || hit(value * (1 - p / 100)));
  for (const a of numbers) {
    if (hit(a) || withPercents(a)) return true;
    if (/doble/i.test(text) && hit(a * 2)) return true;
    if (/triple/i.test(text) && hit(a * 3)) return true;
    if (/mitad|medio/i.test(text) && hit(a / 2)) return true;
  }
  if (numbers.length >= 2 && hit(numbers.reduce((sum, value) => sum + value, 0))) return true;
  for (const a of numbers) {
    for (const b of numbers) {
      if (a === b && numbers.filter((value) => value === a).length < 2) continue;
      for (const value of [a + b, a - b, a * b, b !== 0 ? a / b : NaN]) {
        if (hit(value) || withPercents(value)) return true;
      }
    }
  }
  // "2 cortes a 150 más 50 de envío": una multiplicación y una suma.
  if (numbers.length >= 3) {
    for (const a of numbers) for (const b of numbers) for (const c of numbers) {
      if (a === b || b === c || a === c) continue;
      if (hit(a * b + c) || hit(a * b - c)) return true;
    }
  }
  return false;
}
