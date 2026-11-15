import { ReconcileCache } from "./admin/reconcile.js";
import { authEnabled, loadAuthConfig } from "./auth/config.js";
import { AuthService } from "./auth/service.js";
import { loadConfig } from "./config.js";
import { loadEnvFile } from "./envFile.js";
import { fileStore } from "./fileStore.js";
import type { FlowDeps } from "./flows.js";
import { openRouterCompleter, transcribeWithOpenRouter } from "./openrouter.js";
import { PeyClient } from "./pey.js";
import { createApp, startSweeper } from "./server.js";
import { WhatsApp } from "./whatsapp.js";

loadEnvFile();
const config = loadConfig();
const store = fileStore(config.dataPath);
const pey = new PeyClient(config.peyApiBase, config.peyKey, fetch, { bankAccountId: config.peyBankAccountId });
const whatsapp = new WhatsApp(config.whatsappToken, config.whatsappPhoneNumberId);
const complete = openRouterCompleter(config);

const flows: FlowDeps = {
  store,
  config,
  pey,
  complete,
  now: () => Date.now(),
  transcribe: async (mediaId, mime) => {
    const bytes = await whatsapp.downloadMedia(mediaId);
    return transcribeWithOpenRouter(config, bytes, mime);
  },
};

const authConfig = loadAuthConfig();
const auth = new AuthService(authConfig);
// El panel lee las transacciones reales de Pey con la misma API key.
const admin = authEnabled(authConfig)
  ? { auth, authConfig, reconcile: new ReconcileCache(pey, store) }
  : undefined;

const app = createApp({ config, flows, whatsapp, admin });
const sweeper = startSweeper(flows, whatsapp, admin ? auth : undefined);
app.listen(config.port, () => {
  console.log(`Zaldo escuchando en :${config.port}`);
  if (admin) {
    console.log(`Panel administrador en /admin (${authConfig.users.length} admin(s))`);
  } else {
    console.log("Panel apagado: falta ADMIN_USERS o ADMIN_SESSION_SECRET. Usa npm run admin:hash.");
  }
});

function shutdown(): void {
  clearInterval(sweeper);
  app.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
