import { Webhook } from "standardwebhooks";

export function verifyPeyWebhook(
  secret: string,
  raw: string,
  headers: { id?: string; timestamp?: string; signature?: string },
): void {
  const webhook = new Webhook(secret);
  webhook.verify(raw, {
    "webhook-id": headers.id ?? "",
    "webhook-timestamp": headers.timestamp ?? "",
    "webhook-signature": headers.signature ?? "",
  });
}
