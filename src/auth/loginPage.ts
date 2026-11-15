/** Escapa texto que entra al HTML. Todo lo que venga de fuera pasa por aquí. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface LoginPageInput {
  csrfToken: string;
  /** Mensaje de error ya en español, listo para mostrar. */
  error?: string;
  /** A dónde ir después de entrar. Ya validado como ruta interna. */
  next?: string;
  user?: string;
}

export function renderLoginPage(input: LoginPageInput): string {
  const error = input.error
    ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>`
    : "";
  const next = input.next
    ? `<input type="hidden" name="next" value="${escapeHtml(input.next)}">`
    : "";
  const user = input.user ? escapeHtml(input.user) : "";
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Entrar · Zaldo</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#16181d;--muted:#5d6470;--line:#e3e6ea;--accent:#1f6feb;--error:#b42318;--error-bg:#fef3f2}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a20;--text:#eceef2;--muted:#9aa3b0;--line:#272b33;--accent:#4c8dff;--error:#ff9c92;--error-bg:#2a1512}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px 28px}
h1{margin:0 0 4px;font-size:1.5rem;letter-spacing:-.01em}
.sub{margin:0 0 24px;color:var(--muted);font-size:.9rem}
label{display:block;margin-bottom:6px;font-size:.85rem;font-weight:600}
input[type=text],input[type=password]{width:100%;padding:11px 12px;margin-bottom:18px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font-size:1rem}
input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button{width:100%;padding:12px;border:0;border-radius:8px;background:var(--accent);color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{filter:brightness(1.08)}
.error{margin:0 0 18px;padding:10px 12px;border-radius:8px;background:var(--error-bg);color:var(--error);font-size:.88rem}
footer{margin-top:22px;color:var(--muted);font-size:.78rem;text-align:center}
</style>
</head>
<body>
<main>
  <h1>Zaldo</h1>
  <p class="sub">Panel administrador</p>
  ${error}
  <form method="post" action="/admin/login" autocomplete="on">
    <input type="hidden" name="csrf" value="${escapeHtml(input.csrfToken)}">
    ${next}
    <label for="user">Usuario</label>
    <input id="user" name="user" type="text" value="${user}" autocomplete="username" required autofocus spellcheck="false">
    <label for="password">Contraseña</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Entrar</button>
  </form>
  <footer>Acceso restringido</footer>
</main>
</body>
</html>`;
}
