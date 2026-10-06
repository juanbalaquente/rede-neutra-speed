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

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`API Rede Neutra em http://localhost:${info.port} (integrações: ${config.INTEGRATIONS_MODE})`);
});
