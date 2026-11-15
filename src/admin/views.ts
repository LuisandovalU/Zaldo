import { formatMxn } from "../money.js";
import type { Charge, ChargeStatus, Contact, Note } from "../store.js";
import type { ChargePage, DayPoint, Filters, Metrics, OwnerDetail, OwnerSummary } from "./data.js";
import type { Mismatch, Reconciliation } from "./reconcile.js";
import { escapeHtml } from "./layout.js";

const STATUS_LABEL: Record<ChargeStatus, string> = {
  awaiting_confirm: "Sin confirmar",
  pending: "Pendiente",
  paid: "Pagado",
  expired: "Vencido",
  cancelled: "Cancelado",
  failed: "Falló",
};

const METHOD_LABEL: Record<Charge["method"], string> = {
  push: "CoDi push",
  qr: "CoDi QR",
  link: "Link",
};

const NOTE_LABEL: Record<Note["kind"], string> = {
  gasto: "Gasto",
  deuda: "Deuda",
  ingreso: "Ingreso",
};

const dateTime = new Intl.DateTimeFormat("es-MX", {
  timeZone: "America/Mexico_City",
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function when(value: number | null): string {
  if (value === null) return "—";
  return dateTime.format(new Date(value));
}

function statusTag(status: ChargeStatus): string {
  return `<span class="tag ${status}">${escapeHtml(STATUS_LABEL[status])}</span>`;
}

/** Oculta los dígitos de en medio: el admin reconoce el número sin exponerlo. */
export function maskPhone(phone: string | null): string {
  if (!phone) return "—";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "•".repeat(digits.length || 1);
  return `${digits.slice(0, 2)}•••••${digits.slice(-3)}`;
}

function card(key: string, value: string, note?: string, bar?: number): string {
  const extra = note ? `<p class="n">${escapeHtml(note)}</p>` : "";
  const meter =
    bar === undefined
      ? ""
      : `<div class="bar"><span style="width:${Math.min(100, Math.max(0, Math.round(bar)))}%"></span></div>`;
  return `<div class="card"><p class="k">${escapeHtml(key)}</p><p class="v">${escapeHtml(value)}</p>${extra}${meter}</div>`;
}

function chart(points: DayPoint[]): string {
  const peak = Math.max(1, ...points.map((point) => point.confirmedCents));
  const columns = points
    .map((point) => {
      const height = Math.round((point.confirmedCents / peak) * 100);
      const paid = point.confirmedCents === 0 ? 0 : Math.round((point.paidCents / point.confirmedCents) * 100);
      const title = `${point.label}: ${formatMxn(point.confirmedCents)} confirmado, ${formatMxn(point.paidCents)} pagado`;
      return `<div class="col" title="${escapeHtml(title)}">
      <div class="stack" style="height:${Math.max(height, 2)}%"><i style="height:${paid}%"></i></div>
      <span class="lbl">${escapeHtml(point.label)}</span>
    </div>`;
    })
    .join("");
  return `<div class="chart">${columns}</div>
<p class="legend"><span><i style="background:var(--accent)"></i>Pagado</span><span><i style="background:var(--neutral-bg)"></i>Confirmado sin pagar</span></p>`;
}

/** Convierte un celular de dueño en su ref opaco para las URL. */
export type RefOf = (owner: string) => string;

function chargeRows(rows: Charge[], withOwner: boolean, refOf?: RefOf): string {
  if (rows.length === 0) {
    return `<tr><td colspan="${withOwner ? 8 : 7}"><p class="empty">Sin cobros que mostrar.</p></td></tr>`;
  }
  return rows
    .map((charge) => {
      // El href lleva el ref opaco, nunca el celular.
      const owner = withOwner
        ? `<td><a href="/admin/usuarios/${encodeURIComponent(refOf ? refOf(charge.owner) : "")}">${escapeHtml(maskPhone(charge.owner))}</a></td>`
        : "";
      return `<tr>
      <td>${escapeHtml(when(charge.createdAt))}</td>
      ${owner}
      <td class="wrap">${escapeHtml(charge.concept)}</td>
      <td>${escapeHtml(charge.payerName)}</td>
      <td>${escapeHtml(maskPhone(charge.payerPhone))}</td>
      <td class="num">${escapeHtml(formatMxn(charge.amountCents))}</td>
      <td>${escapeHtml(METHOD_LABEL[charge.method])}</td>
      <td>${statusTag(charge.status)}</td>
    </tr>`;
    })
    .join("");
}

export function renderDashboard(metrics: Metrics, series: DayPoint[], recent: Charge[], refOf: RefOf): string {
  const capPct = metrics.capCents === 0 ? 0 : (metrics.todayCents / metrics.capCents) * 100;
  const cards = [
    card(
      "Hoy confirmado",
      formatMxn(metrics.todayCents),
      `Tope ${formatMxn(metrics.capCents)} · ${Math.round(capPct)}% usado`,
      capPct,
    ),
    card("Hoy pagado", formatMxn(metrics.todayPaidCents)),
    card("Pendiente", formatMxn(metrics.pendingCents), `${metrics.pendingCount} cobro(s) esperando`),
    card("Pagado histórico", formatMxn(metrics.paidCents), `${metrics.paidCount} cobro(s)`),
    card(
      "Conversión",
      metrics.conversionPct === null ? "—" : `${metrics.conversionPct}%`,
      "Pagados sobre los que salieron a Pey",
    ),
    card(
      "Incidencias",
      String(metrics.expiredCount + metrics.failedCount),
      `${metrics.expiredCount} vencido(s) · ${metrics.failedCount} con error`,
    ),
  ].join("");

  return `<h1>Resumen</h1>
<div class="cards">${cards}</div>
<h2>Últimos 14 días</h2>
${chart(series)}
<h2>Cobros recientes</h2>
<div class="panel scroll">
  <table>
    <thead><tr><th>Fecha</th><th>Dueño</th><th>Concepto</th><th>Pagador</th><th>Celular</th><th class="num">Monto</th><th>Método</th><th>Estado</th></tr></thead>
    <tbody>${chargeRows(recent, true, refOf)}</tbody>
  </table>
</div>
<p class="note">Los celulares se muestran parcialmente. El detalle completo vive en el archivo de datos.</p>`;
}

function option(value: string, label: string, selected: string | undefined): string {
  return `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

export function renderCharges(page: ChargePage, filters: Filters, owners: string[], refOf: RefOf): string {
  const query = new URLSearchParams();
  if (filters.owner) query.set("owner", refOf(filters.owner));
  if (filters.status) query.set("status", filters.status);
  if (filters.method) query.set("method", filters.method);
  if (filters.q) query.set("q", filters.q);

  const link = (target: number): string => {
    const params = new URLSearchParams(query);
    params.set("page", String(target));
    return `/admin/cobros?${params.toString()}`;
  };
  const csv = query.toString() ? `/admin/cobros.csv?${query.toString()}` : "/admin/cobros.csv";

  const statuses: ChargeStatus[] = ["awaiting_confirm", "pending", "paid", "expired", "cancelled", "failed"];
  const prev = page.page > 1 ? `<a class="btn" href="${link(page.page - 1)}">Anterior</a>` : "";
  const next = page.page < page.pages ? `<a class="btn" href="${link(page.page + 1)}">Siguiente</a>` : "";

  return `<h1>Cobros</h1>
<form class="filters" method="get" action="/admin/cobros">
  <label>Buscar<input type="search" name="q" value="${escapeHtml(filters.q ?? "")}" placeholder="concepto, pagador, referencia"></label>
  <label>Dueño<select name="owner">${option("", "Todos", filters.owner ? refOf(filters.owner) : "")}${owners
    .map((owner) => option(refOf(owner), maskPhone(owner), filters.owner ? refOf(filters.owner) : undefined))
    .join("")}</select></label>
  <label>Estado<select name="status">${option("", "Todos", filters.status ?? "")}${statuses
    .map((status) => option(status, STATUS_LABEL[status], filters.status))
    .join("")}</select></label>
  <label>Método<select name="method">${option("", "Todos", filters.method ?? "")}${(
    ["push", "qr", "link"] as const
  )
    .map((method) => option(method, METHOD_LABEL[method], filters.method))
    .join("")}</select></label>
  <button type="submit">Filtrar</button>
</form>
<div class="actions">
  <span class="note">${page.total} cobro(s)</span>
  <a class="btn" href="${escapeHtml(csv)}">Descargar CSV</a>
  <a class="btn" href="/admin/cobros">Limpiar filtros</a>
</div>
<div class="panel scroll">
  <table>
    <thead><tr><th>Fecha</th><th>Dueño</th><th>Concepto</th><th>Pagador</th><th>Celular</th><th class="num">Monto</th><th>Método</th><th>Estado</th></tr></thead>
    <tbody>${chargeRows(page.rows, true, refOf)}</tbody>
  </table>
</div>
<div class="pager">${prev}<span>Página ${page.page} de ${page.pages}</span>${next}</div>`;
}

export function renderOwners(owners: OwnerSummary[], refOf: RefOf): string {
  const rows =
    owners.length === 0
      ? `<tr><td colspan="6"><p class="empty">Todavía nadie ha usado Zaldo.</p></td></tr>`
      : owners
          .map(
            (owner) => `<tr>
      <td><a href="/admin/usuarios/${encodeURIComponent(refOf(owner.owner))}">${escapeHtml(maskPhone(owner.owner))}</a></td>
      <td class="num">${owner.charges}</td>
      <td class="num">${escapeHtml(formatMxn(owner.paidCents))}</td>
      <td class="num">${escapeHtml(formatMxn(owner.pendingCents))}</td>
      <td class="num">${owner.contacts} / ${owner.notes}</td>
      <td>${escapeHtml(when(owner.lastActivity || null))}</td>
    </tr>`,
          )
          .join("");
  return `<h1>Usuarios</h1>
<div class="panel scroll">
  <table>
    <thead><tr><th>Celular</th><th class="num">Cobros</th><th class="num">Pagado</th><th class="num">Pendiente</th><th class="num">Contactos / apuntes</th><th>Última actividad</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

function noteRows(notes: Note[]): string {
  if (notes.length === 0) return `<tr><td colspan="4"><p class="empty">Sin apuntes.</p></td></tr>`;
  return notes
    .map(
      (note) => `<tr>
      <td>${escapeHtml(when(note.createdAt))}</td>
      <td>${escapeHtml(NOTE_LABEL[note.kind])}</td>
      <td class="wrap">${escapeHtml(note.concept)}${note.who ? ` · ${escapeHtml(note.who)}` : ""}</td>
      <td class="num">${escapeHtml(formatMxn(note.amountCents))}</td>
    </tr>`,
    )
    .join("");
}

function contactRows(contacts: Contact[]): string {
  if (contacts.length === 0) return `<tr><td colspan="2"><p class="empty">Sin contactos.</p></td></tr>`;
  return contacts
    .map(
      (contact) =>
        `<tr><td>${escapeHtml(contact.name)}</td><td>${escapeHtml(maskPhone(contact.phone))}</td></tr>`,
    )
    .join("");
}

export function renderOwnerDetail(detail: OwnerDetail, metrics: Metrics): string {
  return `<h1>${escapeHtml(maskPhone(detail.owner))}</h1>
<p class="note"><a href="/admin/usuarios">← Volver a usuarios</a></p>
<div class="cards">
  ${card("Cobros", String(detail.charges.length))}
  ${card("Pagado", formatMxn(metrics.paidCents), `${metrics.paidCount} cobro(s)`)}
  ${card("Pendiente", formatMxn(metrics.pendingCents), `${metrics.pendingCount} cobro(s)`)}
  ${card("Hoy confirmado", formatMxn(metrics.todayCents), `Tope ${formatMxn(metrics.capCents)}`)}
</div>
<h2>Cobros</h2>
<div class="panel scroll">
  <table>
    <thead><tr><th>Fecha</th><th>Concepto</th><th>Pagador</th><th>Celular</th><th class="num">Monto</th><th>Método</th><th>Estado</th></tr></thead>
    <tbody>${chargeRows(detail.charges.slice(0, 100), false)}</tbody>
  </table>
</div>
<h2>Apuntes</h2>
<div class="panel scroll">
  <table>
    <thead><tr><th>Fecha</th><th>Tipo</th><th>Concepto</th><th class="num">Monto</th></tr></thead>
    <tbody>${noteRows(detail.notes.slice(0, 50))}</tbody>
  </table>
</div>
<h2>Contactos</h2>
<div class="panel scroll">
  <table>
    <thead><tr><th>Nombre</th><th>Celular</th></tr></thead>
    <tbody>${contactRows(detail.contacts)}</tbody>
  </table>
</div>`;
}

export interface SettingsView {
  dailyCapCents: number;
  allowedPhones: string[];
  publicBaseUrl: string | null;
  peyApiBase: string;
  dataPath: string;
  model: string;
  transcribeModel: string;
  pushExpirationSec: number;
  qrExpirationSec: number;
  confirmWindowMs: number;
  admins: string[];
  sessionHours: number;
}

export function renderSettings(view: SettingsView): string {
  const allowlist =
    view.allowedPhones.length === 0
      ? "Vacía: acepta a quien escriba"
      : view.allowedPhones.map(maskPhone).join(", ");
  const rows: [string, string][] = [
    ["Tope diario", formatMxn(view.dailyCapCents)],
    ["Lista blanca", allowlist],
    ["URL pública", view.publicBaseUrl ?? "Sin configurar (el link de pago no funciona)"],
    ["API de Pey", view.peyApiBase],
    ["Archivo de datos", view.dataPath],
    ["Modelo", view.model],
    ["Modelo de transcripción", view.transcribeModel],
    ["Vida del push CoDi", `${view.pushExpirationSec} s`],
    ["Vida del QR CoDi", `${view.qrExpirationSec} s`],
    ["Ventana de confirmación", `${Math.round(view.confirmWindowMs / 60_000)} min`],
    ["Administradores", view.admins.join(", ")],
    ["Sesión del panel", `${view.sessionHours} h`],
  ];
  const list = rows
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
  return `<h1>Ajustes</h1>
<div class="panel"><dl class="kv">${list}</dl></div>
<p class="note">Solo lectura. Estos valores vienen del <code>.env</code>; cámbialos ahí y reinicia el servidor. Las llaves de Pey, WhatsApp y OpenRouter nunca se muestran aquí.</p>`;
}

const PAYABLE_LABEL: Record<string, string> = {
  PAYMENT_LINK: "Link de pago",
  API_CODI_QR: "CoDi QR",
  API_CODI_PN: "CoDi push",
};

const MISMATCH_LABEL: Record<Mismatch["kind"], string> = {
  pagado_en_pey_no_en_zaldo: "Pagado en Pey, no en Zaldo",
  pagado_en_zaldo_no_en_pey: "Pagado en Zaldo, no en Pey",
  monto_distinto: "Monto distinto",
  sin_cobro_local: "Sin cobro local",
};

function txRows(transactions: Reconciliation["transactions"]): string {
  if (transactions.length === 0) {
    return `<tr><td colspan="7"><p class="empty">Pey no reporta transacciones en la ventana.</p></td></tr>`;
  }
  return transactions
    .slice(0, 100)
    .map((tx) => {
      const fee = tx.breakdown ? formatMxn(tx.breakdown.feeCents) : "—";
      const tag = tx.status === "PAID" ? "paid" : "pending";
      const label = tx.status === "PAID" ? "Pagado" : "Pendiente";
      return `<tr>
      <td>${escapeHtml(when(tx.datePaid ?? tx.dateCreated))}</td>
      <td class="wrap">${escapeHtml(tx.description ?? "—")}</td>
      <td class="num">${escapeHtml(formatMxn(tx.amountCents))}</td>
      <td class="num">${escapeHtml(fee)}</td>
      <td>${escapeHtml(tx.paymentMethod ?? "—")}</td>
      <td>${escapeHtml(tx.payableType ? (PAYABLE_LABEL[tx.payableType] ?? tx.payableType) : "—")}</td>
      <td><span class="tag ${tag}">${escapeHtml(label)}</span></td>
    </tr>`;
    })
    .join("");
}

function mismatchRows(mismatches: Mismatch[], csrfToken: string): string {
  if (mismatches.length === 0) {
    return `<tr><td colspan="4"><p class="empty">Todo cuadra: el libro de Zaldo coincide con Pey.</p></td></tr>`;
  }
  return mismatches
    .map((item) => {
      // Solo el webhook perdido se puede reparar sin ambigüedad.
      const repairable = item.kind === "pagado_en_pey_no_en_zaldo" && item.chargeId && item.transactionId;
      const action = repairable
        ? `<form method="post" action="/admin/conciliacion/reparar" style="margin:0">
        <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
        <input type="hidden" name="chargeId" value="${escapeHtml(item.chargeId ?? "")}">
        <input type="hidden" name="transactionId" value="${escapeHtml(item.transactionId ?? "")}">
        <button type="submit" class="repair">Marcar pagado</button>
      </form>`
        : `<span class="note">Revisar a mano</span>`;
      return `<tr>
      <td><span class="tag ${item.kind === "monto_distinto" ? "failed" : "pending"}">${escapeHtml(MISMATCH_LABEL[item.kind])}</span></td>
      <td class="wrap">${escapeHtml(item.detail)}</td>
      <td class="num">${escapeHtml(formatMxn(item.amountCents))}</td>
      <td>${action}</td>
    </tr>`;
    })
    .join("");
}

export interface ReconcileBanner {
  kind: "ok" | "error";
  text: string;
}

export function renderReconcile(
  result: Reconciliation,
  csrfToken: string,
  banner?: ReconcileBanner,
): string {
  const t = result.totals;
  const notice = banner
    ? `<p class="flash ${banner.kind}">${escapeHtml(banner.text)}</p>`
    : "";
  const error = result.error
    ? `<p class="flash error">No pude leer Pey: ${escapeHtml(result.error)}. Lo de abajo puede estar atrasado.</p>`
    : "";
  const truncated = result.truncated
    ? `<p class="note">Hay más transacciones de las que leí; se muestran las más recientes.</p>`
    : "";
  const cards = [
    card("Cobrado en Pey", formatMxn(t.paidCents), `${t.paidCount} transacción(es) pagada(s)`),
    card("Comisiones", formatMxn(t.feeCents), "Lo que Pey descontó"),
    card("Neto a tu cuenta", formatMxn(t.netCents), "Cobrado menos comisiones"),
    card("Pendiente en Pey", formatMxn(t.pendingCents), `${t.pendingCount} sin pagar`),
    card("Por CoDi", formatMxn(t.byMethod.codi)),
    card("Por tarjeta", formatMxn(t.byMethod.card)),
  ].join("");

  return `<h1>Conciliación con Pey</h1>
${notice}${error}
<div class="actions">
  <span class="note">Datos de Pey al ${escapeHtml(when(result.fetchedAt))}</span>
  <a class="btn" href="/admin/conciliacion?refrescar=1">Actualizar</a>
</div>
<div class="cards">${cards}</div>
${truncated}
<h2>Descuadres</h2>
<div class="panel scroll">
  <table>
    <thead><tr><th>Tipo</th><th>Detalle</th><th class="num">Monto</th><th>Acción</th></tr></thead>
    <tbody>${mismatchRows(result.mismatches, csrfToken)}</tbody>
  </table>
</div>
<p class="note">«Marcar pagado» vuelve a preguntarle a Pey y solo corrige el libro de Zaldo. No cobra, no reenvía nada y no mueve dinero.</p>
<h2>Transacciones en Pey</h2>
<div class="panel scroll">
  <table>
    <thead><tr><th>Fecha</th><th>Descripción</th><th class="num">Monto</th><th class="num">Comisión</th><th>Método</th><th>Origen</th><th>Estado</th></tr></thead>
    <tbody>${txRows(result.transactions)}</tbody>
  </table>
</div>`;
}
