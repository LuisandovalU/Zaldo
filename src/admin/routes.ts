import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppConfig } from "../config.js";
import type { AuthConfig } from "../auth/config.js";
import { requireSession, type AuthRouteDeps } from "../auth/routes.js";
import { buildCookie, csrfOk, newCsrfToken, parseCookies, CSRF_COOKIE } from "../auth/session.js";
import type { Store, ChargeMethod, ChargeStatus } from "../store.js";
import {
  chargesToCsv,
  computeMetrics,
  dailySeries,
  filterCharges,
  ownerDetail,
  ownerFromRef,
  ownerRef,
  ownerSummaries,
  type Filters,
} from "./data.js";
import { renderLayout } from "./layout.js";
import { repairCharge, type ReconcileCache } from "./reconcile.js";
import {
  renderCharges,
  renderDashboard,
  renderOwnerDetail,
  renderOwners,
  renderReconcile,
  renderSettings,
  type ReconcileBanner,
} from "./views.js";

export interface AdminDeps extends AuthRouteDeps {
  store: Store;
  config: AppConfig;
  authConfig: AuthConfig;
  /** Cruce contra Pey. Sin esto, la pestaña de conciliación avisa y no rompe. */
  reconcile?: ReconcileCache;
}

const STATUSES: ChargeStatus[] = ["awaiting_confirm", "pending", "paid", "expired", "cancelled", "failed"];
const METHODS: ChargeMethod[] = ["push", "qr", "link"];
const PER_PAGE = 50;
/** Tope del CSV: evita armar un archivo gigante en memoria. */
const CSV_LIMIT = 5_000;

function send(res: ServerResponse, status: number, body: string, type: string, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
  };
  if (cookies.length) headers["Set-Cookie"] = cookies;
  res.writeHead(status, headers);
  res.end(body);
}

function redirect(res: ServerResponse, to: string, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = { Location: to, "Cache-Control": "no-store" };
  if (cookies.length) headers["Set-Cookie"] = cookies;
  res.writeHead(303, headers);
  res.end();
}

/** El único POST del panel es reparar: un form chico basta. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 4 * 1024) return null;
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function parseFilters(url: URL, resolveOwner: (ref: string) => string | null): Filters {
  const status = url.searchParams.get("status") ?? "";
  const method = url.searchParams.get("method") ?? "";
  const page = Number(url.searchParams.get("page") ?? "1");
  const ownerRefParam = url.searchParams.get("owner")?.trim().slice(0, 40) || "";
  return {
    owner: ownerRefParam ? (resolveOwner(ownerRefParam) ?? "\u0000sin-coincidencia") : undefined,
    status: STATUSES.includes(status as ChargeStatus) ? (status as ChargeStatus) : undefined,
    method: METHODS.includes(method as ChargeMethod) ? (method as ChargeMethod) : undefined,
    q: url.searchParams.get("q")?.trim().slice(0, 80) || undefined,
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    perPage: PER_PAGE,
  };
}

/**
 * Atiende todo lo que empieza con /admin, salvo el login (de eso se encarga
 * el módulo auth). Devuelve true si respondió.
 */
export async function handleAdminRoutes(
  deps: AdminDeps,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname.replace(/\/$/, "") || "/";
  if (path !== "/admin" && !path.startsWith("/admin/")) return false;

  const isRepair = path === "/admin/conciliacion/reparar";
  if (req.method !== "GET" && !(req.method === "POST" && isRepair)) {
    send(res, 405, "Método no permitido.", "text/plain; charset=utf-8");
    return true;
  }

  const wantsJson = path.endsWith(".json");
  const session = requireSession(deps, req, res, url.pathname, wantsJson);
  if (!session) return true;

  const now = deps.now();
  // Token nuevo en cada carga: solo lo usa el botón de salir.
  const csrf = newCsrfToken();
  const csrfCookie = buildCookie(CSRF_COOKIE, csrf, { secure: deps.auth.cookieSecure, maxAgeSec: 1_800 });
  const page = (title: string, active: Parameters<typeof renderLayout>[0]["active"], body: string): void => {
    send(res, 200, renderLayout({ title, active, user: session.user, csrfToken: csrf, body }), "text/html; charset=utf-8", [
      csrfCookie,
    ]);
  };

  // El secreto de sesión también sirve para derivar los refs de las URL.
  const refSecret = deps.authConfig.sessionSecret;
  const refOf = (owner: string): string => ownerRef(owner, refSecret);
  const resolveOwner = (ref: string): string | null => ownerFromRef(deps.store, ref, refSecret);

  const charges = deps.store.listCharges();

  if (path === "/admin") {
    const metrics = computeMetrics(charges, now, deps.config.dailyCapCents);
    const series = dailySeries(charges, now);
    const recent = [...charges].sort((a, b) => b.createdAt - a.createdAt).slice(0, 15);
    page("Resumen", "resumen", renderDashboard(metrics, series, recent, refOf));
    return true;
  }

  if (path === "/admin/cobros") {
    const filters = parseFilters(url, resolveOwner);
    const result = filterCharges(charges, filters);
    const owners = [...new Set(charges.map((charge) => charge.owner))].sort();
    page("Cobros", "cobros", renderCharges(result, filters, owners, refOf));
    return true;
  }

  if (path === "/admin/cobros.csv") {
    const filters = { ...parseFilters(url, resolveOwner), page: 1, perPage: CSV_LIMIT };
    const result = filterCharges(charges, filters);
    const stamp = new Date(now).toISOString().slice(0, 10);
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="zaldo-cobros-${stamp}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Set-Cookie": [csrfCookie],
    });
    res.end(chargesToCsv(result.rows));
    return true;
  }

  if (path === "/admin/usuarios") {
    page("Usuarios", "usuarios", renderOwners(ownerSummaries(deps.store, charges), refOf));
    return true;
  }

  if (path.startsWith("/admin/usuarios/")) {
    const raw = path.slice("/admin/usuarios/".length);
    let ref: string;
    try {
      ref = decodeURIComponent(raw);
    } catch {
      send(res, 400, "Identificador no válido.", "text/plain; charset=utf-8");
      return true;
    }
    const owner = resolveOwner(ref);
    if (!owner) {
      send(res, 404, renderLayout({
        title: "Usuario",
        active: "usuarios",
        user: session.user,
        csrfToken: csrf,
        body: `<h1>Sin datos</h1><p class="note">Ese identificador no corresponde a ningún usuario. <a href="/admin/usuarios">Volver</a></p>`,
      }), "text/html; charset=utf-8", [csrfCookie]);
      return true;
    }
    const detail = ownerDetail(deps.store, owner);
    if (detail.charges.length === 0 && detail.notes.length === 0 && detail.contacts.length === 0) {
      send(res, 404, renderLayout({
        title: "Usuario",
        active: "usuarios",
        user: session.user,
        csrfToken: csrf,
        body: `<h1>Sin datos</h1><p class="note">No hay nada guardado para ese celular. <a href="/admin/usuarios">Volver</a></p>`,
      }), "text/html; charset=utf-8", [csrfCookie]);
      return true;
    }
    const metrics = computeMetrics(detail.charges, now, deps.config.dailyCapCents);
    page("Usuario", "usuarios", renderOwnerDetail(detail, metrics));
    return true;
  }

  if (path === "/admin/conciliacion" || isRepair) {
    if (!deps.reconcile) {
      page(
        "Conciliación",
        "conciliacion",
        `<h1>Conciliación con Pey</h1><p class="note">No está configurada la lectura de Pey, así que no puedo cruzar el libro contra las transacciones reales.</p>`,
      );
      return true;
    }

    let banner: ReconcileBanner | undefined;
    if (isRepair) {
      // Repara y vuelve a GET: así un refresco no repite la acción.
      const form = await readForm(req);
      const cookies = parseCookies(req.headers.cookie);
      if (!form || !csrfOk(cookies[CSRF_COOKIE], form.get("csrf") ?? undefined)) {
        redirect(res, "/admin/conciliacion?aviso=csrf", [csrfCookie]);
        return true;
      }
      const chargeId = (form.get("chargeId") ?? "").slice(0, 64);
      const transactionId = (form.get("transactionId") ?? "").slice(0, 64);
      const outcome = await repairCharge(
        deps.reconcile.pey,
        deps.store,
        chargeId,
        transactionId,
        now,
      );
      deps.reconcile.invalidate();
      const query = outcome.ok
        ? `?aviso=ok&monto=${outcome.amountCents}`
        : `?aviso=error&detalle=${encodeURIComponent(outcome.reason.slice(0, 120))}`;
      redirect(res, `/admin/conciliacion${query}`, [csrfCookie]);
      return true;
    }

    const aviso = url.searchParams.get("aviso");
    if (aviso === "ok") {
      const cents = Number(url.searchParams.get("monto") ?? "0");
      const amount = Number.isFinite(cents) && cents > 0 ? ` (${(cents / 100).toFixed(2)} MXN)` : "";
      banner = { kind: "ok", text: `Listo: el cobro quedó marcado como pagado${amount}.` };
    } else if (aviso === "error") {
      const detail = url.searchParams.get("detalle")?.slice(0, 160) ?? "";
      banner = { kind: "error", text: detail || "No pude reparar ese cobro." };
    } else if (aviso === "csrf") {
      banner = { kind: "error", text: "La sesión del formulario caducó. Vuelve a intentarlo." };
    }

    const force = url.searchParams.get("refrescar") === "1";
    const result = await deps.reconcile.get(now, force);
    page("Conciliación", "conciliacion", renderReconcile(result, csrf, banner));
    return true;
  }

  if (path === "/admin/ajustes") {
    page(
      "Ajustes",
      "ajustes",
      renderSettings({
        dailyCapCents: deps.config.dailyCapCents,
        allowedPhones: deps.config.allowedPhones,
        publicBaseUrl: deps.config.publicBaseUrl,
        peyApiBase: deps.config.peyApiBase,
        dataPath: deps.config.dataPath,
        model: deps.config.openRouterModel,
        transcribeModel: deps.config.transcribeModel,
        pushExpirationSec: deps.config.pushExpirationSec,
        qrExpirationSec: deps.config.qrExpirationSec,
        confirmWindowMs: deps.config.confirmWindowMs,
        admins: deps.authConfig.users.map((item) => item.user),
        sessionHours: Math.round(deps.authConfig.sessionTtlMs / 3_600_000),
      }),
    );
    return true;
  }

  // API ligera, por si el equipo quiere graficar desde otro lado.
  if (path === "/admin/metricas.json") {
    const body = JSON.stringify({
      generatedAt: now,
      metrics: computeMetrics(charges, now, deps.config.dailyCapCents),
      daily: dailySeries(charges, now),
    });
    send(res, 200, body, "application/json; charset=utf-8");
    return true;
  }

  send(res, 404, renderLayout({
    title: "No encontrado",
    active: "resumen",
    user: session.user,
    csrfToken: csrf,
    body: `<h1>No encontrado</h1><p class="note">Esa página del panel no existe. <a href="/admin">Ir al resumen</a></p>`,
  }), "text/html; charset=utf-8", [csrfCookie]);
  return true;
}
