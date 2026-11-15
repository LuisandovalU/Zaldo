import type { PeyTransaction } from "../pey.js";
import type { Charge, Store } from "../store.js";

export interface PeyReader {
  transactionsByApiKey(nextToken?: string): Promise<{ items: PeyTransaction[]; nextToken: string | null }>;
  transaction?(id: string): Promise<PeyTransaction | null>;
}

/** Lo que Pey dice que cobró, en centavos, sumando solo las pagadas. */
export interface PeyTotals {
  paidCents: number;
  paidCount: number;
  pendingCents: number;
  pendingCount: number;
  /** Comisiones que Pey ya descontó. Zaldo no las guarda; aquí sí se ven. */
  feeCents: number;
  tipCents: number;
  /** Pagado menos comisión: lo que de verdad llega a la cuenta. */
  netCents: number;
  byMethod: { codi: number; card: number };
  byPayable: { link: number; qr: number; pn: number };
}

export type MismatchKind =
  | "pagado_en_pey_no_en_zaldo"
  | "pagado_en_zaldo_no_en_pey"
  | "monto_distinto"
  | "sin_cobro_local";

export interface Mismatch {
  kind: MismatchKind;
  /** Qué hacer, en una línea, en español. */
  detail: string;
  chargeId: string | null;
  transactionId: string | null;
  amountCents: number;
}

export interface Reconciliation {
  /** Momento en que se consultó a Pey. */
  fetchedAt: number;
  /** Transacciones leídas de Pey, lo más nuevo primero. */
  transactions: PeyTransaction[];
  totals: PeyTotals;
  mismatches: Mismatch[];
  /** true si quedaron páginas sin leer por el tope de páginas. */
  truncated: boolean;
  /** Mensaje de error si Pey no respondió. El panel sigue mostrando lo local. */
  error: string | null;
}

export function sumTotals(transactions: PeyTransaction[]): PeyTotals {
  const totals: PeyTotals = {
    paidCents: 0,
    paidCount: 0,
    pendingCents: 0,
    pendingCount: 0,
    feeCents: 0,
    tipCents: 0,
    netCents: 0,
    byMethod: { codi: 0, card: 0 },
    byPayable: { link: 0, qr: 0, pn: 0 },
  };
  for (const tx of transactions) {
    if (tx.status === "PAID") {
      totals.paidCents += tx.amountCents;
      totals.paidCount += 1;
      totals.feeCents += tx.breakdown?.feeCents ?? 0;
      totals.tipCents += tx.breakdown?.tipCents ?? 0;
      if (tx.paymentMethod === "CODI") totals.byMethod.codi += tx.amountCents;
      else if (tx.paymentMethod === "CARD") totals.byMethod.card += tx.amountCents;
      if (tx.payableType === "PAYMENT_LINK") totals.byPayable.link += tx.amountCents;
      else if (tx.payableType === "API_CODI_QR") totals.byPayable.qr += tx.amountCents;
      else if (tx.payableType === "API_CODI_PN") totals.byPayable.pn += tx.amountCents;
    } else {
      totals.pendingCents += tx.amountCents;
      totals.pendingCount += 1;
    }
  }
  totals.netCents = totals.paidCents - totals.feeCents;
  return totals;
}

/**
 * Empareja cada transacción de Pey con su cobro local. Primero por
 * metadata.chargeId, que Zaldo manda en los tres endpoints de creación;
 * si no viene, por el id de la transacción o del payable que guardamos.
 */
function findCharge(charges: Charge[], tx: PeyTransaction): Charge | null {
  if (tx.chargeId) {
    const byMetadata = charges.find((charge) => charge.id === tx.chargeId);
    if (byMetadata) return byMetadata;
  }
  return (
    charges.find((charge) => charge.peyTransactionId === tx.id) ??
    charges.find((charge) => !!tx.payableId && charge.peyExternalId === tx.payableId) ??
    null
  );
}

export function findMismatches(charges: Charge[], transactions: PeyTransaction[]): Mismatch[] {
  const out: Mismatch[] = [];
  const matchedIds = new Set<string>();

  for (const tx of transactions) {
    const charge = findCharge(charges, tx);
    if (!charge) {
      // Cobro que entró por fuera de Zaldo, o de una key compartida.
      if (tx.status === "PAID") {
        out.push({
          kind: "sin_cobro_local",
          detail: `Pey cobró ${(tx.amountCents / 100).toFixed(2)} y no hay cobro de Zaldo que lo explique.`,
          chargeId: null,
          transactionId: tx.id,
          amountCents: tx.amountCents,
        });
      }
      continue;
    }
    matchedIds.add(charge.id);
    if (tx.status === "PAID" && charge.status !== "paid") {
      out.push({
        kind: "pagado_en_pey_no_en_zaldo",
        detail: `Pey lo marca pagado y Zaldo lo tiene como "${charge.status}". Probablemente se perdió el webhook.`,
        chargeId: charge.id,
        transactionId: tx.id,
        amountCents: tx.amountCents,
      });
    }
    if (tx.status === "PAID" && tx.amountCents !== charge.amountCents) {
      out.push({
        kind: "monto_distinto",
        detail: `Zaldo esperaba ${(charge.amountCents / 100).toFixed(2)} y Pey cobró ${(tx.amountCents / 100).toFixed(2)}.`,
        chargeId: charge.id,
        transactionId: tx.id,
        amountCents: tx.amountCents,
      });
    }
  }

  for (const charge of charges) {
    if (charge.status !== "paid" || matchedIds.has(charge.id)) continue;
    // Solo avisamos de los que deberían aparecer en las páginas que leímos.
    out.push({
      kind: "pagado_en_zaldo_no_en_pey",
      detail: "Zaldo lo tiene pagado y no apareció en las transacciones leídas de Pey.",
      chargeId: charge.id,
      transactionId: charge.peyTransactionId,
      amountCents: charge.amountCents,
    });
  }

  return out;
}

export interface ReconcileOptions {
  /** Páginas de 80 que como máximo pedimos a Pey. */
  maxPages?: number;
  /** No miramos más atrás de esto. Por defecto, 60 días. */
  sinceMs?: number;
}

/**
 * Lee las transacciones de Pey y las cruza con el libro. Si Pey falla,
 * devuelve el error dentro del resultado: el panel nunca se cae por esto.
 */
export async function reconcile(
  pey: PeyReader,
  store: Store,
  now: number,
  options: ReconcileOptions = {},
): Promise<Reconciliation> {
  const maxPages = Math.max(1, options.maxPages ?? 5);
  const since = now - (options.sinceMs ?? 60 * 86_400_000);
  const transactions: PeyTransaction[] = [];
  let truncated = false;
  let error: string | null = null;

  try {
    let token: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await pey.transactionsByApiKey(token);
      transactions.push(...result.items);
      // Las páginas vienen de lo más nuevo a lo más viejo: al cruzar la
      // ventana ya no hace falta seguir pidiendo.
      const oldest = result.items.at(-1);
      const reachedWindow = oldest?.dateCreated !== null && (oldest?.dateCreated ?? now) < since;
      if (!result.nextToken || reachedWindow) {
        truncated = !!result.nextToken && !reachedWindow;
        token = undefined;
        break;
      }
      token = result.nextToken;
      if (page === maxPages - 1) truncated = true;
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Pey no respondió";
  }

  const inWindow = transactions.filter((tx) => (tx.dateCreated ?? now) >= since);
  const charges = store.listCharges().filter((charge) => charge.createdAt >= since);

  return {
    fetchedAt: now,
    transactions: inWindow,
    totals: sumTotals(inWindow),
    mismatches: error ? [] : findMismatches(charges, inWindow),
    truncated,
    error,
  };
}

/**
 * Guarda el último cruce unos segundos. El panel se carga varias veces
 * seguidas mientras se revisa algo y no hace falta pegarle a Pey cada vez.
 */
export class ReconcileCache {
  private value: Reconciliation | null = null;
  private inflight: Promise<Reconciliation> | null = null;

  constructor(
    /** Público: la reparación vuelve a preguntarle a Pey con este mismo lector. */
    readonly pey: PeyReader,
    private readonly store: Store,
    private readonly ttlMs = 60_000,
    private readonly options: ReconcileOptions = {},
  ) {}

  /** force salta la caché: es el botón «Actualizar» del panel. */
  get(now: number, force = false): Promise<Reconciliation> {
    if (!force && this.value && now - this.value.fetchedAt < this.ttlMs) {
      return Promise.resolve(this.value);
    }
    // Varias cargas a la vez comparten una sola llamada a Pey.
    if (this.inflight) return this.inflight;
    const run = reconcile(this.pey, this.store, now, this.options)
      .then((result) => {
        // Un fallo de Pey no borra el último cruce bueno que ya teníamos.
        if (!result.error || !this.value) this.value = result;
        else this.value = { ...this.value, error: result.error };
        return this.value;
      })
      .finally(() => {
        this.inflight = null;
      });
    this.inflight = run;
    return run;
  }

  /** La reparación invalida el cruce: lo siguiente que se vea ya es lo nuevo. */
  invalidate(): void {
    this.value = null;
  }
}

export type RepairOutcome =
  | { ok: true; chargeId: string; amountCents: number; paidAt: number }
  | { ok: false; reason: string };

/**
 * Pone el cobro local en el estado que Pey reporta. Solo sirve para el caso
 * del webhook perdido: Pey dice PAID y Zaldo no. No llama a Pey para crear
 * nada, no manda WhatsApp y no toca el dinero; únicamente corrige el libro.
 */
export async function repairCharge(
  pey: PeyReader,
  store: Store,
  chargeId: string,
  transactionId: string,
  now: number,
): Promise<RepairOutcome> {
  const charge = store.getCharge(chargeId);
  if (!charge) return { ok: false, reason: "Ese cobro ya no está en el libro." };
  if (charge.status === "paid") return { ok: false, reason: "Ese cobro ya estaba pagado." };
  if (!pey.transaction) return { ok: false, reason: "No puedo consultar transacciones de Pey." };

  let tx: PeyTransaction | null;
  try {
    // Preguntamos de nuevo a Pey: nunca marcamos pagado por lo que diga el form.
    tx = await pey.transaction(transactionId);
  } catch (cause) {
    return { ok: false, reason: cause instanceof Error ? cause.message : "Pey no respondió." };
  }
  if (!tx) return { ok: false, reason: "Pey no conoce esa transacción." };
  if (tx.status !== "PAID") return { ok: false, reason: "Pey no la tiene como pagada." };

  // La transacción tiene que ser de este cobro, no de otro.
  const belongs =
    tx.chargeId === charge.id ||
    charge.peyTransactionId === tx.id ||
    (!!tx.payableId && charge.peyExternalId === tx.payableId);
  if (!belongs) return { ok: false, reason: "Esa transacción no corresponde a ese cobro." };

  const paidAt = tx.datePaid ?? now;
  store.updateCharge({
    ...charge,
    status: "paid",
    paidAt,
    peyTransactionId: charge.peyTransactionId ?? tx.id,
    // Ya avisamos nosotros en el panel; no reabrimos el aviso de WhatsApp.
    paidNoticeSent: true,
  });
  return { ok: true, chargeId: charge.id, amountCents: tx.amountCents, paidAt };
}
