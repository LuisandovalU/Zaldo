import { escapeHtml } from "../auth/loginPage.js";

export { escapeHtml };

export interface LayoutInput {
  title: string;
  /** Pestaña activa, para marcarla en el menú. */
  active: "resumen" | "cobros" | "usuarios" | "conciliacion" | "ajustes";
  user: string;
  csrfToken: string;
  body: string;
}

const NAV: { href: string; label: string; key: LayoutInput["active"] }[] = [
  { href: "/admin", label: "Resumen", key: "resumen" },
  { href: "/admin/cobros", label: "Cobros", key: "cobros" },
  { href: "/admin/usuarios", label: "Usuarios", key: "usuarios" },
  { href: "/admin/conciliacion", label: "Conciliación", key: "conciliacion" },
  { href: "/admin/ajustes", label: "Ajustes", key: "ajustes" },
];

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#16181d;--muted:#5d6470;--line:#e3e6ea;--accent:#1f6feb;--ok:#067647;--ok-bg:#ecfdf3;--warn:#b54708;--warn-bg:#fffaeb;--bad:#b42318;--bad-bg:#fef3f2;--neutral-bg:#f2f4f7}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--text:#eceef2;--muted:#9aa3b0;--line:#272b33;--accent:#4c8dff;--ok:#75e0a7;--ok-bg:#0d2a1d;--warn:#fec84b;--warn-bg:#2b1f08;--bad:#ff9c92;--bad-bg:#2a1512;--neutral-bg:#1f242c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:14px 20px;background:var(--card);border-bottom:1px solid var(--line)}
.brand{font-weight:700;font-size:1.1rem;letter-spacing:-.01em}
nav{display:flex;flex-wrap:wrap;gap:4px}
nav a{padding:7px 13px;border-radius:999px;text-decoration:none;color:var(--muted);font-size:.9rem;font-weight:500}
nav a[aria-current=page]{background:var(--accent);color:#fff}
.who{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:.85rem}
.who button{padding:6px 12px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--text);font-size:.85rem;cursor:pointer}
main{max-width:1180px;margin:0 auto;padding:24px 20px 56px}
h1{margin:0 0 20px;font-size:1.4rem;letter-spacing:-.01em}
h2{margin:30px 0 12px;font-size:1.05rem}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.card .k{margin:0 0 6px;color:var(--muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.05em}
.card .v{margin:0;font-size:1.6rem;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.card .n{margin:6px 0 0;color:var(--muted);font-size:.8rem}
.bar{height:7px;margin-top:10px;border-radius:999px;background:var(--neutral-bg);overflow:hidden}
.bar span{display:block;height:100%;background:var(--accent)}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--muted);font-size:.76rem;text-transform:uppercase;letter-spacing:.04em;font-weight:600}
tbody tr:last-child td{border-bottom:0}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.wrap{white-space:normal;min-width:180px}
.tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.75rem;font-weight:600}
.tag.paid{background:var(--ok-bg);color:var(--ok)}
.tag.pending{background:var(--warn-bg);color:var(--warn)}
.tag.failed,.tag.expired{background:var(--bad-bg);color:var(--bad)}
.tag.cancelled,.tag.awaiting_confirm{background:var(--neutral-bg);color:var(--muted)}
form.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:16px;padding:14px;background:var(--card);border:1px solid var(--line);border-radius:12px}
form.filters label{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:.76rem;text-transform:uppercase;letter-spacing:.04em;font-weight:600}
form.filters input,form.filters select{padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--text);font-size:.9rem}
form.filters button{padding:9px 16px;border:0;border-radius:7px;background:var(--accent);color:#fff;font-size:.9rem;font-weight:600;cursor:pointer}
.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:16px}
.btn{display:inline-block;padding:8px 14px;border:1px solid var(--line);border-radius:7px;background:var(--card);color:var(--text);text-decoration:none;font-size:.88rem}
.pager{display:flex;gap:10px;align-items:center;justify-content:center;margin-top:16px;color:var(--muted);font-size:.86rem}
.empty{padding:34px 20px;text-align:center;color:var(--muted)}
.chart{display:flex;align-items:flex-end;gap:6px;height:150px;padding:16px;background:var(--card);border:1px solid var(--line);border-radius:12px}
.chart .col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:5px;height:100%;min-width:0}
.chart .stack{position:relative;width:100%;max-width:34px;background:var(--neutral-bg);border-radius:4px 4px 0 0;overflow:hidden}
.chart .stack i{position:absolute;left:0;right:0;bottom:0;display:block;background:var(--accent)}
.chart .lbl{color:var(--muted);font-size:.65rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.legend{display:flex;gap:16px;margin:10px 0 0;color:var(--muted);font-size:.8rem}
.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:middle}
dl.kv{display:grid;grid-template-columns:auto 1fr;gap:8px 18px;margin:0;padding:16px}
dl.kv dt{color:var(--muted);font-size:.84rem}
dl.kv dd{margin:0;font-size:.9rem;font-variant-numeric:tabular-nums;word-break:break-word}
.note{color:var(--muted);font-size:.84rem}
.flash{margin:0 0 16px;padding:11px 14px;border-radius:9px;font-size:.88rem}
.flash.ok{background:var(--ok-bg);color:var(--ok)}
.flash.error{background:var(--bad-bg);color:var(--bad)}
button.repair{padding:6px 12px;border:0;border-radius:7px;background:var(--accent);color:#fff;font-size:.82rem;font-weight:600;cursor:pointer}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.86em}
@media (max-width:640px){header{padding:12px 14px}main{padding:18px 14px 44px}.card .v{font-size:1.35rem}}
`;

export function renderLayout(input: LayoutInput): string {
  const nav = NAV.map(
    (item) =>
      `<a href="${item.href}"${item.key === input.active ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}</a>`,
  ).join("");
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(input.title)} · Zaldo</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <span class="brand">Zaldo</span>
  <nav>${nav}</nav>
  <div class="who">
    <span>${escapeHtml(input.user)}</span>
    <form method="post" action="/admin/logout">
      <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
      <button type="submit">Salir</button>
    </form>
  </div>
</header>
<main>
${input.body}
</main>
</body>
</html>`;
}
