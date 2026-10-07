import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { apiCallLog } from "./db/schema.js";
import { createIntegrations } from "./integrations/index.js";
import { expireOverdueReservations } from "./services/reservations.js";

const config = loadConfig();
const { db } = createDb(config.DATABASE_URL);

const integrations = createIntegrations(config, (record) => {
  // Log de chamada não pode derrubar a requisição.
  db.insert(apiCallLog).values(record).catch((e) => console.error("api_call_log", e));
});

const app = createApp({ db, config, integrations });

// Expira reservas vencidas a cada minuto (também expira sob demanda nas rotas).
setInterval(() => {
  expireOverdueReservations(db).catch((e) => console.error("expirar reservas", e));
}, 60_000);

// Avisa no log quando a integração cai ou a chave da Wiki é recusada (o administrador também vê em /admin/integrations/health).
let lastHealthy = true;
async function checkIntegrations() {
  const h = await integrations.network.health();
  if (!h.ok) console.error(`[integração] FORA: ${h.detail}`);
  else if (!lastHealthy) console.log(`[integração] voltou: ${h.detail}`);
  lastHealthy = h.ok;
}
void checkIntegrations();
setInterval(() => void checkIntegrations(), 5 * 60_000);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`API Rede Neutra em http://localhost:${info.port} (integrações: ${config.INTEGRATIONS_MODE})`);
});
