/**
 * "Registrar mi cuenta": la página donde quien usa Zaldo pone la CLABE en la
 * que quiere recibir sus cobros CoDi.
 *
 * La CLABE nunca pasa por el chat: el bot manda un enlace firmado, de un solo
 * uso y que caduca; la página (misma marca que la landing) la recibe por HTTPS
 * y se la entrega a pey con POST /bank-account. Zaldo guarda solo el id que
 * devuelve pey y los últimos 4 dígitos; la CLABE completa no queda en el libro
 * ni en ningún log.
 *
 * Cuando Banxico la activa (pey avisa por webhook, y además se consulta), los
 * cobros de esa persona se mandan con su bankAccountId y caen directo en su
 * banco: Zaldo no concentra dinero de nadie.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { AppConfig } from "./config.js";
import { PeyError, type BankAccountInput, type BankAccountStatus, type PeyBankAccount } from "./pey.js";
import type { BankLink, Store } from "./store.js";

/** Lo que dura el enlace que manda el bot. */
export const LINK_TTL_MS = 30 * 60 * 1000;
/** Intentos de guardar con un mismo enlace, y cuentas distintas que una persona puede registrar. */
const MAX_TRIES = 8;
const MAX_ACCOUNTS = 3;

export interface AccountPey {
  registerBankAccount?(input: BankAccountInput): Promise<{ id: string; codiStatus: BankAccountStatus | null }>;
  bankAccount?(id: string): Promise<PeyBankAccount | null>;
}

export interface AccountDeps {
  store: Store;
  config: AppConfig;
  pey: AccountPey;
  now: () => number;
  /** El número de WhatsApp del bot, para el botón de regreso. */
  botNumber?: () => string | null;
}

export interface PageRequest {
  method: string;
  query: Record<string, string>;
  body: () => Promise<Buffer>;
}

export interface PageReply {
  status: number;
  type: string;
  body: string;
}

function signingKey(config: AppConfig): Buffer {
  // Una llave propia, derivada de secretos que el servidor ya tiene: no hace falta otra variable.
  return createHash("sha256").update(`zaldo-cuenta|${config.peyWebhookSecret}|${config.whatsappVerifyToken}`).digest();
}

function b64(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

/** El enlace que el bot le manda a esa persona, y solo a ella. */
export function accountLink(config: AppConfig, owner: string, now: number): string | null {
  if (!config.publicBaseUrl) return null;
  const payload = b64(JSON.stringify({ o: owner, e: now + LINK_TTL_MS, n: randomBytes(9).toString("base64url") }));
  const mac = b64(createHmac("sha256", signingKey(config)).update(payload).digest());
  return `${config.publicBaseUrl}/cuenta?t=${payload}.${mac}`;
}

export function readAccountToken(
  config: AppConfig,
  token: string,
  now: number,
): { owner: string; nonce: string } | null {
  const [payload, mac, extra] = String(token || "").split(".");
  if (!payload || !mac || extra !== undefined) return null;
  const expected = createHmac("sha256", signingKey(config)).update(payload).digest();
  let given: Buffer;
  try {
    given = Buffer.from(mac, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof data.o !== "string" || typeof data.n !== "string" || typeof data.e !== "number") return null;
    if (data.e < now) return null;
    return { owner: data.o, nonce: data.n };
  } catch {
    return null;
  }
}

/** 18 dígitos y dígito verificador correcto (pesos 3, 7, 1). */
export function validClabe(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (Number(clabe[i]) * (weights[i % 3] ?? 0)) % 10;
  return (10 - (sum % 10)) % 10 === Number(clabe[17]);
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const STYLE = `
:root{--bg:#fff;--surf:#f4f4f6;--ink:#0a0a0c;--mute:#62626d;--line:rgba(10,10,12,.12);--bad:#b42318;--ok:#0b6b3a}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--bg);color:var(--ink);font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:16px;line-height:1.5;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:28px 16px 40px}
main{width:100%;max-width:440px}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:28px;text-decoration:none;color:var(--ink)}
.brand img{width:36px;height:36px;border-radius:9px}
.brand span{font-family:Manrope,Inter,system-ui,sans-serif;font-weight:800;font-size:22px;letter-spacing:-.02em}
h1{font-family:Manrope,Inter,system-ui,sans-serif;font-weight:800;font-size:28px;line-height:1.15;letter-spacing:-.02em;margin:0 0 8px}
p{margin:0 0 14px;color:var(--mute)}p.lead{font-size:17px}
form{margin-top:22px;display:grid;gap:16px}
label{display:grid;gap:6px;font-weight:600;font-size:14px}
label small{font-weight:400;color:var(--mute)}
input[type=text],input[type=tel]{font:inherit;padding:13px 14px;border:1px solid var(--line);border-radius:12px;background:var(--surf);color:var(--ink);width:100%}
input:focus{outline:2px solid var(--ink);outline-offset:1px;background:#fff}
.clabe{font-variant-numeric:tabular-nums;letter-spacing:.06em}
fieldset{border:0;margin:0;padding:0;display:grid;gap:8px}
legend{font-weight:600;font-size:14px;padding:0;margin-bottom:6px}
.pick{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pick label{display:flex;align-items:center;gap:8px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;font-weight:500;cursor:pointer}
.check{display:flex;gap:10px;align-items:flex-start;font-weight:400;font-size:14px;color:var(--mute)}
.check input{margin-top:3px;width:18px;height:18px;flex:none}
button,.btn{font:inherit;font-weight:700;border:0;border-radius:999px;padding:15px 22px;background:var(--ink);color:#fff;cursor:pointer;text-align:center;text-decoration:none;display:block;width:100%}
.note{font-size:13px;color:var(--mute);margin-top:18px}
.alert{border-radius:12px;padding:12px 14px;font-size:14px;margin-top:14px}
.alert.bad{background:#fef3f2;color:var(--bad)}.alert.ok{background:#ecfdf3;color:var(--ok)}
.card{border:1px solid var(--line);border-radius:16px;padding:18px;margin:18px 0;background:var(--surf)}
.card b{font-family:Manrope,Inter,sans-serif;font-size:20px}
`;

function page(title: string, inner: string): string {
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'">
<title>${esc(title)} · Zaldo</title>
<link rel="icon" type="image/png" href="/assets/zaldo-cube.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Manrope:wght@700;800&display=swap">
<style>${STYLE}</style>
</head><body><main>
<a class="brand" href="/"><img src="/assets/zaldo-cube.png" alt=""><span>Zaldo</span></a>
${inner}
</main></body></html>`;
}

function html(status: number, title: string, inner: string): PageReply {
  return { status, type: "text/html; charset=utf-8", body: page(title, inner) };
}

function backButton(deps: AccountDeps, label = "Volver a WhatsApp"): string {
  const number = deps.botNumber?.() ?? null;
  return number
    ? `<a class="btn" href="https://wa.me/${esc(number)}">${esc(label)}</a>`
    : `<p class="note">Ya puedes cerrar esta página y volver a tu chat de WhatsApp con Zaldo.</p>`;
}

const STATUS_TEXT: Record<BankAccountStatus, string> = {
  PENDING: "Banxico la está activando. Tarda hasta 5 días hábiles.",
  PROCESSING: "Banxico la está activando. Tarda hasta 5 días hábiles.",
  ACTIVE: "Ya está activa: tus cobros caen directo en tu banco.",
  ERROR: "Banxico no la pudo activar.",
};

interface FormValues {
  name: string;
  entity: string;
  clabe: string;
}

function form(token: string, error: string, values: FormValues): string {
  const person = values.entity !== "BUSINESS";
  return `<h1>¿En qué cuenta quieres recibir?</h1>
<p class="lead">Tus cobros CoDi caen directo en tu banco. Zaldo no guarda tu dinero ni tu CLABE completa.</p>
${error ? `<div class="alert bad" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/cuenta" autocomplete="off" novalidate>
<input type="hidden" name="t" value="${esc(token)}">
<label>Nombre del titular <small>Como aparece en tu banco.</small>
<input type="text" name="name" value="${esc(values.name)}" maxlength="120" required autocapitalize="words"></label>
<fieldset><legend>La cuenta es de</legend><div class="pick">
<label><input type="radio" name="entity" value="PERSON"${person ? " checked" : ""}> Una persona</label>
<label><input type="radio" name="entity" value="BUSINESS"${person ? "" : " checked"}> Un negocio</label>
</div></fieldset>
<label>CLABE <small>Los 18 dígitos. Está en la app de tu banco, en los datos de tu cuenta.</small>
<input class="clabe" type="tel" name="clabe" value="${esc(values.clabe)}" inputmode="numeric" pattern="[0-9 ]*" maxlength="22" required></label>
<label class="check"><input type="checkbox" name="ok" value="1" required>
<span>Soy titular de esta cuenta y autorizo a Zaldo a registrarla en pey para recibir mis cobros CoDi.</span></label>
<button type="submit">Registrar mi cuenta</button>
</form>
<p class="note">Tu CLABE viaja cifrada y se entrega a pey, el proveedor de pagos que la registra ante Banxico. Zaldo solo conserva sus últimos 4 dígitos. Con una CLABE solo se puede depositar, nunca retirar.</p>`;
}

function bankCard(bank: BankLink): string {
  return `<div class="card"><p>Cuenta terminada en</p><b>•••• ${esc(bank.last4)}</b>
<p style="margin-top:8px">${esc(bank.holder)}</p></div>
<div class="alert ${bank.status === "ERROR" ? "bad" : "ok"}">${esc(STATUS_TEXT[bank.status])}${bank.status === "ERROR" && bank.error ? ` ${esc(bank.error)}` : ""}</div>`;
}

const tries = new Map<string, number>();

/** GET /cuenta y POST /cuenta. */
export async function handleAccountPage(deps: AccountDeps, request: PageRequest): Promise<PageReply> {
  const now = deps.now();
  const expired = () =>
    html(
      410,
      "Enlace vencido",
      `<h1>Este enlace ya no sirve</h1><p class="lead">Por seguridad dura 30 minutos y se usa una sola vez. Escríbele a Zaldo <b>registrar mi cuenta</b> y te manda uno nuevo.</p>${backButton(deps)}`,
    );

  if (request.method === "GET") {
    const token = request.query.t ?? "";
    const who = readAccountToken(deps.config, token, now);
    if (!who || deps.store.claimed(`cuenta:${who.nonce}`)) return expired();
    const bank = deps.store.getProfile(who.owner).bank ?? null;
    if (bank && bank.status !== "ERROR" && request.query.cambiar !== "1") {
      return html(
        200,
        "Tu cuenta",
        `<h1>Tu cuenta ya está registrada</h1>${bankCard(bank)}<p style="margin-top:18px"><a href="/cuenta?t=${esc(token)}&amp;cambiar=1">Registrar otra cuenta</a></p>${backButton(deps)}`,
      );
    }
    return html(200, "Registrar mi cuenta", form(token, "", { name: bank?.holder ?? "", entity: "PERSON", clabe: "" }));
  }

  if (request.method !== "POST") return { status: 405, type: "text/plain; charset=utf-8", body: "method" };
  const raw = await request.body();
  if (raw.length > 4096) return { status: 413, type: "text/plain; charset=utf-8", body: "too big" };
  const fields = new URLSearchParams(raw.toString("utf8"));
  const token = fields.get("t") ?? "";
  const who = readAccountToken(deps.config, token, now);
  if (!who || deps.store.claimed(`cuenta:${who.nonce}`)) return expired();

  const values: FormValues = {
    name: (fields.get("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    entity: fields.get("entity") === "BUSINESS" ? "BUSINESS" : "PERSON",
    clabe: (fields.get("clabe") ?? "").replace(/\D/g, ""),
  };
  const again = (error: string, status = 422) => html(status, "Registrar mi cuenta", form(token, error, { ...values, clabe: "" }));

  const used = (tries.get(who.nonce) ?? 0) + 1;
  tries.set(who.nonce, used);
  if (used > MAX_TRIES) return expired();
  if (values.name.length < 3) return again("Escribe el nombre del titular, como aparece en tu banco.");
  if (!validClabe(values.clabe)) return again("Esa CLABE no es válida. Son 18 dígitos; revísala en la app de tu banco.");
  if (fields.get("ok") !== "1") return again("Falta confirmar que eres titular de la cuenta.");
  const profile = deps.store.getProfile(who.owner);
  if ((profile.bankCount ?? 0) >= MAX_ACCOUNTS) {
    return again("Ya registraste varias cuentas con este WhatsApp. Escríbele a Zaldo si necesitas cambiarla otra vez.", 429);
  }
  if (!deps.pey.registerBankAccount) return again("El registro de cuentas no está disponible ahorita. Inténtalo más tarde.", 503);

  let created: { id: string; codiStatus: BankAccountStatus | null };
  try {
    created = await deps.pey.registerBankAccount({
      alias: `Zaldo ${values.clabe.slice(-4)}`,
      name: values.name,
      clabe: values.clabe,
      entity: values.entity as "PERSON" | "BUSINESS",
    });
  } catch (error) {
    // Sin la CLABE en el log: solo el tipo de error.
    if (error instanceof PeyError) {
      console.error("zaldo cuenta", JSON.stringify({ type: error.type, status: error.status, requestId: error.requestId }));
      if (error.type === "INVALID_CLABE" || /clabe/i.test(error.message)) {
        return again("pey no aceptó esa CLABE: revisa los dígitos, y que tu banco tenga CoDi.");
      }
      if (error.status >= 500 || error.type === "NETWORK") return again("pey no contestó. Inténtalo otra vez en un minuto.", 503);
      return again("pey no pudo registrar la cuenta. Revisa el nombre del titular y la CLABE.");
    }
    console.error("zaldo cuenta", error instanceof Error ? error.message : "error");
    return again("No se pudo registrar la cuenta. Inténtalo otra vez en un minuto.", 500);
  }
  if (!created.id) return again("pey no devolvió la cuenta registrada. Inténtalo otra vez.", 502);

  const bank: BankLink = {
    id: created.id,
    last4: values.clabe.slice(-4),
    holder: values.name,
    status: created.codiStatus ?? "PENDING",
    error: null,
    registeredAt: now,
    checkedAt: 0,
  };
  deps.store.setProfile({ ...deps.store.getProfile(who.owner), bank, bankCount: (profile.bankCount ?? 0) + 1 });
  deps.store.claim(`cuenta:${who.nonce}`);
  deps.store.complete(`cuenta:${who.nonce}`);
  tries.delete(who.nonce);
  return html(
    200,
    "Cuenta registrada",
    `<h1>Listo, quedó registrada</h1>${bankCard(bank)}<p style="margin-top:14px">Zaldo te avisa por WhatsApp en cuanto esté activa. Mientras tanto puedes seguir usándolo.</p>${backButton(deps)}`,
  );
}

/** Lo que el bot dice por WhatsApp cuando cambia el estado de una cuenta. */
function bankNotice(bank: BankLink): string {
  if (bank.status === "ACTIVE") {
    return `Tu cuenta terminada en ${bank.last4} ya está activa en CoDi. Desde ahora tus cobros caen directo en tu banco.`;
  }
  if (bank.status === "ERROR") {
    return `Banxico no pudo activar tu cuenta terminada en ${bank.last4}${bank.error ? `: ${bank.error}` : ""}. Dime "registrar mi cuenta" y lo intentamos con otra.`;
  }
  return `Recibí tu cuenta terminada en ${bank.last4}. Banxico la activa en hasta 5 días hábiles; yo te aviso.`;
}

/** La cuenta recién registrada todavía no se le avisó por WhatsApp: se avisa una vez. */
export function takeNewAccounts(store: Store): { owner: string; text: string }[] {
  const notices: { owner: string; text: string }[] = [];
  for (const profile of store.listProfiles()) {
    const bank = profile.bank;
    if (!bank || bank.announced) continue;
    store.setProfile({ ...profile, bank: { ...bank, announced: true } });
    notices.push({ owner: profile.owner, text: bankNotice(bank) });
  }
  return notices;
}

/** pey avisa (webhook bank.account.updated) que una cuenta quedó activa. */
export function applyBankEvent(store: Store, body: Record<string, unknown>): { owner: string; text: string } | null {
  if (body.type !== "bank.account.updated") return null;
  const id = String(body.bankAccountId ?? "");
  const profile = id ? store.listProfiles().find((item) => item.bank?.id === id) : undefined;
  if (!profile?.bank || profile.bank.status === "ACTIVE") return null;
  const bank: BankLink = { ...profile.bank, status: "ACTIVE", error: null, announced: true };
  store.setProfile({ ...profile, bank });
  return { owner: profile.owner, text: bankNotice(bank) };
}

/** Recién registrada se consulta en cada vuelta; después, cada diez minutos. */
const FRESH_MS = 5 * 60 * 1000;
const RECHECK_MS = 10 * 60 * 1000;

/** Por si el webhook no llega: se le pregunta a pey por las cuentas que siguen en activación. */
export async function checkAccounts(deps: AccountDeps): Promise<{ owner: string; text: string }[]> {
  const now = deps.now();
  const notices: { owner: string; text: string }[] = [];
  if (!deps.pey.bankAccount) return notices;
  for (const profile of deps.store.listProfiles()) {
    const bank = profile.bank;
    if (!bank || bank.status === "ACTIVE" || bank.status === "ERROR") continue;
    const fresh = now - bank.registeredAt < FRESH_MS;
    if (!fresh && now - (bank.checkedAt ?? 0) < RECHECK_MS) continue;
    try {
      const account = await deps.pey.bankAccount(bank.id);
      const status = account?.codiStatus ?? bank.status;
      const next: BankLink = { ...bank, status, error: account?.errorMessage ?? null, checkedAt: now };
      const current = deps.store.getProfile(profile.owner);
      if (current.bank?.id !== bank.id) continue; // la cambió mientras preguntábamos
      const changed = status !== bank.status && (status === "ACTIVE" || status === "ERROR");
      deps.store.setProfile({ ...current, bank: changed ? { ...next, announced: true } : next });
      if (changed) notices.push({ owner: profile.owner, text: bankNotice(next) });
    } catch (error) {
      console.error("zaldo cuenta estado", error instanceof Error ? error.message : "error");
    }
  }
  return notices;
}
