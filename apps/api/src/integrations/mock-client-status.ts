import { createHash } from "node:crypto";
import { IntegrationError, type AutenticacaoEstado, type Bloqueio, type ClientStatus, type ClientStatusService, type ClientSummary, type ContratoEstado, type FibraEstado, type OnuDetail, type SignalSeries, type WifiDevice, type WifiLastChange } from "./types.js";

/**
 * Wiki de mentira para o status do cliente. O cenário sai do último dígito do contrato (o login é `<contrato>-<CÓDIGO>`),
 * então dá para ver cada semáforo sem configurar nada:
 *   3 = fibra em loss (queda de energia na ONU) · 7 = fibra offline e PPPoE caído · 9 = contrato bloqueado · demais = tudo no ar.
 * Login terminado em -NOPE não existe (404). `failNext` simula a Wiki fora do ar.
 */
export class MockClientStatus implements ClientStatusService {
  failNext = false;
  readonly calls: string[] = [];
  /** Última troca de Wi-Fi por login, para os testes (a Wiki guarda em memória). */
  readonly wifiLast = new Map<string, WifiLastChange>();

  async wifiLastChange(login: string, partnerCode: string): Promise<WifiLastChange | null> {
    this.calls.push(`wifi:${login}`);
    if (!this.guard(login, partnerCode)) return null;
    return this.wifiLast.get(login) ?? null;
  }

  private scenario(login: string): { fibra: FibraEstado; ppp: AutenticacaoEstado; contrato: ContratoEstado } {
    const digit = login.replace(/-.*$/, "").slice(-1);
    if (digit === "3") return { fibra: "loss", ppp: "desconectado", contrato: "ativo" };
    if (digit === "7") return { fibra: "offline", ppp: "desconectado", contrato: "ativo" };
    if (digit === "9") return { fibra: "online", ppp: "desconectado", contrato: "bloqueado" };
    return { fibra: "online", ppp: "conectado", contrato: "ativo" };
  }

  /** Contrato bloqueado no cenário = bloqueio da Speed na ONU (fibra "desabilitada"), como a Wiki devolve. */
  private bloqueio(s: { contrato: ContratoEstado }): Bloqueio {
    return s.contrato === "bloqueado" ? { ativo: true, desde: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(), motivo: "inadimplência" } : { ativo: false, desde: null, motivo: null };
  }

  private seed(login: string): number {
    return mockSeed(login);
  }

  private guard(login: string, partnerCode: string) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("wiki fora do ar (mock)");
    }
    if (login.endsWith("-NOPE") || !login.endsWith(`-${partnerCode}`)) return false;
    return true;
  }

  async status(login: string, partnerCode: string, opts: { fresh?: boolean } = {}): Promise<ClientStatus | null> {
    this.calls.push(`status:${login}${opts.fresh ? ":fresh" : ""}`);
    if (!this.guard(login, partnerCode)) return null;
    const s = this.scenario(login);
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    return {
      login,
      fibra: {
        estado: s.fibra,
        sinalDbm: s.fibra === "online" ? mockOnuRx(login) : null,
        uptimeDesde: s.fibra === "online" ? iso(6 * 24 * 3600_000) : null,
        ultimaQuedaEm: iso((mockHadDrop(login) ? 13 : 61) * 24 * 3600_000),
        atualizadoEm: iso(opts.fresh ? 1_000 : 4 * 60_000),
      },
      autenticacao: {
        estado: s.ppp,
        ip: s.ppp === "conectado" ? `100.64.${this.seed(login) % 200}.${(this.seed(login) >>> 8) % 250}` : null,
        desde: s.ppp === "conectado" ? iso(6 * 24 * 3600_000) : null,
        atualizadoEm: iso(opts.fresh ? 2_000 : 9 * 60_000),
      },
      contrato: { estado: s.contrato, desde: "2026-09-30", atualizadoEm: iso(60_000) },
      onu: { serial: mockSerial(login), modelo: "F670L", olt: "OLT_SANTA_INES", vlan: 2500 },
      bloqueio: this.bloqueio(s),
    };
  }

  async signal(login: string, partnerCode: string, dias: number): Promise<SignalSeries | null> {
    this.calls.push(`signal:${login}:${dias}`);
    if (!this.guard(login, partnerCode)) return null;
    const seed = this.seed(login);
    const base = mockBaseDbm(login);
    const now = Date.now();
    const step = 6 * 3600_000;
    const pontos: SignalSeries["pontos"] = [];
    const total = dias * 4;
    for (let i = total; i >= 0; i--) {
      // Ruído determinístico de ±0,3 dB e uma oscilação lenta; nada de aleatoriedade para o teste ser estável.
      const noise = (((seed >> (i % 16)) & 7) - 3.5) * 0.08;
      const wave = Math.sin(i / 9) * 0.25;
      pontos.push({ em: new Date(now - i * step).toISOString(), rxDbm: Number((base + noise + wave).toFixed(2)) });
    }
    const quedas: SignalSeries["quedas"] =
      dias >= 14 && mockHadDrop(login) ? [{ inicio: new Date(now - 13 * 24 * 3600_000).toISOString(), fim: new Date(now - 13 * 24 * 3600_000 + 25 * 60_000).toISOString(), tipo: "loss" }] : [];
    return { login, dias, pontos, quedas };
  }

  async summary(logins: string[], partnerCode: string): Promise<ClientSummary[]> {
    this.calls.push(`summary:${logins.length}`);
    if (this.failNext) {
      this.failNext = false;
      throw new Error("wiki fora do ar (mock)");
    }
    const at = new Date(Date.now() - 5 * 60_000).toISOString();
    return logins.map((login) => {
      if (login.endsWith("-NOPE") || !login.endsWith(`-${partnerCode}`)) {
        return { login, fibra: "desconhecido", autenticacao: "desconhecido", contrato: "desconhecido", fibraEm: null, autenticacaoEm: null };
      }
      const s = this.scenario(login);
      return { login, fibra: s.fibra, autenticacao: s.ppp, contrato: s.contrato, fibraEm: at, autenticacaoEm: at, bloqueio: this.bloqueio(s), sinalDbm: s.fibra === "online" ? mockOnuRx(login) : null };
    });
  }

  /**
   * Diagnóstico ao vivo. Além dos cenários do status: 7 = offline com a porta da OLT quase toda caída (falha na rede),
   * 4 = Wi-Fi com aparelhos de sinal ruim, 6 = sinal da ONU fraco, 8 = ONU sem roteador no ACS. `onuRouteMissing` simula a Wiki sem a rota.
   */
  onuRouteMissing = false;
  async onu(login: string, partnerCode: string): Promise<OnuDetail | null> {
    this.calls.push(`onu:${login}`);
    if (this.onuRouteMissing) throw new IntegrationError("wiki", "GET /clientes/x/onu 404 (rota ainda não publicada)", 404);
    if (!this.guard(login, partnerCode)) return null;
    const s = this.scenario(login);
    const digit = login.replace(/-.*$/, "").slice(-1);
    const seed = this.seed(login);
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    const online = s.fibra === "online";
    const rx = online ? mockOnuRx(login) : null;
    const devices: WifiDevice[] = [
      { nome: "Galaxy-A54", mac: "3C:2E:F9:10:22:01", banda: "5GHz", ssid: "CASA_5G", rssiDbm: -54, online: true },
      { nome: "Smart-TV-Sala", mac: "A4:77:33:8B:01:9C", banda: "2.4GHz", ssid: "CASA", rssiDbm: digit === "4" ? -79 : -61, online: true },
      { nome: "iPhone", mac: "F0:18:98:4A:7E:11", banda: "5GHz", ssid: "CASA_5G", rssiDbm: digit === "4" ? -76 : -49, online: true },
    ];
    return {
      login,
      lidoEm: iso(1_000),
      onu: {
        serial: mockSerial(login),
        modelo: "F670L",
        estado: s.contrato === "bloqueado" ? "desabilitada" : s.fibra,
        olt: "OLT_SANTA_INES",
        slot: 1,
        pon: 15,
        rxDbm: s.contrato === "bloqueado" ? null : rx,
        txDbm: online ? 2.1 : null,
        rxOltDbm: online && rx !== null ? Number((rx - 3.2).toFixed(1)) : null,
        temperaturaC: online ? 44 + (seed % 9) : null,
        distanciaM: 600 + (seed % 2400),
        ligadaDesde: online ? iso(6 * 24 * 3600_000) : null,
        ultimaQuedaEm: iso((mockHadDrop(login) ? 13 : 61) * 24 * 3600_000),
        sinalLidoEm: iso(3 * 60_000),
      },
      pon: { onus: 42, offline: digit === "7" ? 31 : digit === "3" ? 2 : 1, mediaRxDbm: -20.6 },
      wifi: online && digit !== "8" && s.contrato !== "bloqueado" ? { online: true, lidoEm: iso(2 * 60_000), dispositivos: devices } : null,
    };
  }
}

/** RX atual da ONU: o típico do login, ou fraco no cenário 6. */
export function mockOnuRx(login: string): number {
  if (login.replace(/-.*$/, "").slice(-1) === "6") return -27.4;
  return Number(mockBaseDbm(login).toFixed(1));
}

/** Semente do login: o mesmo login dá sempre o mesmo sinal, serial e quedas (os dados de demonstração usam para combinar). */
export function mockSeed(login: string): number {
  return createHash("sha1").update(login).digest().readUInt32BE(0);
}

/** Sinal típico da ONU desse login, de -19 a -22,9 dBm. */
export function mockBaseDbm(login: string): number {
  return -19 - (mockSeed(login) % 40) / 10;
}

export function mockSerial(login: string): string {
  return `ZTEGC${String(mockSeed(login) % 10_000_000).padStart(7, "0")}`;
}

/** Só parte da base teve queda nos últimos 14 dias (cerca de 1 em 5), mais quem está em loss ou offline. */
export function mockHadDrop(login: string): boolean {
  const digit = login.replace(/-.*$/, "").slice(-1);
  return digit === "3" || digit === "7" || mockSeed(login) % 5 === 3;
}
