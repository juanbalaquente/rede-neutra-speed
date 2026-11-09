/**
 * Validação do caminho crítico (thread 1 do plano), SÓ LEITURA.
 *
 * Roda a partir de um servidor liberado no Codemaps/OLTCloud/Voalle (hoje o
 * da SpeedWiki, 179.106.108.48) com as mesmas credenciais dela:
 *
 *   INTEGRATIONS_MODE=real npx tsx src/scripts/validate-integrations.ts "Rua X, 100, Belo Horizonte"
 *
 * Nada aqui cria, altera ou apaga dado em nenhum sistema. O objetivo é
 * responder: as APIs que o portal precisa existem e respondem com esta conta?
 */
import { loadConfig } from "../config.js";
import { CodemapsClient } from "../integrations/codemaps.js";
import { createHttp } from "../integrations/http.js";
import { OltcloudClient } from "../integrations/oltcloud.js";
import { VoalleClient } from "../integrations/voalle.js";

type Status = "ok" | "falhou" | "pulado" | "atencao";
const results: { system: string; check: string; status: Status; detail: string }[] = [];

function report(system: string, check: string, status: Status, detail: string) {
  results.push({ system, check, status, detail });
  const icon = { ok: "✅", falhou: "❌", pulado: "⏭️ ", atencao: "⚠️ " }[status];
  console.log(`${icon} [${system}] ${check}: ${detail}`);
}

async function step(system: string, check: string, fn: () => Promise<string | { status: Status; detail: string }>) {
  try {
    const out = await fn();
    if (typeof out === "string") report(system, check, "ok", out);
    else report(system, check, out.status, out.detail);
    return true;
  } catch (e) {
    report(system, check, "falhou", e instanceof Error ? e.message : String(e));
    return false;
  }
}

const config = loadConfig();
const address = process.argv[2] ?? "Avenida Afonso Pena, 1212, Belo Horizonte, MG";
const quietLog = () => {};

// ── Codemaps ────────────────────────────────────────────────────────────────
let firstCtoName: string | null = null;
if (config.CODEMAPS_TOKEN && config.CODEMAPS_SECRET) {
  const cm = new CodemapsClient(createHttp("codemaps", quietLog), config.CODEMAPS_TOKEN, config.CODEMAPS_SECRET);
  await step("codemaps", "viabilidade por endereço", async () => {
    const r = await cm.findNearby(address, 300);
    firstCtoName = r.ctos[0]?.name ?? null;
    return `${r.ctos.length} CTO(s) em 300m de "${address}"${firstCtoName ? `, mais próxima ${firstCtoName}` : ""}`;
  });
} else report("codemaps", "credenciais", "pulado", "CODEMAPS_TOKEN/CODEMAPS_SECRET não definidos");

// ── OLTCloud ────────────────────────────────────────────────────────────────
if (config.OLTCLOUD_USER && config.OLTCLOUD_PASS) {
  const oc = new OltcloudClient(createHttp("oltcloud", quietLog), config.OLTCLOUD_BASE, config.OLTCLOUD_USER, config.OLTCLOUD_PASS);

  await step("oltcloud", "lista de ONUs", async () => {
    const page = await oc.get<{ count?: number }>("/api/v2/ftth/equipment/list?page_size=1");
    return `${page.count ?? "?"} ONUs visíveis para esta conta`;
  });

  if (firstCtoName) {
    const name = firstCtoName;
    await step("oltcloud", "caixa da CTO do Codemaps", async () => {
      const vagas = await oc.getCtoVagas(name);
      if (!vagas) return { status: "atencao", detail: `"${name}" não achada no box/list (nome diverge entre Codemaps e OLTCloud?)` };
      return `${vagas.name}: ${vagas.totalVagas} saídas, ${vagas.vagasLivres} livres na caixa (modo direto, só validação)`;
    });
  } else report("oltcloud", "caixa da CTO do Codemaps", "pulado", "sem CTO do Codemaps para cruzar");

  // O ponto que decide o desenho: existe rota de autorização de ONU na API?
  await step("oltcloud", "rotas de liberação de ONU na API", async () => {
    const schema = await oc.get<{ paths?: Record<string, Record<string, unknown>> }>("/api/schema?format=json");
    const re = /authoriz|unauthoriz|autoriz|provision|unprovision|whitelist|onu\/add|discover/i;
    const hits = Object.entries(schema.paths ?? {})
      .filter(([path]) => re.test(path))
      .map(([path, methods]) => `${Object.keys(methods).map((m) => m.toUpperCase()).join("/")} ${path}`);
    if (hits.length === 0) {
      return { status: "atencao", detail: "nenhuma rota de autorização/provisionamento no schema da API v2" };
    }
    return `${hits.length} rota(s): ${hits.join(" | ")}`;
  });
} else report("oltcloud", "credenciais", "pulado", "OLTCLOUD_USER/OLTCLOUD_PASS não definidos");

// ── Voalle ──────────────────────────────────────────────────────────────────
if (config.VOALLE_ERP_URL && config.VOALLE_CLIENT_ID && config.VOALLE_CLIENT_SECRET && config.VOALLE_SYNDATA) {
  const vl = new VoalleClient(
    createHttp("voalle", quietLog),
    config.VOALLE_ERP_URL.replace(/\/$/, ""),
    config.VOALLE_CLIENT_ID,
    config.VOALLE_CLIENT_SECRET,
    config.VOALLE_SYNDATA,
  );
  await step("voalle", "autenticação na API thirdparty", async () => {
    await vl.getToken();
    return "token obtido";
  });
  report(
    "voalle",
    "criação de contrato com ponto de acesso",
    "atencao",
    "não testável só lendo: precisa de ambiente de teste do Voalle e da regra de concentrador por OLT/região",
  );
} else report("voalle", "credenciais", "pulado", "VOALLE_* não definidos");

const failed = results.filter((r) => r.status === "falhou").length;
console.log(`\nResumo: ${results.length} verificações, ${failed} falha(s).`);
process.exit(failed ? 1 : 0);
