import { centsToPesos } from "./money.js";

export interface PushInput {
  amountCents: number;
  phone: string;
  concept: string;
  numRef: string;
  chargeId: string;
  expirationSec: number;
}

export interface QrInput {
  amountCents: number;
  concept: string;
  numRef: string;
  chargeId: string;
  expirationSec: number;
}

export interface LinkInput {
  amountCents: number;
  chargeId: string;
  successUrl: string;
  backUrl: string;
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

export class PeyClient {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  push(input: PushInput): Promise<PushResult> {
    return this.post("/codi/pn", {
      amount: centsToPesos(input.amountCents),
      phoneNumber: input.phone,
      concept: input.concept,
      expiration: input.expirationSec,
      numRef: input.numRef,
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
      clientReferenceId: input.chargeId,
      metadata: { chargeId: input.chargeId },
    }).then((body) => ({
      id: String(body.id ?? ""),
      url: String(body.url ?? ""),
    }));
  }

  private async post(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    if (text) {
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        body = { message: text.slice(0, 180) };
      }
    }
    if (!response.ok) {
      const message = String(body.message ?? body.error ?? `Pey respondió ${response.status}`);
      throw new Error(message.slice(0, 180));
    }
    return body;
  }
}
