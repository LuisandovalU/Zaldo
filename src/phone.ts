/** CoDi pide 10 dígitos. WhatsApp manda 521 más esos 10. */

export function toTenDigits(value: string | null | undefined): string | null {
  if (!value) return null;
  let digits = value.replace(/\D/g, "");
  if (digits.startsWith("521") && digits.length === 13) digits = digits.slice(3);
  else if (digits.startsWith("52") && digits.length === 12) digits = digits.slice(2);
  else if (digits.startsWith("1") && digits.length === 11) digits = digits.slice(1);
  if (!/^\d{10}$/.test(digits)) return null;
  return digits;
}

export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const out: string[] = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const phone = toTenDigits(part);
    if (phone && !out.includes(phone)) out.push(phone);
  }
  return out;
}

export function isAllowed(owner: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const phone = toTenDigits(owner);
  return phone !== null && allowlist.includes(phone);
}
