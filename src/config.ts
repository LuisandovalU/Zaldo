import { parseAllowlist } from "./phone.js";

export interface AppConfig {
  port: number;
  openRouterKey: string;
  openRouterModel: string;
  transcribeModel: string;
  peyKey: string;
  peyWebhookSecret: string;
  peyApiBase: string;
  whatsappToken: string;
  whatsappPhoneNumberId: string;
  whatsappAppSecret: string;
  whatsappVerifyToken: string;
  allowedPhones: string[];
  dailyCapCents: number;
  publicBaseUrl: string | null;
  dataPath: string;
  pushExpirationSec: number;
  qrExpirationSec: number;
  confirmWindowMs: number;
}

function required(name: string, value: string | undefined): string {
  const text = value?.trim() ?? "";
  if (!text) throw new Error(`Falta ${name} en el entorno`);
  return text;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cap = Number(env.DAILY_CAP_MXN ?? "5000");
  if (!Number.isFinite(cap) || cap <= 0) throw new Error("DAILY_CAP_MXN tiene que ser un número de pesos");
  const publicBase = env.PUBLIC_BASE_URL?.trim().replace(/\/$/, "") || null;
  if (publicBase && !publicBase.startsWith("https://")) {
    throw new Error("PUBLIC_BASE_URL tiene que empezar con https://");
  }
  return {
    port: Number(env.PORT ?? "3000"),
    openRouterKey: required("OPENROUTER_API_KEY", env.OPENROUTER_API_KEY),
    openRouterModel: env.OPENROUTER_MODEL?.trim() || "openai/gpt-4o-mini",
    transcribeModel: env.OPENROUTER_TRANSCRIBE_MODEL?.trim() || "openai/whisper-large-v3",
    peyKey: required("PEY_API_KEY", env.PEY_API_KEY),
    peyWebhookSecret: required("PEY_WEBHOOK_SECRET", env.PEY_WEBHOOK_SECRET),
    peyApiBase: (env.PEY_API_BASE?.trim() || "https://api.pey.mx").replace(/\/$/, ""),
    whatsappToken: required("WHATSAPP_ACCESS_TOKEN", env.WHATSAPP_ACCESS_TOKEN),
    whatsappPhoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID", env.WHATSAPP_PHONE_NUMBER_ID),
    whatsappAppSecret: required("WHATSAPP_APP_SECRET", env.WHATSAPP_APP_SECRET),
    whatsappVerifyToken: required("WHATSAPP_VERIFY_TOKEN", env.WHATSAPP_VERIFY_TOKEN),
    allowedPhones: parseAllowlist(env.ALLOWED_PHONES),
    dailyCapCents: Math.round(cap * 100),
    publicBaseUrl: publicBase,
    dataPath: env.DATA_PATH?.trim() || "./data/zaldo.json",
    pushExpirationSec: 360,
    qrExpirationSec: 3600,
    confirmWindowMs: 15 * 60 * 1000,
  };
}
