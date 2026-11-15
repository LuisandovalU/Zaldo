import { createHmac } from "node:crypto";
import { mexicoDayStart } from "../money.js";
import type { Charge, ChargeMethod, ChargeStatus, Contact, Note, Store } from "../store.js";

export interface Metrics {
  /** Cobrado y confirmado hoy (pendiente + pagado), en centavos. */
  todayCents: number;
  /** De eso, lo que ya se pagó. */
  todayPaidCents: number;
  /** Tope diario configurado, para pintar la barra. */
  capCents: number;
  pendingCount: number;
  pendingCents: number;
  paidCount: number;
  paidCents: number;
  expiredCount: number;
  failedCount: number;
  ownersCount: number;
  /** Pagados sobre el total que llegó a Pey, en porcentaje. */
  conversionPct: number | null;
}

export interface Filters {
  owner?: string;
  status?: ChargeStatus;
  method?: ChargeMethod;
  /** Busca en concepto, nombre del pagador, referencia o id. */
  q?: string;
  page: number;
  perPage: number;
}

export interface ChargePage {
  rows: Charge[];
  total: number;
  page: number;
  perPage: number;
  pages: number;
}

const CONFIRMED: ChargeStatus[] = ["pending", "paid"];

export function computeMetrics(charges: Charge[], now: number, capCents: number): Metrics {
  const dayStart = mexicoDayStart(now);
  const owners = new Set<string>();
  let todayCents = 0;
  let todayPaidCents = 0;
  let pendingCount = 0;
  let pendingCents = 0;
  let paidCount = 0;
  let paidCents = 0;
  let expiredCount = 0;
  let failedCount = 0;
  let reachedPey = 0;

  for (const charge of charges) {
    owners.add(charge.owner);
    const confirmed = CONFIRMED.includes(charge.status);
    if (confirmed) reachedPey += 1;
    if (charge.createdAt >= dayStart && confirmed) {
      todayCents += charge.amountCents;
      if (charge.status === "paid") todayPaidCents += charge.amountCents;
    }
    if (charge.status === "pending") {
      pendingCount += 1;
      pendingCents += charge.amountCents;
    } else if (charge.status === "paid") {
      paidCount += 1;
      paidCents += charge.amountCents;
    } else if (charge.status === "expired") {
      expiredCount += 1;
    } else if (charge.status === "failed") {
      failedCount += 1;
    }
  }

  // Sumamos los vencidos: también llegaron a Pey y no se pagaron.
  reachedPey += expiredCount;

  return {
    todayCents,
    todayPaidCents,
    capCents,
    pendingCount,
    pendingCents,
    paidCount,
    paidCents,
    expiredCount,
    failedCount,
    ownersCount: owners.size,
    conversionPct: reachedPey === 0 ? null : Math.round((paidCount / reachedPey) * 100),
  };
}

/** Serie de los últimos días: cuánto se confirmó y cuánto se pagó cada día. */
export interface DayPoint {
  /** Medianoche en México, en epoch ms. */
  dayStart: number;
  label: string;
  confirmedCents: number;
  paidCents: number;
}

export function dailySeries(charges: Charge[], now: number, days = 14): DayPoint[] {
  const DAY = 86_400_000;
  const today = mexicoDayStart(now);
  const buckets = new Map<number, DayPoint>();
  const formatter = new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Mexico_City",
    day: "2-digit",
    month: "short",
  });
  for (let index = days - 1; index >= 0; index--) {
    const dayStart = today - index * DAY;
    buckets.set(dayStart, {
      dayStart,
      label: formatter.format(new Date(dayStart)),
      confirmedCents: 0,
      paidCents: 0,
    });
  }
  const oldest = today - (days - 1) * DAY;
  for (const charge of charges) {
    if (!CONFIRMED.includes(charge.status) && charge.status !== "expired") continue;
    if (charge.createdAt < oldest) continue;
    const dayStart = mexicoDayStart(charge.createdAt);
    const bucket = buckets.get(dayStart);
    if (!bucket) continue;
    if (CONFIRMED.includes(charge.status)) bucket.confirmedCents += charge.amountCents;
    if (charge.status === "paid") bucket.paidCents += charge.amountCents;
  }
  return [...buckets.values()];
}

function matchesQuery(charge: Charge, needle: string): boolean {
  const haystack = [
    charge.concept,
    charge.payerName,
    charge.payerPhone ?? "",
    charge.numRef ?? "",
    charge.id,
    charge.peyTransactionId ?? "",
  ]
    .join(" ")
    .toLocaleLowerCase("es-MX");
  return haystack.includes(needle);
}

export function filterCharges(charges: Charge[], filters: Filters): ChargePage {
  const needle = filters.q?.trim().toLocaleLowerCase("es-MX") ?? "";
  const matched = charges.filter((charge) => {
    if (filters.owner && charge.owner !== filters.owner) return false;
    if (filters.status && charge.status !== filters.status) return false;
    if (filters.method && charge.method !== filters.method) return false;
    if (needle && !matchesQuery(charge, needle)) return false;
    return true;
  });
  // Lo más nuevo primero: es lo que un admin quiere ver al entrar.
  matched.sort((a, b) => b.createdAt - a.createdAt);
  const perPage = Math.min(Math.max(filters.perPage, 1), 200);
  const pages = Math.max(1, Math.ceil(matched.length / perPage));
  const page = Math.min(Math.max(filters.page, 1), pages);
  const start = (page - 1) * perPage;
  return {
    rows: matched.slice(start, start + perPage),
    total: matched.length,
    page,
    perPage,
    pages,
  };
}

export interface OwnerSummary {
  owner: string;
  charges: number;
  paidCents: number;
  pendingCents: number;
  lastActivity: number;
  contacts: number;
  notes: number;
}

export function ownerSummaries(store: Store, charges: Charge[]): OwnerSummary[] {
  const map = new Map<string, OwnerSummary>();
  for (const charge of charges) {
    const entry =
      map.get(charge.owner) ??
      {
        owner: charge.owner,
        charges: 0,
        paidCents: 0,
        pendingCents: 0,
        lastActivity: 0,
        contacts: 0,
        notes: 0,
      };
    entry.charges += 1;
    if (charge.status === "paid") entry.paidCents += charge.amountCents;
    if (charge.status === "pending") entry.pendingCents += charge.amountCents;
    entry.lastActivity = Math.max(entry.lastActivity, charge.paidAt ?? charge.createdAt);
    map.set(charge.owner, entry);
  }
  for (const entry of map.values()) {
    entry.contacts = store.listContacts(entry.owner).length;
    entry.notes = store.listNotes(entry.owner).length;
  }
  return [...map.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

export interface OwnerDetail {
  owner: string;
  charges: Charge[];
  notes: Note[];
  contacts: Contact[];
}

export function ownerDetail(store: Store, owner: string): OwnerDetail {
  return {
    owner,
    charges: store.listCharges(owner).sort((a, b) => b.createdAt - a.createdAt),
    notes: store.listNotes(owner).sort((a, b) => b.createdAt - a.createdAt),
    contacts: store.listContacts(owner).sort((a, b) => a.name.localeCompare(b.name, "es-MX")),
  };
}

/** Filas del CSV. El admin se lleva lo que ve, sin tocar el JSON a mano. */
export function chargesToCsv(charges: Charge[]): string {
  const header = [
    "id",
    "owner",
    "payerName",
    "payerPhone",
    "amountMxn",
    "concept",
    "method",
    "status",
    "numRef",
    "peyTransactionId",
    "createdAt",
    "paidAt",
  ];
  const cell = (value: unknown): string => {
    const text = value === null || value === undefined ? "" : String(value);
    // Una celda que empieza por =,+,-,@ la interpretaría Excel como fórmula.
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const iso = (value: number | null): string => (value === null ? "" : new Date(value).toISOString());
  const lines = [header.join(",")];
  for (const charge of charges) {
    lines.push(
      [
        cell(charge.id),
        cell(charge.owner),
        cell(charge.payerName),
        cell(charge.payerPhone),
        cell((charge.amountCents / 100).toFixed(2)),
        cell(charge.concept),
        cell(charge.method),
        cell(charge.status),
        cell(charge.numRef),
        cell(charge.peyTransactionId),
        cell(iso(charge.createdAt)),
        cell(iso(charge.paidAt)),
      ].join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * Identificador corto y opaco para las URL del panel. El celular del dueño
 * no debe viajar en un href: queda en el historial del navegador y en los
 * logs del proxy. Es un HMAC truncado, estable mientras no cambie el secreto.
 */
export function ownerRef(owner: string, secret: string): string {
  return createHmac("sha256", secret).update(owner).digest("hex").slice(0, 16);
}

/** Resuelve el ref de vuelta al celular, buscando entre los dueños conocidos. */
export function ownerFromRef(store: Store, ref: string, secret: string): string | null {
  const clean = ref.trim().toLowerCase();
  if (!/^[0-9a-f]{16}$/.test(clean)) return null;
  const owners = new Set(store.listCharges().map((charge) => charge.owner));
  for (const owner of owners) {
    if (ownerRef(owner, secret) === clean) return owner;
  }
  return null;
}
