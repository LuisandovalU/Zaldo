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
const pey = new PeyClient(config.peyApiBase, config.peyKey);
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

const app = createApp({ config, flows, whatsapp });
const sweeper = startSweeper(flows, whatsapp);
app.listen(config.port, () => {
  console.log(`Zaldo escuchando en :${config.port}`);
});

function shutdown(): void {
  clearInterval(sweeper);
  app.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
