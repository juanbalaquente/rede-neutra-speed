import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { activations, partners, plans, portReservations } from "../db/schema.js";
import { IntegrationError, type ClientStatus, type ClientStatusService, type ClientSummary, type FibraEstado, type OnuDetail } from "../integrations/types.js";
import { AppError } from "../lib/errors.js";

/**
 * Tela "ONUs": o suporte do parceiro vê todas as ONUs dos seus clientes e, ao abrir uma, um diagnóstico
 * ao vivo do OLTCloud (contrato v3, seção I) traduzido em português. Só leitura: nada aqui mexe na rede.
 */

/** Wi-Fi abaixo disso é sinal ruim no aparelho (mesma régua da tela "Consultar ONU" da Wiki). */
const WIFI_RUIM_DBM = -70;
/** Porta da OLT com esta fração de ONUs fora do ar é falha na rede, não do cliente. */
const PON_MASSIVA = 0.3;
const TEMPERATURA_ALTA_C = 70;

export type OnuProblema = "falha_rede" | "sem_luz" | "sem_energia" | "offline" | "desabilitada" | "pppoe_caido" | "sinal_fraco";

const minimo = (sinalCtoDbm: number, limiteDb: number) => Number((sinalCtoDbm - limiteDb).toFixed(2));

async function partnerCode(db: Db, partnerId: string) {
  const [p] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, partnerId));
  if (!p?.code) throw new AppError(422, "codigo_parceiro_ausente", "O parceiro ainda não tem código cadastrado.");
  return p.code;
}

function requireSvc(svc: ClientStatusService | undefined): ClientStatusService {
  if (!svc) throw new AppError(503, "status_desligado", "A leitura das ONUs ainda não está habilitada.");
  return svc;
}

/** Problema do item da lista, pelo snapshot. Cliente bloqueado não é problema: está sem internet de propósito. */
function problemaDaLista(s: ClientSummary | undefined, minimoDbm: number, bloqueado: boolean): OnuProblema | null {
  if (!s || bloqueado) return null;
  if (s.fibra === "loss") return "sem_luz";
  if (s.fibra === "sem_energia") return "sem_energia";
  if (s.fibra === "offline") return "offline";
  if (s.fibra === "inativo" || s.fibra === "desabilitada") return "desabilitada";
  if (s.fibra === "online" && s.autenticacao === "desconectado") return "pppoe_caido";
  if (s.fibra === "online" && s.sinalDbm != null && s.sinalDbm < minimoDbm) return "sinal_fraco";
  return null;
}

/** Todas as ONUs do parceiro da sessão (O.S. fechada, cliente não cancelado), com o estado do snapshot da Wiki. */
export async function listOnus(db: Db, svc: ClientStatusService | undefined, user: SessionUser) {
  const service = requireSvc(svc);
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Tela disponível só para o parceiro.");
  const code = await partnerCode(db, user.partnerId);

  const rows = await db
    .select({
      id: portReservations.id,
      contract: portReservations.contractNumber,
      nickname: portReservations.nickname,
      ctoName: portReservations.ctoName,
      address: portReservations.address,
      customerStatus: portReservations.customerStatus,
      plan: plans.name,
      login: activations.pppLogin,
      serial: activations.serial,
      sinalCtoDbm: activations.sinalCtoDbm,
      limiteDb: activations.limiteDb,
      createdAt: activations.createdAt,
    })
    .from(portReservations)
    .innerJoin(activations, and(eq(activations.reservationId, portReservations.id), eq(activations.state, "online")))
    .leftJoin(plans, eq(plans.id, portReservations.planId))
    .where(and(eq(portReservations.partnerId, user.partnerId), eq(portReservations.status, "convertida"), isNotNull(portReservations.osClosedAt), ne(portReservations.customerStatus, "cancelado")))
    .orderBy(desc(activations.createdAt));

  // Uma linha por cliente: a ativação online mais recente vale (reativação gera outra).
  const seen = new Set<string>();
  const unique = rows.filter((r) => !seen.has(r.id) && seen.add(r.id));

  let summary = new Map<string, ClientSummary>();
  let leituraIndisponivel = false;
  if (unique.length) {
    try {
      summary = new Map((await service.summary(unique.map((r) => r.login), code)).map((s) => [s.login, s]));
    } catch (e) {
      // A lista continua útil sem a Wiki: o suporte acha o cliente e abre o detalhe.
      console.error("[onus] lote falhou:", e instanceof Error ? e.message : e);
      leituraIndisponivel = true;
    }
  }

  let atualizadoEm: number | null = null;
  const onus = unique.map((r) => {
    const s = summary.get(r.login);
    const minimoDbm = minimo(r.sinalCtoDbm, r.limiteDb);
    const bloqueado = r.customerStatus === "bloqueado" || s?.contrato === "bloqueado" || s?.bloqueio?.ativo === true;
    if (s?.fibraEm && (atualizadoEm === null || new Date(s.fibraEm).getTime() < atualizadoEm)) atualizadoEm = new Date(s.fibraEm).getTime();
    return {
      reservationId: r.id,
      contract: r.contract,
      nickname: r.nickname,
      login: r.login,
      serial: r.serial,
      ctoName: r.ctoName,
      address: r.address,
      plan: r.plan,
      fibra: (s?.fibra ?? "desconhecido") as FibraEstado,
      autenticacao: s?.autenticacao ?? "desconhecido",
      sinalDbm: s?.sinalDbm ?? null,
      minimoDbm,
      bloqueado,
      problema: problemaDaLista(s, minimoDbm, bloqueado),
    };
  });
  return { onus, leituraIndisponivel, atualizadoEm: atualizadoEm === null ? null : new Date(atualizadoEm).toISOString() };
}

export interface Achado {
  tom: "ok" | "warn" | "bad" | "mute";
  codigo: OnuProblema | "bloqueado" | "wifi_fraco" | "temperatura" | "sem_leitura" | "tudo_certo";
  titulo: string;
  texto: string;
  /** O que a tela oferece ao lado do achado. */
  acao: "chamado" | "reiniciar" | "desbloquear" | null;
}

const fmt = (n: number) => `${n.toFixed(1).replace(".", ",")} dBm`;

/**
 * Diagnóstico em português, na ordem em que o suporte deve agir: primeiro o que não é culpa do cliente (porta da OLT caída),
 * depois o físico (luz, energia), depois cadastro (PPPoE) e por fim o que é dentro da casa (Wi-Fi).
 */
export function diagnose(input: { detalhe: OnuDetail | null; status: ClientStatus | null; minimoDbm: number; bloqueado: boolean; login: string }): Achado[] {
  const { detalhe, status, minimoDbm, bloqueado, login } = input;
  if (bloqueado) {
    return [{ tom: "warn", codigo: "bloqueado", titulo: "Cliente bloqueado", texto: "Sem internet por bloqueio: o Wi-Fi aparece, mas não navega. Desbloqueie para religar (leva de 20 s a 1 min e meio).", acao: "desbloquear" }];
  }
  const estado: FibraEstado = detalhe?.onu.estado ?? status?.fibra.estado ?? "desconhecido";
  const rx = detalhe ? detalhe.onu.rxDbm : (status?.fibra.sinalDbm ?? null);
  const pon = detalhe?.pon ?? null;
  const out: Achado[] = [];

  if (estado !== "online") {
    if (estado !== "desconhecido" && pon && pon.onus > 0 && pon.offline / pon.onus >= PON_MASSIVA) {
      return [{ tom: "bad", codigo: "falha_rede", titulo: "Falha na rede da Speed", texto: `${pon.offline} de ${pon.onus} ONUs desta porta da OLT estão fora do ar ao mesmo tempo. Não é problema do cliente nem da instalação: abra um chamado de rompimento ou queda regional.`, acao: "chamado" }];
    }
    const porEstado: Partial<Record<FibraEstado, Achado>> = {
      loss: { tom: "bad", codigo: "sem_luz", titulo: "Sem luz chegando na ONU", texto: "A fibra não entrega sinal: cabo rompido, dobrado ou desconectado entre a CTO e a casa, ou conector sujo. Peça ao cliente para conferir se o cabo de fibra não foi puxado; se estiver no lugar, agende uma visita.", acao: "chamado" },
      sem_energia: { tom: "warn", codigo: "sem_energia", titulo: "ONU sem energia", texto: "A ONU avisou que perdeu energia: desligada da tomada, fonte queimada ou falta de luz na casa. Peça ao cliente para conferir a fonte e a tomada.", acao: null },
      offline: { tom: "bad", codigo: "offline", titulo: "ONU fora do ar", texto: "A ONU parou de responder sem avisar falta de energia nem perda de luz. Peça ao cliente para desligar e ligar a ONU; se não voltar em 3 minutos, agende uma visita.", acao: "chamado" },
      inativo: { tom: "warn", codigo: "desabilitada", titulo: "ONU inativa na rede", texto: "A ONU está registrada mas não ativa na OLT. Abra um chamado para a Speed conferir.", acao: "chamado" },
      desabilitada: { tom: "warn", codigo: "desabilitada", titulo: "ONU desabilitada na rede", texto: "A ONU está desabilitada na OLT sem bloqueio registrado no portal. Abra um chamado para a Speed conferir.", acao: "chamado" },
    };
    out.push(porEstado[estado] ?? { tom: "mute", codigo: "sem_leitura", titulo: "Sem leitura da ONU", texto: "A rede não respondeu agora. Tente atualizar em instantes.", acao: null });
    return out;
  }

  if (rx !== null && rx < minimoDbm) {
    const media = pon?.mediaRxDbm ?? null;
    const comparacao = media !== null ? ` A média da porta é ${fmt(media)}, então o problema é deste cliente (cabo, conector ou emenda até a casa).` : "";
    out.push({ tom: "warn", codigo: "sinal_fraco", titulo: "Sinal abaixo do mínimo da instalação", texto: `A ONU recebe ${fmt(rx)} e o mínimo desta instalação é ${fmt(minimoDbm)} (medido na CTO menos o limite).${comparacao} Pode causar lentidão e quedas: abra um chamado de sinal.`, acao: "chamado" });
  }
  if (status?.autenticacao.estado === "desconectado") {
    out.push({ tom: "bad", codigo: "pppoe_caido", titulo: "Fibra boa, PPPoE caído", texto: `A fibra está no ar mas o roteador não autentica. Reinicie a ONU pelo portal; se não voltar, confira se o roteador está em PPPoE com o login ${login}.`, acao: "reiniciar" });
  } else if (status?.autenticacao.motivo === "aguardando_leitura_apos_religar") {
    // A ONU religou depois da última leitura do NE40; a Wiki grava uma nova em ~1 min (29 out 2026).
    out.push({ tom: "mute", codigo: "sem_leitura", titulo: "Verificando conexão…", texto: "A ONU religou há pouco e a leitura do PPPoE sai em cerca de 1 minuto. Atualize em instantes.", acao: null });
  } else if (status?.autenticacao.estado !== "conectado") {
    // Sem leitura do PPPoE não dá para dizer que está tudo certo (29 out 2026, 33766-JHV: "Tudo certo" com PPPoE sem leitura).
    out.push({ tom: "mute", codigo: "sem_leitura", titulo: "PPPoE sem leitura", texto: `A fibra está boa, mas a rede não informou agora se o login ${login} está autenticado. Atualize em instantes; se o cliente está sem internet, reinicie a ONU pelo portal.`, acao: "reiniciar" });
  }
  const temp = detalhe?.onu.temperaturaC ?? null;
  if (temp !== null && temp >= TEMPERATURA_ALTA_C) {
    out.push({ tom: "warn", codigo: "temperatura", titulo: "ONU muito quente", texto: `A ONU está a ${Math.round(temp)} °C. Peça ao cliente para tirá-la de lugar fechado ou de cima de outro aparelho.`, acao: null });
  }
  const fracos = (detalhe?.wifi?.dispositivos ?? []).filter((d) => d.online && d.rssiDbm !== null && d.rssiDbm < WIFI_RUIM_DBM);
  if (fracos.length) {
    const nomes = fracos.map((d) => d.nome ?? d.mac).slice(0, 3).join(", ");
    out.push({ tom: "warn", codigo: "wifi_fraco", titulo: `Wi-Fi fraco em ${fracos.length} ${fracos.length === 1 ? "aparelho" : "aparelhos"}`, texto: `A conexão até a casa está boa; a lentidão é no Wi-Fi (${nomes}). Sugira aproximar o aparelho do roteador, usar a rede 5 GHz perto dele ou um repetidor.`, acao: null });
  }
  if (!out.length) {
    out.push({ tom: "ok", codigo: "tudo_certo", titulo: "Tudo certo na rede da Speed", texto: "Fibra, sinal e PPPoE estão normais. Se o cliente reclama, o problema provável está dentro da casa: Wi-Fi, cabo de rede ou o próprio aparelho.", acao: null });
  }
  return out;
}

/** Detalhe ao vivo de uma ONU do parceiro (a Speed vê de qualquer um). Outro parceiro: 404. */
export async function getOnuDetail(db: Db, svc: ClientStatusService | undefined, user: SessionUser, reservationId: string) {
  const service = requireSvc(svc);
  const [r] = await db
    .select()
    .from(portReservations)
    .where(user.role === "admin_speed" ? eq(portReservations.id, reservationId) : and(eq(portReservations.id, reservationId), eq(portReservations.partnerId, user.partnerId ?? "")));
  if (!r) throw new AppError(404, "reserva_nao_encontrada", "Cliente não encontrado.");
  const [a] = await db
    .select({ login: activations.pppLogin, serial: activations.serial, sinalCtoDbm: activations.sinalCtoDbm, limiteDb: activations.limiteDb })
    .from(activations)
    .where(and(eq(activations.reservationId, r.id), eq(activations.state, "online")))
    .orderBy(desc(activations.createdAt))
    .limit(1);
  if (!a) throw new AppError(409, "cliente_sem_login", "Esse cliente ainda não tem ONU liberada.");
  const code = await partnerCode(db, r.partnerId);

  // PPPoE ao vivo no NE40 (o snapshot pode ter 30 min e engana logo depois de ativar). Se a Wiki recusar ou enfileirar (429), vale o snapshot.
  const statusAoVivo = async () => {
    try {
      return await service.status(a.login, code, { fresh: true });
    } catch (e) {
      console.error("[onus] status ao vivo falhou, usando o snapshot:", e instanceof Error ? e.message : e);
      return service.status(a.login, code);
    }
  };
  // As duas leituras correm juntas e cada uma responde por si: a tela mostra o que vier.
  const [statusR, detalheR] = await Promise.allSettled([statusAoVivo(), service.onu(a.login, code)]);
  const status = statusR.status === "fulfilled" ? statusR.value : null;
  const detalhe = detalheR.status === "fulfilled" ? detalheR.value : null;
  const rotaAusente = detalheR.status === "rejected" && detalheR.reason instanceof IntegrationError && detalheR.reason.status === 404;
  for (const [what, res] of [["status", statusR], ["onu", detalheR]] as const) {
    if (res.status === "rejected" && !(what === "onu" && rotaAusente)) console.error(`[onus] ${what} falhou:`, res.reason instanceof Error ? res.reason.message : res.reason);
  }
  if (statusR.status === "rejected" && detalheR.status === "rejected") {
    throw new AppError(502, "status_indisponivel", "Não foi possível consultar a ONU agora. Tente de novo em instantes.");
  }
  if (!status && !detalhe) throw new AppError(404, "cliente_nao_encontrado_na_rede", "A rede ainda não conhece esse login. A ONU pode não ter sido autorizada.");

  const minimoDbm = minimo(a.sinalCtoDbm, a.limiteDb);
  const bloqueado = r.customerStatus === "bloqueado" || status?.contrato.estado === "bloqueado" || status?.bloqueio?.ativo === true;
  return {
    cliente: { reservationId: r.id, contract: r.contractNumber, nickname: r.nickname, ctoName: r.ctoName, address: r.address, login: a.login, customerStatus: r.customerStatus },
    status,
    detalhe,
    /** null = veio; "rota_ausente" = a Wiki ainda não publicou a seção I; "falhou" = a leitura ao vivo caiu agora. */
    detalheProblema: detalhe ? null : rotaAusente ? "rota_ausente" : detalheR.status === "rejected" ? "falhou" : null,
    referencia: { sinalCtoDbm: a.sinalCtoDbm, limiteDb: a.limiteDb, minimoDbm },
    diagnostico: diagnose({ detalhe, status, minimoDbm, bloqueado, login: a.login }),
  };
}
