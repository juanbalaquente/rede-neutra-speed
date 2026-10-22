import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { and, count, eq, sql } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import {
  activations,
  auditLog,
  contractRequests,
  customerOperations,
  partnerPrices,
  payments,
  photos,
  plans,
  portReservations,
  ticketMessages,
  tickets,
  users,
  viabilityQueries,
  type PhotoKind,
} from "../db/schema.js";
import { DEMO_CTOS } from "../integrations/mock-demo.js";
import { mockBaseDbm, mockSerial } from "../integrations/mock-client-status.js";
import { haversineM, type MockCto } from "../integrations/mock.js";
import { monthBounds, monthOf } from "../services/finance.js";
import { DEFAULT_SLA_HOURS } from "../services/tickets.js";
import { LocalPhotoStorage, type PhotoStorage } from "../storage/photos.js";
import { DEMO_USERS, findDemoPartner } from "./demo-eustaquio.js";
import { renderDemoPhoto } from "./demo-fotos.js";

/**
 * Dados de demonstração do parceiro Eustáquio Telecom: seis meses de instalações (com fotos ilustradas),
 * financeiro, chamados, operações, consultas e agenda, tudo com datas contadas a partir de hoje.
 *
 *   docker compose exec -T api node dist/scripts/demo-dados.js            cria (se o parceiro ainda não tem dados)
 *   docker compose exec -T api node dist/scripts/demo-dados.js --refazer  apaga e cria de novo (rode no dia da apresentação)
 *   docker compose exec -T api node dist/scripts/demo-dados.js --apagar   apaga tudo do parceiro de demonstração
 *
 * Só mexe no banco do portal e só no parceiro de demonstração (CNPJ fixo); nunca toca nos sistemas de origem.
 * As CTOs são as da rede de demonstração (MOCK_NETWORK=demo). Na auditoria, as linhas geradas levam `demo: true`.
 */

const PARTNER_CODE = "EUS";
const PILOT = new Set(["R1", "ITA", "FAT"]);
const BAIRRO: Record<string, string> = { R1: "Centro", ITA: "Itacolomi", FAT: "Fátima" };
const CEP: Record<string, string> = { R1: "30140", ITA: "30180", FAT: "30110" };
const STREETS = [
  "Rua das Acácias", "Rua dos Ipês", "Rua Alagoas", "Rua Pernambuco", "Rua Ceará", "Rua dos Timbiras", "Rua Grão Mogol",
  "Avenida Brasil", "Rua Tomé de Souza", "Rua Paraíba", "Rua Antônio de Albuquerque", "Rua Sergipe", "Rua Rio Grande do Norte",
  "Rua Professor Moraes", "Rua Santa Rita Durão", "Rua Piauí", "Rua Cláudio Manoel", "Rua Gonçalves Dias", "Rua Outono", "Rua Primavera",
];
const NAMES = [
  "Maria das Graças Souza", "João Pedro Almeida", "Ana Clara Ferreira", "Carlos Henrique Dias", "Fernanda Lopes", "Ricardo Moreira",
  "Juliana Castro", "Paulo Roberto Nunes", "Luciana Teixeira", "Marcos Vinícius Rocha", "Patrícia Gomes", "Rafael Martins",
  "Camila Ribeiro", "Eduardo Pires", "Aline Carvalho", "Bruno Cardoso", "Tatiane Mendes", "Gustavo Araújo", "Renata Barbosa",
  "Diego Freitas", "Simone Correia", "Leonardo Campos", "Vanessa Moura", "Thiago Azevedo", "Cristina Duarte", "Felipe Monteiro",
  "Débora Vieira", "Rodrigo Cunha", "Priscila Batista", "André Luiz Ramos", "Sandra Melo", "Vítor Hugo Lima", "Daniela Fonseca",
  "Márcio Andrade", "Elaine Rezende", "Fábio Guimarães", "Adriana Pacheco", "Sérgio Tavares", "Michele Borges", "Wagner Coelho",
  "Larissa Prado", "Henrique Viana", "Bianca Machado", "Roberto Assis", "Natália Cordeiro", "Alexandre Brito", "Kátia Siqueira",
  "Mateus Fontes", "Gabriela Lacerda", "Otávio Paiva", "Isabela Queiroz", "Cláudio Bastos", "Raquel Furtado", "Davi Sampaio",
  "Lorena Antunes", "Júlio César Prates", "Helena Maia", "Igor Valadares", "Sílvia Drummond", "Caio Magalhães", "Mônica Leal",
  "Leandro Pimenta", "Viviane Horta", "Rogério Lage", "Beatriz Quintão", "Fabiano Resende", "Cíntia Amaral", "Murilo Brandão",
  "Eliane Fagundes", "Nelson Cotta", "Tânia Bicalho", "Hugo Vasconcelos", "Paula Werneck", "Samuel Godoy", "Marta Diniz",
  "Pedro Henrique Salles", "Lívia Noronha", "Alan Starling", "Rosana Teles", "Wesley Lobato", "Yasmin Bretas", "Otaviano Vilela",
];
const TECHNICIANS = ["Eustáquio", "Wellington Souza", "Rafael Lima"];
const ONU_MODELS = ["ZTE F670L", "ZTE F670L", "Huawei EG8145V5", "Nokia G-1425G-A"];
const SALE_PRICE: Record<number, number> = { 600: 9990, 700: 10990, 800: 11990, 1000: 14990 };
/** Instalações por mês, do mais antigo (5 meses atrás) ao atual: a curva de crescimento do painel. */
const INSTALLS_PER_MONTH = [7, 9, 12, 14, 17, 13];
const OS_KINDS: PhotoKind[] = ["medicao", "cto_aberta", "etiqueta_porta", "medicao_onu", "sobra_fibra", "onu_instalada"];

/** Gerador determinístico: a mesma semente monta sempre a mesma história (só as datas acompanham o dia). */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!,
    chance: (p: number) => next() < p,
  };
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Data no fuso de Brasília (-03:00): `daysAgo` dias antes de `now`, à hora e minuto dados. */
function localAt(now: Date, daysAgo: number, hour: number, minute = 0): Date {
  const local = new Date(now.getTime() - 3 * HOUR - daysAgo * DAY);
  const ymd = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
  return new Date(`${ymd}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-03:00`);
}

const fmt = (d: Date) => {
  const l = new Date(d.getTime() - 3 * HOUR);
  return `${String(l.getUTCDate()).padStart(2, "0")}/${String(l.getUTCMonth() + 1).padStart(2, "0")}/${l.getUTCFullYear()} ${String(l.getUTCHours()).padStart(2, "0")}:${String(l.getUTCMinutes()).padStart(2, "0")}`;
};

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

async function insertChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += 200) await insert(rows.slice(i, i + 200));
}

async function demoContext(db: Db) {
  const partner = await findDemoPartner(db);
  if (!partner) throw new Error("Parceiro de demonstração não existe: rode antes o demo-eustaquio.");
  const byEmail = new Map((await db.select().from(users)).map((u) => [u.email, u]));
  const [, sup, ate, tec] = DEMO_USERS.map((u) => byEmail.get(u.email));
  if (!sup || !ate || !tec) throw new Error("Contas do Eustáquio incompletas: rode antes o demo-eustaquio.");
  if ([sup, ate, tec].some((u) => u.partnerId !== partner.id)) throw new Error("Contas do Eustáquio fora do parceiro de demonstração: rode antes o demo-eustaquio.");
  return { partner, sup, ate, tec };
}

/** Apaga tudo o que pertence ao parceiro de demonstração (o que o script criou e o que foi feito na apresentação). Mantém parceiro e contas. */
export async function clearDemoData(db: Db, opts: { removePhotoFiles?: (partnerId: string) => Promise<void> } = {}) {
  const { partner } = await demoContext(db);
  const pid = partner.id;
  const [{ n: reservas } = { n: 0 }] = await db.select({ n: count() }).from(portReservations).where(eq(portReservations.partnerId, pid));
  await db.transaction(async (tx) => {
    await tx.delete(photos).where(eq(photos.partnerId, pid));
    await tx.delete(payments).where(eq(payments.partnerId, pid));
    await tx.delete(customerOperations).where(eq(customerOperations.partnerId, pid));
    await tx.delete(contractRequests).where(eq(contractRequests.partnerId, pid));
    await tx.delete(activations).where(eq(activations.partnerId, pid));
    await tx.delete(tickets).where(eq(tickets.partnerId, pid));
    await tx.delete(portReservations).where(eq(portReservations.partnerId, pid));
    await tx.delete(partnerPrices).where(eq(partnerPrices.partnerId, pid));
    await tx.delete(viabilityQueries).where(eq(viabilityQueries.partnerId, pid));
    await tx.delete(auditLog).where(and(eq(auditLog.partnerId, pid), sql`${auditLog.data}->>'demo' = 'true'`));
  });
  await opts.removePhotoFiles?.(pid);
  await db.insert(auditLog).values({ partnerId: pid, userId: null, action: "demo.dados_apagados", entity: "partner", entityId: pid, data: { origem: "servidor", reservas: Number(reservas) } });
  return { reservas: Number(reservas) };
}

interface CtoSlot {
  cto: MockCto;
  regiao: string;
  /** Quantas vagas ainda dá para usar sem lotar a caixa nem passar do limite de 50% do parceiro. */
  room: number;
}

/** Cria a história do parceiro de demonstração. Recusa se ele já tem reservas (use clearDemoData antes). */
export async function seedDemoData(db: Db, storage: PhotoStorage, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const { partner, sup, ate, tec } = await demoContext(db);
  const pid = partner.id;
  const [{ n: existing } = { n: 0 }] = await db.select({ n: count() }).from(portReservations).where(eq(portReservations.partnerId, pid));
  if (Number(existing) > 0) throw new Error("O parceiro de demonstração já tem dados: use --refazer para apagar e criar de novo.");

  const r = rng(20261019);
  const planList = await db.select().from(plans).where(eq(plans.active, true)).orderBy(plans.speedMbps);
  if (!planList.length) throw new Error("Nenhum plano ativo cadastrado.");
  const planWeights = planList.map((p) => (p.speedMbps <= 600 ? 3 : p.speedMbps <= 700 ? 2 : p.speedMbps <= 800 ? 2.5 : 2.5));
  const pickPlan = () => {
    let x = r.next() * planWeights.reduce((s, w) => s + w, 0);
    for (let i = 0; i < planList.length; i++) if ((x -= planWeights[i]!) <= 0) return planList[i]!;
    return planList[planList.length - 1]!;
  };

  const slots: CtoSlot[] = DEMO_CTOS.filter((c) => PILOT.has(c.regiao ?? "") && c.confidence !== "conferir").map((c) => ({
    cto: c,
    regiao: c.regiao!,
    room: Math.max(0, Math.min(c.totalPorts - c.occupied.length - 1, Math.floor(c.totalPorts / 2) - 1)),
  }));
  const pickCto = (): CtoSlot => {
    const open = slots.filter((s) => s.room > 0);
    if (!open.length) throw new Error("A rede de demonstração não tem vagas para tantas instalações.");
    const s = r.pick(open);
    s.room--;
    return s;
  };

  let contractSeq = 48100;
  /** Número de contrato com o último dígito escolhido: o status de mentira usa 3 = loss, 7 = offline, 9 = bloqueado. */
  const nextContract = (scenario: "ok" | "loss" | "offline" | "bloqueado" = "ok") => {
    const want = { loss: [3], offline: [7], bloqueado: [9], ok: [0, 1, 2, 4, 5, 6, 8] }[scenario];
    do contractSeq++;
    while (!want.includes(contractSeq % 10));
    return String(contractSeq);
  };

  let nameIdx = 0;
  const nextName = () => NAMES[nameIdx++ % NAMES.length]!;

  const addressNear = (slot: CtoSlot) => {
    const rua = r.pick(STREETS);
    const numero = String(r.int(12, 1890));
    const bairro = BAIRRO[slot.regiao]!;
    const lat = round2((slot.cto.lat + (r.next() - 0.5) * 0.0012) * 1e4) / 1e4;
    const lng = round2((slot.cto.lng + (r.next() - 0.5) * 0.0012) * 1e4) / 1e4;
    return {
      text: `${rua}, ${numero}, ${bairro}, Belo Horizonte`,
      lat,
      lng,
      install: { cep: `${CEP[slot.regiao]}-${String(r.int(0, 999)).padStart(3, "0")}`, rua, numero, complemento: r.chance(0.3) ? `Apto ${r.int(101, 804)}` : "", bairro, cidade: "Belo Horizonte", uf: "MG" },
    };
  };

  const audits: (typeof auditLog.$inferInsert)[] = [];
  const audit = (at: Date, userId: string | null, action: string, entity: string | null, entityId: string | null, data: Record<string, unknown> = {}) =>
    audits.push({ partnerId: pid, userId, action, entity, entityId, ip: userId ? "177.70.12.34" : null, data: { ...data, demo: true }, createdAt: at });

  // ── Preços de venda ──
  const prices = planList.map((p) => ({ partnerId: pid, planId: p.id, priceCents: SALE_PRICE[p.speedMbps] ?? Math.round(p.speedPriceCents * 2.4), updatedBy: sup.id, updatedAt: localAt(now, 170, 10) }));
  // Preço já cadastrado na tela (numa apresentação anterior) volta para o valor da demonstração.
  for (const p of prices) {
    await db.insert(partnerPrices).values(p).onConflictDoUpdate({ target: [partnerPrices.partnerId, partnerPrices.planId], set: { priceCents: p.priceCents, updatedBy: p.updatedBy, updatedAt: p.updatedAt } });
  }
  for (const p of prices) audit(p.updatedAt, sup.id, "preco.alterado", "plan", p.planId, { before: null, after: p.priceCents });

  const reservations: (typeof portReservations.$inferInsert)[] = [];
  const acts: (typeof activations.$inferInsert)[] = [];
  const contracts: (typeof contractRequests.$inferInsert)[] = [];
  const photoRows: (typeof photos.$inferInsert)[] = [];
  const pays: (typeof payments.$inferInsert)[] = [];
  const ops: (typeof customerOperations.$inferInsert)[] = [];

  const addPhotos = async (res: { id: string; contract: string; ctoName: string; ctoLat: number; ctoLng: number; lat: number; lng: number; porta: string }, kinds: PhotoKind[], start: Date, sinal: { cto: number; onu: number }, seed: number) => {
    for (const [i, kind] of kinds.entries()) {
      const at = new Date(start.getTime() + (i + 1) * r.int(6, 14) * 60_000);
      const atCto = kind === "medicao" || kind === "cto_aberta" || kind === "etiqueta_porta";
      const bytes = renderDemoPhoto({ kind, ctoName: res.ctoName, contract: res.contract, dbm: kind === "medicao" ? sinal.cto : sinal.onu, porta: res.porta, when: fmt(at), seed: seed + i });
      const id = randomUUID();
      const storageKey = `${pid}/${res.id}/${id}.png`;
      await storage.put(storageKey, bytes);
      photoRows.push({
        id,
        partnerId: pid,
        userId: tec.id,
        reservationId: res.id,
        contract: res.contract,
        kind,
        lat: (atCto ? res.ctoLat : res.lat) + (r.next() - 0.5) * 0.00008,
        lng: (atCto ? res.ctoLng : res.lng) + (r.next() - 0.5) * 0.00008,
        accuracyM: r.int(4, 18),
        capturedAt: new Date(at.getTime() - r.int(5, 40) * 1000),
        storageKey,
        mime: "image/png",
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        createdAt: at,
      });
    }
  };

  /** Instalação completa ou parcial: reserva, contrato, ativação, fotos e O.S. conforme o estágio. */
  const install = async (o: {
    visitAt: Date;
    stage: "fechada" | "onu_liberada";
    scenario?: "ok" | "loss" | "offline" | "bloqueado";
    foraDoLimite?: boolean;
    photoKinds?: PhotoKind[];
    visitStatus?: string;
  }) => {
    const slot = pickCto();
    const plan = pickPlan();
    const contract = nextContract(o.scenario ?? "ok");
    const login = `${contract}-${PARTNER_CODE}`;
    const addr = addressNear(slot);
    const id = randomUUID();
    const createdAt = new Date(o.visitAt.getTime() - r.int(1, 4) * DAY - r.int(0, 6) * HOUR);
    const author = r.chance(0.75) ? ate : sup;
    const porta = `P${String(r.int(1, slot.cto.totalPorts)).padStart(2, "0")}`;
    // Sinal e serial combinam com o que o status de demonstração devolve para o login: a qualidade do sinal da base
    // fica coerente (só quem foi instalado fora do limite aparece abaixo do mínimo).
    const sinalOnu = round2(mockBaseDbm(login));
    const sinalCto = round2(o.foraDoLimite ? sinalOnu + 2 + r.next() * 0.5 : sinalOnu + 0.3 + r.next() * 0.5);
    const serial = mockSerial(login);
    const activatedAt = new Date(o.visitAt.getTime() + r.int(50, 100) * 60_000);
    const closedAt = o.stage === "fechada" ? new Date(activatedAt.getTime() + r.int(40, 90) * 60_000) : null;

    reservations.push({
      id,
      partnerId: pid,
      userId: author.id,
      ctoId: slot.cto.id!,
      ctoName: slot.cto.name,
      totalPorts: slot.cto.totalPorts,
      address: addr.text,
      lat: addr.lat,
      lng: addr.lng,
      ctoLat: slot.cto.lat,
      ctoLng: slot.cto.lng,
      status: "convertida",
      contractNumber: contract,
      planId: plan.id,
      nickname: nextName(),
      visitAt: o.visitAt,
      technician: r.pick(TECHNICIANS),
      visitStatus: o.visitStatus ?? (closedAt ? "concluida" : "em_execucao"),
      osClosedAt: closedAt,
      osClosedBy: closedAt ? tec.id : null,
      osData: closedAt
        ? { porta, sinalFinalDbm: sinalOnu, modeloOnu: r.pick(ONU_MODELS), serialOnu: serial, observacao: r.chance(0.3) ? r.pick(["Cliente pediu ONU na sala.", "Passagem pela tubulação do condomínio.", "Drop de 80 m, sobra organizada no poste.", "Cliente ausente na primeira tentativa."]) : null, fechadaPor: tec.id }
        : null,
      customerStatus: o.scenario === "bloqueado" ? "bloqueado" : "ativo",
      installAddress: addr.install,
      createdAt,
      updatedAt: closedAt ?? activatedAt,
    });
    audit(createdAt, author.id, "reserva.criada", "port_reservation", id, { ctoId: slot.cto.id, ctoName: slot.cto.name });
    audit(new Date(createdAt.getTime() + 20 * 60_000), author.id, "cliente.dados", "port_reservation", id, { planId: plan.id, visitAt: o.visitAt });

    const contractAt = new Date(createdAt.getTime() + r.int(30, 180) * 60_000);
    contracts.push({
      partnerId: pid,
      reservationId: id,
      userId: author.id,
      idempotencyKey: randomUUID(),
      wikiOperationId: `demo-ct-${contract}`,
      state: "concluida",
      steps: ["contrato_criado", "conexao_ajustada", "endereco_gravado"].map((nome) => ({ nome, estado: "concluida" })),
      contract,
      login,
      createdAt: contractAt,
      updatedAt: new Date(contractAt.getTime() + 3 * 60_000),
    });
    audit(contractAt, author.id, "contrato.pedido", "port_reservation", id, {});
    audit(new Date(contractAt.getTime() + 3 * 60_000), null, "contrato.concluida", "port_reservation", id, { contract, login });

    acts.push({
      partnerId: pid,
      userId: tec.id,
      reservationId: id,
      idempotencyKey: randomUUID(),
      wikiActivationId: `demo-at-${contract}`,
      ctoId: slot.cto.id!,
      serial,
      contract,
      pppLogin: login,
      sinalCtoDbm: sinalCto,
      limiteDb: 1.5,
      state: "online",
      snapshot: {
        ativacaoId: `demo-at-${contract}`,
        estado: "online",
        serial,
        sinal: { ctoDbm: sinalCto, onuDbm: sinalOnu, perdaDb: round2(sinalCto - sinalOnu), limiteDb: 1.5, mediaOltcloudDbm: round2(sinalCto - 0.4), amostras: r.int(6, 30) },
        vlan: 2500,
        prazoDecisaoAte: null,
        motivo: null,
        atualizadoEm: activatedAt.toISOString(),
      },
      createdAt: new Date(activatedAt.getTime() - 25 * 60_000),
      updatedAt: activatedAt,
    });
    audit(new Date(activatedAt.getTime() - 25 * 60_000), tec.id, "ativacao.pedida", "port_reservation", id, { serial });
    if (o.foraDoLimite) audit(new Date(activatedAt.getTime() - 10 * 60_000), tec.id, "ativacao.decisao", "port_reservation", id, { acao: "prosseguir", justificativa: "Conector da CTO trocado, sinal estável após limpeza." });
    audit(activatedAt, null, "ativacao.online", "port_reservation", id, { serial });

    const kinds = o.photoKinds ?? (closedAt ? OS_KINDS : ["medicao", "cto_aberta", "etiqueta_porta"]);
    await addPhotos({ id, contract, ctoName: slot.cto.name, ctoLat: slot.cto.lat, ctoLng: slot.cto.lng, lat: addr.lat, lng: addr.lng, porta }, kinds, new Date(o.visitAt.getTime() + 10 * 60_000), { cto: sinalCto, onu: sinalOnu }, contractSeq);
    if (closedAt) audit(closedAt, tec.id, "os.fechada", "port_reservation", id, { contract, sinalFinalDbm: sinalOnu, serialOnu: serial, porta });
    return { id, contract, login, closedAt, slot, sinalCto, sinalOnu, createdAt };
  };

  // ── Seis meses de instalações fechadas ──
  const thisMonth = monthOf(now);
  const months: string[] = [];
  for (let m = thisMonth, i = 0; i < 6; i++) {
    months.unshift(m);
    const [y, mm] = m.split("-").map(Number) as [number, number];
    m = mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, "0")}`;
  }
  const visitDays: Date[] = [];
  months.forEach((month, i) => {
    const { start, end } = monthBounds(month);
    const lastDay = month === thisMonth ? Math.max(1, Math.floor((now.getTime() - start.getTime()) / DAY)) : Math.round((end.getTime() - start.getTime()) / DAY);
    for (let k = 0; k < INSTALLS_PER_MONTH[i]!; k++) {
      let day = r.int(1, lastDay);
      let d = new Date(start.getTime() + (day - 1) * DAY + 3 * HOUR);
      if (new Date(d.getTime() - 3 * HOUR).getUTCDay() === 0) day = Math.min(lastDay, day + 1);
      d = new Date(start.getTime() + (day - 1) * DAY + r.int(8, 15) * HOUR + r.pick([0, 15, 30, 45]) * 60_000);
      if (d.getTime() > now.getTime() - DAY) d = new Date(now.getTime() - DAY - r.int(2, 6) * HOUR);
      visitDays.push(d);
    }
  });
  visitDays.sort((a, b) => a.getTime() - b.getTime());

  // Cenários especiais espalhados: 2 em loss, 1 offline, 2 bloqueados, 2 com sinal fora do limite, 4 cancelados (dos mais antigos).
  const special = new Map<number, "loss" | "offline" | "bloqueado">([[20, "loss"], [47, "loss"], [33, "offline"], [26, "bloqueado"], [41, "bloqueado"]]);
  const outOfLimit = new Set([38, 58]);
  const cancelled = new Set([2, 5, 11, 17]);
  const done: Awaited<ReturnType<typeof install>>[] = [];
  for (const [i, visitAt] of visitDays.entries()) {
    done.push(await install({ visitAt, stage: "fechada", scenario: special.get(i) ?? "ok", foraDoLimite: outOfLimit.has(i) }));
  }

  // Cancelamentos (com operação concluída) e pagamentos mês a mês.
  const cancelReasons = ["Mudança de endereço para fora da área", "Inadimplência: 3 faturas em aberto", "Cliente migrou para outra operadora", "Fechamento do comércio"];
  const opBase = (res: (typeof done)[number], type: string, at: Date, extra: Partial<typeof customerOperations.$inferInsert> = {}) => {
    ops.push({ partnerId: pid, reservationId: res.id, userId: sup.id, type, login: res.login, idempotencyKey: randomUUID(), wikiOperationId: `demo-op-${type}-${res.contract}`, state: "concluida", steps: [], createdAt: at, updatedAt: new Date(at.getTime() + 2 * 60_000), ...extra });
    audit(at, sup.id, `cliente.${type}_pedido`, "port_reservation", res.id, { login: res.login, reason: extra.reason ?? null });
    audit(new Date(at.getTime() + 2 * 60_000), null, `cliente.${type}_concluida`, "port_reservation", res.id, { login: res.login });
  };
  let reasonIdx = 0;
  for (const [i, res] of done.entries()) {
    const row = reservations.find((x) => x.id === res.id)!;
    let lastMonth = thisMonth;
    if (cancelled.has(i)) {
      const at = new Date(Math.min(now.getTime() - 5 * DAY, res.closedAt!.getTime() + r.int(35, 70) * DAY));
      const reason = cancelReasons[reasonIdx++ % cancelReasons.length]!;
      Object.assign(row, { status: "cancelada", customerStatus: "cancelado", cancelReason: reason, cancelledBy: sup.id, cancelledAt: at, updatedAt: at });
      opBase(res, "cancelamento", at, { reason, steps: ["contrato_encerrado", "onu_removida", "porta_devolvida"].map((nome) => ({ nome, estado: "concluida" })) });
      lastMonth = monthOf(at);
    }
    const blocked = row.customerStatus === "bloqueado";
    for (let m = monthOf(res.closedAt!); m <= lastMonth; m = nextMonth(m)) {
      const current = m === thisMonth;
      const lateMonths = blocked && (m === thisMonth || nextMonth(m) === thisMonth);
      if (current && !blocked && !r.chance(0.68)) continue; // ainda não marcado neste mês
      const paid = !lateMonths && (current || !r.chance(0.04));
      const { start } = monthBounds(m);
      pays.push({ partnerId: pid, reservationId: res.id, month: m, paid, markedBy: sup.id, markedAt: new Date(Math.min(now.getTime() - HOUR, start.getTime() + r.int(5, 14) * DAY)) });
    }
  }
  // Bloqueios por inadimplência, um desbloqueio e reinícios.
  for (const [i, res] of done.entries()) {
    if (special.get(i) === "bloqueado") opBase(res, "bloqueio", localAt(now, r.int(4, 12), 10, 20), { reason: "Inadimplência: 2 faturas em aberto" });
  }
  opBase(done[30]!, "bloqueio", localAt(now, 40, 9, 5), { reason: "Inadimplência: fatura de agosto" });
  opBase(done[30]!, "desbloqueio", localAt(now, 36, 15, 40), { reason: "Pagamento confirmado" });
  opBase(done[20]!, "reinicio", localAt(now, 3, 11, 12), { reason: "Cliente sem navegação após queda de energia" });
  opBase(done[44]!, "reinicio", localAt(now, 9, 16, 48), { reason: "Lentidão relatada pelo cliente" });
  opBase(done[61]!, "reinicio", localAt(now, 1, 8, 31), { reason: "Wi-Fi travado" });

  // ── O.S. em andamento: ONU liberada hoje (técnico em campo) e uma visita de ontem ainda aberta ──
  await install({ visitAt: localAt(now, 0, 8, 30), stage: "onu_liberada", photoKinds: ["medicao", "cto_aberta", "etiqueta_porta", "medicao_onu"] });
  await install({ visitAt: localAt(now, 0, 10, 0), stage: "onu_liberada" });
  await install({ visitAt: localAt(now, 1, 15, 30), stage: "onu_liberada", visitStatus: "agendada", photoKinds: ["medicao", "cto_aberta", "etiqueta_porta", "medicao_onu", "sobra_fibra"] });

  // ── Reservas abertas: vendas da semana, com e sem visita marcada ──
  const openPlan: { hoursLeft: number; visit?: [number, number, number]; contrato?: boolean }[] = [
    { hoursLeft: 41, visit: [0, 16, 0], contrato: true },
    { hoursLeft: 33, visit: [-1, 9, 0], contrato: true },
    { hoursLeft: 27, visit: [-1, 14, 30] },
    { hoursLeft: 18, visit: [-2, 10, 30] },
    { hoursLeft: 9 },
    { hoursLeft: 3 },
  ];
  for (const o of openPlan) {
    const slot = pickCto();
    const addr = addressNear(slot);
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + o.hoursLeft * HOUR);
    const createdAt = new Date(expiresAt.getTime() - 48 * HOUR);
    const plan = o.visit ? pickPlan() : null;
    const contract = o.contrato ? nextContract() : null;
    const author = r.chance(0.7) ? ate : sup;
    reservations.push({
      id,
      partnerId: pid,
      userId: author.id,
      ctoId: slot.cto.id!,
      ctoName: slot.cto.name,
      totalPorts: slot.cto.totalPorts,
      address: addr.text,
      lat: addr.lat,
      lng: addr.lng,
      ctoLat: slot.cto.lat,
      ctoLng: slot.cto.lng,
      status: "ativa",
      expiresAt,
      contractNumber: contract,
      planId: plan?.id ?? null,
      nickname: o.visit ? nextName() : null,
      visitAt: o.visit ? localAt(now, o.visit[0], o.visit[1], o.visit[2]) : null,
      technician: o.visit ? r.pick(TECHNICIANS) : null,
      installAddress: o.contrato ? addr.install : null,
      createdAt,
      updatedAt: createdAt,
    });
    audit(createdAt, author.id, "reserva.criada", "port_reservation", id, { ctoId: slot.cto.id, ctoName: slot.cto.name });
    if (contract) {
      const at = new Date(createdAt.getTime() + 2 * HOUR);
      contracts.push({ partnerId: pid, reservationId: id, userId: author.id, idempotencyKey: randomUUID(), wikiOperationId: `demo-ct-${contract}`, state: "concluida", steps: ["contrato_criado", "conexao_ajustada", "endereco_gravado"].map((nome) => ({ nome, estado: "concluida" })), contract, login: `${contract}-${PARTNER_CODE}`, createdAt: at, updatedAt: at });
    }
  }

  // ── Histórico: reservas que expiraram ou foram canceladas antes de instalar ──
  for (let k = 0; k < 9; k++) {
    const slot = DEMO_CTOS.filter((c) => PILOT.has(c.regiao ?? ""))[r.int(0, 30)]!;
    const s: CtoSlot = { cto: slot, regiao: slot.regiao!, room: 0 };
    const addr = addressNear(s);
    const createdAt = localAt(now, r.int(4, 150), r.int(8, 18), r.pick([0, 20, 40]));
    const expired = k < 6;
    reservations.push({
      id: randomUUID(),
      partnerId: pid,
      userId: ate.id,
      ctoId: slot.id!,
      ctoName: slot.name,
      totalPorts: slot.totalPorts,
      address: addr.text,
      lat: addr.lat,
      lng: addr.lng,
      ctoLat: slot.lat,
      ctoLng: slot.lng,
      status: expired ? "expirada" : "cancelada",
      expiresAt: new Date(createdAt.getTime() + 48 * HOUR),
      cancelReason: expired ? null : r.pick(["Cliente desistiu", "Endereço errado", "Cliente fechou com outra operadora"]),
      cancelledBy: expired ? null : ate.id,
      cancelledAt: expired ? null : new Date(createdAt.getTime() + r.int(2, 30) * HOUR),
      createdAt,
      updatedAt: new Date(createdAt.getTime() + 48 * HOUR),
    });
  }

  await db.transaction(async (tx) => {
    await insertChunks(reservations, (c) => tx.insert(portReservations).values(c));
    await insertChunks(contracts, (c) => tx.insert(contractRequests).values(c));
    await insertChunks(acts, (c) => tx.insert(activations).values(c));
    await insertChunks(photoRows, (c) => tx.insert(photos).values(c));
    await insertChunks(pays, (c) => tx.insert(payments).values(c));
    await insertChunks(ops, (c) => tx.insert(customerOperations).values(c));
  });

  // ── Chamados da Infra ──
  const repeatCto = done[done.length - 3]!.slot.cto;
  const ticketPlan: {
    type: keyof typeof DEFAULT_SLA_HOURS;
    daysAgo: number;
    /** Chamado recente, contado em horas a partir de agora (fica dentro do prazo em qualquer hora do dia). */
    hoursAgo?: number;
    hour: number;
    state: string;
    description: string;
    res?: (typeof done)[number];
    cto?: MockCto;
    signal?: number;
    messages: [number, "parceiro" | "infra" | "sistema", string][];
  }[] = [
    { type: "rompimento_regional", daysAgo: 26, hour: 7, state: "resolvido", cto: done[40]!.slot.cto, description: "Vários clientes da região Itacolomi sem sinal desde as 6h. Suspeita de rompimento no tronco.", messages: [[0.2, "infra", "Equipe de rede acionada, rompimento localizado na Rua Alagoas (obra da prefeitura)."], [3, "infra", "Fusão concluída, clientes normalizados. Favor confirmar."], [4, "parceiro", "Confirmado, todos navegando."]] },
    { type: "cto_com_problema", daysAgo: 21, hour: 14, state: "resolvido", cto: repeatCto, description: "Tampa da CTO quebrada, entrando água.", messages: [[20, "infra", "Tampa substituída e caixa vedada."]] },
    { type: "porta_off", daysAgo: 9, hour: 10, state: "em_atendimento", cto: repeatCto, res: done[done.length - 3], description: "Cliente sem sinal na porta, medição na CTO sem luz.", signal: -40, messages: [[2, "infra", "Técnico da Speed agendado para hoje à tarde."], [30, "parceiro", "Cliente perguntou previsão."], [32, "infra", "Splitter com defeito, troca programada para amanhã cedo."]] },
    { type: "conferencia_porta", daysAgo: 0, hour: 0, hoursAgo: 14, state: "aberto", cto: repeatCto, description: "Porta P06 aparece ocupada no portal, mas está livre na caixa.", messages: [] },
    { type: "sinal_fora_padrao_cto", daysAgo: 0, hour: 0, hoursAgo: 30, state: "aguardando_parceiro", cto: done[52]!.slot.cto, signal: -24.8, description: "Sinal na CTO bem abaixo do normal da região.", messages: [[5, "infra", "Pode enviar a foto da medição com o conector limpo?"]] },
    { type: "porta_off", daysAgo: 0, hour: 0, hoursAgo: 6, state: "aberto", res: done[47], description: "Cliente relata ONU com luz LOS vermelha desde ontem à noite.", messages: [[1, "infra", "Recebido, verificando na OLT."]] },
    { type: "conferencia_porta", daysAgo: 64, hour: 15, state: "resolvido", cto: done[12]!.slot.cto, description: "Divergência de vagas entre o mapa e a caixa.", messages: [[26, "infra", "Diagrama atualizado no Codemaps."]] },
    { type: "cto_com_problema", daysAgo: 45, hour: 8, state: "resolvido", cto: done[22]!.slot.cto, description: "CTO pendurada no poste, risco de queda.", messages: [[30, "infra", "Caixa refixada."]] },
  ];
  for (const i of outOfLimit) {
    const res = done[i]!;
    ticketPlan.push({
      type: "trava_sinal",
      daysAgo: Math.max(1, Math.round((now.getTime() - res.closedAt!.getTime()) / DAY)),
      hour: 0,
      state: "resolvido",
      res,
      signal: res.sinalOnu,
      description: `Trava de sinal: ONU em ${res.sinalOnu} dBm, CTO medida em ${res.sinalCto} dBm (limite 1,5 dB). Justificativa do técnico: conector da CTO trocado, sinal estável após limpeza.`,
      messages: [[0, "sistema", "Chamado aberto automaticamente pela trava de sinal."], [6, "infra", "Vamos medir a porta na próxima rota da região."]],
    });
  }
  let ticketSeq = 1180;
  for (const t of ticketPlan) {
    const res = t.res;
    const cto = t.cto ?? res?.slot.cto;
    const createdAt =
      t.type === "trava_sinal" && res
        ? new Date(res.closedAt!.getTime() - 50 * 60_000)
        : t.hoursAgo !== undefined
          ? new Date(now.getTime() - t.hoursAgo * HOUR)
          : localAt(now, t.daysAgo, t.hour, r.pick([5, 20, 35, 50]));
    const sla = DEFAULT_SLA_HOURS[t.type];
    const id = randomUUID();
    const lastMsg = t.messages.length ? t.messages[t.messages.length - 1]![0] : 0;
    const resolvedAt = t.state === "resolvido" ? new Date(createdAt.getTime() + (lastMsg + 1) * HOUR) : null;
    await db.insert(tickets).values({
      id,
      partnerId: pid,
      userId: t.type === "trava_sinal" ? null : r.chance(0.6) ? ate.id : sup.id,
      origin: t.type === "trava_sinal" ? "sistema" : "parceiro",
      type: t.type,
      reservationId: res?.id ?? null,
      ctoId: cto?.id ?? null,
      ctoName: cto?.name ?? null,
      login: res?.login ?? null,
      description: t.description,
      signalDbm: t.signal ?? null,
      slaHours: sla,
      dueAt: new Date(createdAt.getTime() + sla * HOUR),
      state: t.state,
      wikiTicketId: `INF-2026-${String(++ticketSeq).padStart(5, "0")}`,
      idempotencyKey: randomUUID(),
      resolvedAt,
      createdAt,
      updatedAt: resolvedAt ?? new Date(createdAt.getTime() + lastMsg * HOUR),
    });
    const msgs = t.messages.filter(([h]) => createdAt.getTime() + h * HOUR < now.getTime());
    if (msgs.length) {
      await db.insert(ticketMessages).values(msgs.map(([h, author, body], k) => ({ ticketId: id, author, body, sourceKey: author === "infra" ? `demo-${id}-${k}` : null, createdAt: new Date(createdAt.getTime() + h * HOUR) })));
    }
    audit(createdAt, t.type === "trava_sinal" ? null : ate.id, "chamado.aberto", "ticket", id, { type: t.type, ctoId: cto?.id ?? null });
  }
  audit(localAt(now, 1, 16, 40), null, "chamado.muitos_na_cto", "ticket", null, { ctoId: repeatCto.id, ctoName: repeatCto.name, chamados: 3 });

  // ── Consultas de viabilidade dos últimos 30 dias (painel da rede, mapa de calor, demanda) ──
  const pilotCtos = DEMO_CTOS.filter((c) => c.regiao !== "R2");
  const r2 = DEMO_CTOS.filter((c) => c.regiao === "R2");
  const queries: (typeof viabilityQueries.$inferInsert)[] = [];
  for (let day = 29; day >= 0; day--) {
    const weekday = new Date(localAt(now, day, 12).getTime() - 3 * HOUR).getUTCDay();
    const n = weekday === 0 ? r.int(1, 3) : weekday === 6 ? r.int(3, 6) : r.int(7, 15) + Math.round((29 - day) / 6);
    for (let k = 0; k < n; k++) {
      const at = localAt(now, day, r.int(8, 19), r.int(0, 59));
      if (at > now) continue;
      const roll = r.next();
      const user = r.pick([ate, ate, sup, tec]);
      let address: string;
      let point: { lat: number; lng: number } | null;
      let near: MockCto[];
      if (roll < 0.07) {
        address = `${r.pick(STREETS)}, ${r.int(10, 900)}, Barreiro, Belo Horizonte`;
        const c = r.pick(r2);
        point = { lat: c.lat + (r.next() - 0.5) * 0.001, lng: c.lng + (r.next() - 0.5) * 0.001 };
        near = r2;
      } else if (roll < 0.11) {
        address = `${r.pick(STREETS)}, ${r.int(10, 900)}, Venda Nova, Belo Horizonte`;
        point = { lat: -19.8155 + r.next() * 0.01, lng: -43.9555 + r.next() * 0.01 };
        near = [];
      } else {
        const c = r.pick(pilotCtos);
        address = `${r.pick(STREETS)}, ${r.int(10, 1900)}, ${BAIRRO[c.regiao!]}, Belo Horizonte`;
        point = { lat: c.lat + (r.next() - 0.5) * 0.002, lng: c.lng + (r.next() - 0.5) * 0.002 };
        near = pilotCtos;
      }
      const ctos = near
        .map((c) => ({ c, d: haversineM(point!.lat, point!.lng, c.lat, c.lng) }))
        .filter((x) => x.d <= 300)
        .sort((a, b) => a.d - b.d)
        .slice(0, 5)
        .map(({ c }) => {
          const livres = c.totalPorts - c.occupied.length;
          const conferir = c.confidence === "conferir";
          const fora = c.regiao === "R2";
          const blocked = conferir ? "conferir" : livres === 0 ? "sem_vaga_livre" : null;
          return { ctoId: c.id!, name: c.name, regiao: c.regiao, location: { lat: c.lat, lng: c.lng }, vagas: blocked || fora ? 0 : livres, livres: conferir ? null : livres, totalVagas: c.totalPorts, blocked, ambiguous: false, motivos: c.motivos ?? [], fora };
        });
      const offered = ctos.filter((c) => !c.fora);
      const viable = offered.some((c) => c.blocked === null);
      const reason = viable ? null : near === r2 ? "fora_da_area" : offered.length === 0 ? "nenhuma_cto_no_raio" : "sem_vaga_disponivel";
      const id = randomUUID();
      queries.push({
        id,
        partnerId: pid,
        userId: user.id,
        address,
        lat: point.lat,
        lng: point.lng,
        viable,
        reason,
        result: { ctos: offered.map(({ fora: _f, ...c }) => c), sources: offered.map((c) => ({ ctoId: c.ctoId, mapFree: c.livres })), foraDaAreaCount: ctos.length - offered.length },
        createdAt: at,
      });
      audit(at, user.id, "viabilidade.consultada", "viability_query", id, { viable });
    }
  }
  await insertChunks(queries, (c) => db.insert(viabilityQueries).values(c));

  // Entradas no portal, para a auditoria ter o dia a dia.
  for (let day = 20; day >= 0; day--) {
    for (const u of [ate, sup, tec]) {
      if (r.chance(0.8)) {
        const at = localAt(now, day, r.int(7, 9), r.int(0, 59));
        if (at < now) audits.push({ partnerId: pid, userId: u.id, action: "auth.login", ip: "177.70.12.34", data: { demo: true, ...(u.role === "supervisor" ? { segundoFator: true } : {}) }, createdAt: at });
      }
    }
  }
  await insertChunks(audits, (c) => db.insert(auditLog).values(c));

  return {
    instalacoes: done.length,
    reservasAbertas: openPlan.length,
    osEmAndamento: 3,
    fotos: photoRows.length,
    chamados: ticketPlan.length,
    operacoes: ops.length,
    consultas: queries.length,
    pagamentos: pays.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const { db, close } = createDb(config.DATABASE_URL);
  const photoRoot = resolve(config.PHOTO_DIR);
  const removePhotoFiles = (partnerId: string) => rm(join(photoRoot, partnerId), { recursive: true, force: true });
  try {
    const args = process.argv.slice(2);
    if (args.includes("--apagar") || args.includes("--refazer")) {
      const { reservas } = await clearDemoData(db, { removePhotoFiles });
      console.log(`Dados de demonstração apagados (${reservas} reservas).`);
    }
    if (!args.includes("--apagar")) {
      const t = Date.now();
      const s = await seedDemoData(db, new LocalPhotoStorage(config.PHOTO_DIR));
      console.log(
        `Dados de demonstração criados em ${Math.round((Date.now() - t) / 1000)} s: ${s.instalacoes} instalações, ${s.osEmAndamento} O.S. em andamento, ` +
          `${s.reservasAbertas} reservas abertas, ${s.fotos} fotos, ${s.chamados} chamados, ${s.operacoes} operações, ${s.consultas} consultas, ${s.pagamentos} pagamentos.`,
      );
      if (config.INTEGRATIONS_MODE === "mock" && config.MOCK_NETWORK !== "demo") console.log("Aviso: MOCK_NETWORK=demo não está ligado; a nova venda vai mostrar a rede de teste, não a da demonstração.");
      if (config.CLIENT_STATUS_MODE === "off") console.log("Aviso: CLIENT_STATUS_MODE=off; o semáforo e o sinal de 30 dias dos clientes não aparecem.");
    }
  } finally {
    await close();
  }
}
