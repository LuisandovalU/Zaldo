/** Pesos con centavos enteros. Pey habla en pesos; aquí no hay flotantes sueltos. */

export function parsePesosToCents(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
    return parsePesosToCents(text);
  }
  if (typeof value !== "string") return null;
  let text = value.trim().replace(/[$\s]/g, "");
  if (text.includes(",") && text.includes(".")) text = text.replace(/,/g, "");
  else if (/^\d+,\d{1,2}$/.test(text)) text = text.replace(",", ".");
  else text = text.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const cents = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 100_000_000) return null;
  return cents;
}

export function centsToPesos(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

export function formatMxn(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const pesos = Math.floor(abs / 100);
  const centsPart = String(abs % 100).padStart(2, "0");
  const grouped = pesos.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}.${centsPart}`;
}

/** Medianoche en Ciudad de México. Desde 2022 no hay horario de verano: UTC−6. */
export function mexicoDayStart(now: number): number {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(now));
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 6, 0, 0, 0);
}
