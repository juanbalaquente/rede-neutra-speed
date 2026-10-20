import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import type { SessionUser } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { activations, partners, portReservations } from "../db/schema.js";
import type { ClientStatusService } from "../integrations/types.js";
import { AppError } from "../lib/errors.js";

/** O histórico da Wiki tem uma leitura a cada 6 h: consultar de novo antes disso só gasta chamadas. */
const CACHE_MS = 10 * 60_000;
const CONCURRENCY = 5;
/** `sig` identifica quais clientes estavam na base: cliente novo ou cancelado invalida o cache na hora. */
const cache = new Map<string, { at: number; sig: string; value: SignalQuality }>();

export const clearSignalQualityCache = () => cache.clear();

export interface ClientSignal {
  reservationId: string;
  contract: string | null;
  nickname: string | null;
  login: string;
  mediaDbm: number | null;
  ultimoDbm: number | null;
  piorDbm: number | null;
  minimoDbm: number;
  abaixoDoMinimo: boolean;
  quedas: number;
}

export interface SignalQuality {
  days: number;
  atualizadoEm: string;
  /** Clientes instalados, com leitura de sinal e sem leitura (Wiki sem dado ou fora do ar). */
  totais: { clientes: number; comLeitura: number; semLeitura: number; mediaBaseDbm: number | null; abaixoDoMinimo: number; quedas: number; comQueda: number };
  /** Clientes com mais quedas no período (os piores primeiro). */
  maisQuedas: ClientSignal[];
  /** Clientes com o último sinal abaixo do mínimo aceitável da instalação. */
  abaixoDoMinimo: ClientSignal[];
}

const round = (n: number, d = 1) => Number(n.toFixed(d));

async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/**
 * Qualidade do sinal da base do parceiro (planejamento: "qualidade média de sinal da base" e "clientes com mais quedas").
 * Lê o histórico de cada cliente instalado na Wiki (a Wiki não tem rota em lote para isso) e guarda o resultado por 10 min.
 */
export async function signalQuality(db: Db, svc: ClientStatusService | undefined, user: SessionUser, opts: { days?: number; now?: number } = {}): Promise<SignalQuality> {
  if (!svc) throw new AppError(503, "status_desligado", "O status do cliente na rede ainda não está habilitado.");
  if (!user.partnerId) throw new AppError(403, "somente_parceiro", "Painel disponível só para o parceiro.");
  const days = opts.days ?? 30;
  if (![7, 30, 90].includes(days)) throw new AppError(400, "periodo_invalido", "Escolha 7, 30 ou 90 dias.");
  const now = opts.now ?? Date.now();
  const key = `${user.partnerId}:${days}`;

  const [p] = await db.select({ code: partners.code }).from(partners).where(eq(partners.id, user.partnerId));
  if (!p?.code) throw new AppError(422, "codigo_parceiro_ausente", "O parceiro ainda não tem código cadastrado.");
  const code = p.code;

  const rows = await db
    .select({ id: portReservations.id, contract: portReservations.contractNumber, nickname: portReservations.nickname, login: activations.pppLogin, sinalCtoDbm: activations.sinalCtoDbm, limiteDb: activations.limiteDb, createdAt: activations.createdAt })
    .from(portReservations)
    .innerJoin(activations, and(eq(activations.reservationId, portReservations.id), eq(activations.state, "online")))
    .where(and(eq(portReservations.partnerId, user.partnerId), eq(portReservations.status, "convertida"), isNotNull(portReservations.osClosedAt), ne(portReservations.customerStatus, "cancelado")))
    .orderBy(desc(activations.createdAt));
  // Um login por reserva (a ativação mais recente).
  const seen = new Set<string>();
  const clients = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));

  // O cache poupa as chamadas à Wiki, mas só vale enquanto a base for a mesma.
  const sig = clients.map((c) => c.id).sort().join(",");
  const hit = cache.get(key);
  if (hit && hit.sig === sig && now - hit.at < CACHE_MS) return hit.value;

  const measured = await inBatches(clients, CONCURRENCY, async (c): Promise<ClientSignal | null> => {
    try {
      const series = await svc.signal(c.login, code, days);
      if (!series) return null;
      const values = series.pontos.map((x) => x.rxDbm);
      const minimo = round(c.sinalCtoDbm - c.limiteDb, 2);
      const last = values.length ? values[values.length - 1]! : null;
      return {
        reservationId: c.id,
        contract: c.contract,
        nickname: c.nickname,
        login: c.login,
        mediaDbm: values.length ? round(values.reduce((s, v) => s + v, 0) / values.length) : null,
        ultimoDbm: last,
        piorDbm: values.length ? Math.min(...values) : null,
        minimoDbm: minimo,
        abaixoDoMinimo: last !== null && last < minimo,
        quedas: series.quedas.length,
      };
    } catch (e) {
      console.error("[sinal] leitura falhou:", e instanceof Error ? e.message : e);
      return null;
    }
  });

  const ok = measured.filter((m): m is ClientSignal => m !== null);
  const withReading = ok.filter((m) => m.mediaDbm !== null);
  const value: SignalQuality = {
    days,
    atualizadoEm: new Date(now).toISOString(),
    totais: {
      clientes: clients.length,
      comLeitura: withReading.length,
      semLeitura: clients.length - withReading.length,
      mediaBaseDbm: withReading.length ? round(withReading.reduce((s, m) => s + m.mediaDbm!, 0) / withReading.length) : null,
      abaixoDoMinimo: ok.filter((m) => m.abaixoDoMinimo).length,
      quedas: ok.reduce((s, m) => s + m.quedas, 0),
      comQueda: ok.filter((m) => m.quedas > 0).length,
    },
    maisQuedas: ok.filter((m) => m.quedas > 0).sort((a, b) => b.quedas - a.quedas || (a.piorDbm ?? 0) - (b.piorDbm ?? 0)).slice(0, 10),
    abaixoDoMinimo: ok.filter((m) => m.abaixoDoMinimo).sort((a, b) => a.ultimoDbm! - a.minimoDbm - (b.ultimoDbm! - b.minimoDbm)).slice(0, 10),
  };
  cache.set(key, { at: now, sig, value });
  return value;
}
