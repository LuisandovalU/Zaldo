import { centsToPesos } from "./money.js";

export interface PushInput {
  amountCents: number;
  phone: string;
  concept: string;
  numRef: string;
  chargeId: string;
  expirationSec: number;
  /** La cuenta que recibe este cobro. Sin ella, la del cliente (PeyClientOptions) o la ligada a la llave. */
  bankAccountId?: string | null;
}

export interface QrInput {
  amountCents: number;
  concept: string;
  numRef: string;
  chargeId: string;
  expirationSec: number;
  bankAccountId?: string | null;
}

export interface LinkInput {
  amountCents: number;
  chargeId: string;
  successUrl: string;
  backUrl: string;
  /** Deja que quien paga agregue propina. */
  hasTip?: boolean;
}

export interface PushResult {
  transactionId: string;
  codiId: string;
}

export interface QrResult {
  id: string;
  qrString: string;
}

export interface LinkResult {
  id: string;
  url: string;
}

/** Desglose que devuelve Pey: la comisión sale de aquí, no la calculamos. */
export interface AmountBreakdown {
  baseCents: number;
  tipCents: number;
  feeCents: number;
}

export type PeyTxStatus = "PENDING" | "PAID";
export type PeyPaymentMethod = "CARD" | "CODI";
export type PeyPayableType = "PAYMENT_LINK" | "API_CODI_QR" | "API_CODI_PN";

/** Una transacción de Pey, en centavos y con el chargeId que mandamos en metadata. */
export interface PeyTransaction {
  id: string;
  status: PeyTxStatus;
  amountCents: number;
  breakdown: AmountBreakdown | null;
  currency: string;
  paymentMethod: PeyPaymentMethod | null;
  payableType: PeyPayableType | null;
  payableId: string | null;
  description: string | null;
  applicationFeeCents: number;
  dateCreated: number | null;
  datePaid: number | null;
  /** metadata.chargeId: con esto cruzamos contra el libro de Zaldo. */
  chargeId: string | null;
}

export interface PeyTransactionPage {
  items: PeyTransaction[];
  nextToken: string | null;
}

export type BankAccountStatus = "PENDING" | "PROCESSING" | "ACTIVE" | "ERROR";

export interface PeyBankAccount {
  id: string;
  alias: string | null;
  name: string | null;
  /** Solo los últimos 4 dígitos: la CLABE completa no entra al panel. */
  clabeLast4: string | null;
  entity: string | null;
  codiStatus: BankAccountStatus | null;
  errorMessage: string | null;
  dateCreated: number | null;
}

/** Pey habla en pesos con decimales; adentro todo es centavos enteros. */
function toCents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function epochSeconds(value: unknown): number | null {
  // Pey manda segundos; adentro usamos milisegundos.
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 1e11 ? Math.round(value) : Math.round(value * 1000);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseBreakdown(value: unknown): AmountBreakdown | null {
  const record = asRecord(value);
  if (!record) return null;
  return {
    baseCents: toCents(record.base),
    tipCents: toCents(record.tip),
    feeCents: toCents(record.fee),
  };
}

/** Lee metadata.chargeId, también cuando viene dentro de externalMetadata. */
function parseChargeId(value: unknown): string | null {
  const metadata = asRecord(value);
  if (!metadata) return null;
  const direct = optionalString(metadata.chargeId);
  if (direct) return direct;
  const nested = asRecord(metadata.externalMetadata);
  return nested ? optionalString(nested.chargeId) : null;
}

export function parseTransaction(value: unknown): PeyTransaction | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = optionalString(record.id);
  if (!id) return null;
  const status = record.status === "PAID" ? "PAID" : "PENDING";
  const method = record.paymentMethod;
  const payable = record.payableType;
  return {
    id,
    status,
    amountCents: toCents(record.amount),
    breakdown: parseBreakdown(record.amountBreakdown),
    currency: optionalString(record.currency) ?? "MXN",
    paymentMethod: method === "CARD" || method === "CODI" ? method : null,
    payableType:
      payable === "PAYMENT_LINK" || payable === "API_CODI_QR" || payable === "API_CODI_PN" ? payable : null,
    payableId: optionalString(record.payableId),
    description: optionalString(record.description),
    applicationFeeCents: toCents(record.applicationFee),
    dateCreated: epochSeconds(record.dateCreated),
    datePaid: epochSeconds(record.datePaid),
    chargeId: parseChargeId(record.metadata),
  };
}

function parseTransactionPage(body: Record<string, unknown>): PeyTransactionPage {
  const raw = Array.isArray(body.items) ? body.items : [];
  const items: PeyTransaction[] = [];
  for (const entry of raw) {
    const parsed = parseTransaction(entry);
    if (parsed) items.push(parsed);
  }
  return { items, nextToken: optionalString(body.nextToken) };
}

/**
 * Un error de Pey con su `type` (INVALID_STATE, INVALID_AMOUNT…) y el
 * requestId para soporte. Pey responde {"error": {message, type, requestId}}.
 */
export class PeyError extends Error {
  constructor(
    message: string,
    readonly type: string | null,
    readonly status: number,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "PeyError";
  }
}

/** Arma el error a partir del cuerpo, venga como venga. */
export function peyErrorFrom(status: number, body: Record<string, unknown>): PeyError {
  const error = asRecord(body.error);
  const message =
    optionalString(error?.message) ??
    optionalString(body.message) ??
    optionalString(body.error) ??
    `Pey respondió ${status}`;
  const type = optionalString(error?.type) ?? optionalString(body.type);
  const requestId = optionalString(error?.requestId) ?? optionalString(body.requestId);
  return new PeyError(message.slice(0, 180), type, status, requestId);
}

export type PaymentLinkStatus = "pending" | "processing" | "paid" | "partial";

export interface PeyPaymentLink {
  id: string;
  status: PaymentLinkStatus;
  /** Milisegundos del primer pago, si ya hay uno. */
  datePaid: number | null;
  /** La propina de ese pago, en centavos. */
  tipCents: number;
}

export interface PeyClientOptions {
  /**
   * Cuenta que recibe los cobros CoDi (ULID de POST /bank-account). Sin ella,
   * el pago va a la cuenta CoDi ligada a la API key en el portal.
   */
  bankAccountId?: string | null;
}

export interface BankAccountInput {
  alias: string;
  name: string;
  clabe: string;
  entity: "BUSINESS" | "PERSON";
}

export class PeyClient {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: PeyClientOptions = {},
  ) {}

  private receiver(own?: string | null): { bankAccountId?: string } {
    const id = own || this.options.bankAccountId;
    return id ? { bankAccountId: id } : {};
  }

  /** POST /bank-account: registra una CLABE bajo esta API key para recibir CoDi. */
  async registerBankAccount(input: BankAccountInput): Promise<{ id: string; codiStatus: BankAccountStatus | null }> {
    const body = await this.post("/bank-account", input);
    const status = body.codiStatus;
    return {
      id: String(body.id ?? ""),
      codiStatus:
        status === "PENDING" || status === "PROCESSING" || status === "ACTIVE" || status === "ERROR" ? status : null,
    };
  }

  push(input: PushInput): Promise<PushResult> {
    return this.post("/codi/pn", {
      amount: centsToPesos(input.amountCents),
      phoneNumber: input.phone,
      concept: input.concept,
      expiration: input.expirationSec,
      numRef: input.numRef,
      ...this.receiver(input.bankAccountId),
      metadata: { chargeId: input.chargeId },
    }).then((body) => ({
      transactionId: String(body.transactionId ?? ""),
      codiId: String(body.codiId ?? ""),
    }));
  }

  qr(input: QrInput): Promise<QrResult> {
    return this.post("/codi/qr", {
      amount: centsToPesos(input.amountCents),
      concept: input.concept,
      expiration: input.expirationSec,
      numRef: input.numRef,
      generateImage: false,
      ...this.receiver(input.bankAccountId),
      metadata: { chargeId: input.chargeId },
    }).then((body) => ({
      id: String(body.id ?? ""),
      qrString: String(body.qrString ?? ""),
    }));
  }

  link(input: LinkInput): Promise<LinkResult> {
    return this.post("/payment-link/create", {
      amount: centsToPesos(input.amountCents),
      successUrl: input.successUrl,
      backUrl: input.backUrl,
      ...(input.hasTip ? { hasTip: true } : {}),
      clientReferenceId: input.chargeId,
      metadata: { chargeId: input.chargeId },
    }).then((body) => ({
      id: String(body.id ?? ""),
      url: String(body.url ?? ""),
    }));
  }

  /**
   * GET /transaction/api-key: lo que de verdad cobró esta API key, 80 por
   * página y lo más nuevo primero. Es la fuente de la verdad del dinero.
   */
  transactionsByApiKey(nextToken?: string): Promise<PeyTransactionPage> {
    const query = nextToken ? `?nextToken=${encodeURIComponent(nextToken)}` : "";
    return this.get(`/transaction/api-key${query}`).then(parseTransactionPage);
  }

  /** GET /transaction/bank-account/{id}: solo las pagadas de esa CLABE. */
  transactionsByBankAccount(bankAccountId: string, nextToken?: string): Promise<PeyTransactionPage> {
    const query = nextToken ? `?nextToken=${encodeURIComponent(nextToken)}` : "";
    return this.get(`/transaction/bank-account/${encodeURIComponent(bankAccountId)}${query}`).then(
      parseTransactionPage,
    );
  }

  /** GET /transaction/{id}: el estado real de un cobro, sin esperar el webhook. */
  async transaction(id: string): Promise<PeyTransaction | null> {
    const body = await this.get(`/transaction/${encodeURIComponent(id)}`, [404]);
    if (body.__notFound === true) return null;
    return parseTransaction(body);
  }

  /** GET /transaction/codi/qr/{idc}: los pagos que ha recibido un QR, lo más nuevo primero. */
  async qrTransactions(idc: string): Promise<PeyTransactionPage> {
    const body = await this.get(`/transaction/codi/qr/${encodeURIComponent(idc)}`, [404]);
    if (body.__notFound === true) return { items: [], nextToken: null };
    return parseTransactionPage(body);
  }

  /** GET /payment-link/{id}: el estado de un link, sin esperar el webhook. */
  async paymentLink(id: string): Promise<PeyPaymentLink | null> {
    const body = await this.get(`/payment-link/${encodeURIComponent(id)}`, [404]);
    if (body.__notFound === true) return null;
    const status = body.status;
    const first = Array.isArray(body.transactions) ? asRecord(body.transactions[0]) : null;
    return {
      id: optionalString(body.id) ?? id,
      status: status === "paid" || status === "processing" || status === "partial" ? status : "pending",
      datePaid: first ? epochSeconds(first.datePaid) : null,
      tipCents: first ? (parseBreakdown(first.amountBreakdown)?.tipCents ?? 0) : 0,
    };
  }

  /** GET /bank-account/{id}: sirve para ver si Banxico ya activó la cuenta. */
  async bankAccount(id: string): Promise<PeyBankAccount | null> {
    const body = await this.get(`/bank-account/${encodeURIComponent(id)}`, [404]);
    if (body.__notFound === true) return null;
    const status = body.codiStatus;
    const clabe = optionalString(body.clabe);
    return {
      id: optionalString(body.id) ?? id,
      alias: optionalString(body.alias),
      name: optionalString(body.name),
      clabeLast4: clabe ? clabe.slice(-4) : null,
      entity: optionalString(body.entity),
      codiStatus:
        status === "PENDING" || status === "PROCESSING" || status === "ACTIVE" || status === "ERROR"
          ? status
          : null,
      errorMessage: optionalString(body.errorMessage),
      dateCreated: epochSeconds(body.dateCreated),
    };
  }

  private get(path: string, tolerate: number[] = []): Promise<Record<string, unknown>> {
    return this.request("GET", path, undefined, tolerate);
  }

  private post(path: string, payload: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", path, payload, []);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    payload: unknown,
    tolerate: number[],
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      // Sin respuesta (red caída o 20 s sin contestar): no sabemos si Pey lo recibió.
      const reason = error instanceof Error ? error.message : "sin respuesta";
      throw new PeyError(`Pey no respondió (${reason.slice(0, 80)})`, "NETWORK", 0, null);
    }
    const text = await response.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        const parsed = JSON.parse(text) as unknown;
        body = asRecord(parsed) ?? {};
      } catch {
        body = { message: text.slice(0, 180) };
      }
    }
    if (tolerate.includes(response.status)) return { __notFound: true };
    if (!response.ok) throw peyErrorFrom(response.status, body);
    return body;
  }
}
