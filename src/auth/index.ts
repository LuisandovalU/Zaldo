/**
 * Login del panel administrador. Módulo cerrado: nada de aquí sabe de cobros,
 * y el resto de Zaldo solo necesita loadAuthConfig, AuthService,
 * handleAuthRoutes y requireSession.
 */
export { authEnabled, loadAuthConfig, parseAdminUsers, type AdminUser, type AuthConfig } from "./config.js";
export { escapeHtml, renderLoginPage } from "./loginPage.js";
export { hashPassword, verifyPassword } from "./password.js";
export { handleAuthRoutes, requireSession, safeNext, type AuthRouteDeps } from "./routes.js";
export { AuthService, type LoginResult } from "./service.js";
export {
  buildCookie,
  clearCookie,
  createSession,
  csrfOk,
  newCsrfToken,
  parseCookies,
  readSession,
  CSRF_COOKIE,
  SESSION_COOKIE,
  type Session,
} from "./session.js";
export { Throttle } from "./throttle.js";
