import { createHash } from "node:crypto";
import type { AutenticacaoEstado, ClientStatus, ClientStatusService, ClientSummary, ContratoEstado, FibraEstado, SignalSeries } from "./types.js";

/**
 * Wiki de mentira para o status do cliente. O cenário sai do último dígito do contrato (o login é `<contrato>-<CÓDIGO>`),
 * então dá para ver cada semáforo sem configurar nada:
 *   3 = fibra em loss (queda de energia na ONU) · 7 = fibra offline e PPPoE caído · 9 = contrato bloqueado · demais = tudo no ar.
 * Login terminado em -NOPE não existe (404). `failNext` simula a Wiki fora do ar.
 */
export class MockClientStatus implements ClientStatusService {
  failNext = false;
  readonly calls: string[] = [];

  private scenario(login: string): { fibra: FibraEstado; ppp: AutenticacaoEstado; contrato: ContratoEstado } {
    const digit = login.replace(/-.*$/, "").slice(-1);
    if (digit === "3") return { fibra: "loss", ppp: "desconectado", contrato: "ativo" };
    if (digit === "7") return { fibra: "offline", ppp: "desconectado", contrato: "ativo" };
    if (digit === "9") return { fibra: "online", ppp: "desconectado", contrato: "bloqueado" };
    return { fibra: "online", ppp: "conectado", contrato: "ativo" };
  }

  private seed(login: string): number {
    return createHash("sha1").update(login).digest().readUInt32BE(0);
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
    const base = -19 - (this.seed(login) % 40) / 10;
    return {
      login,
      fibra: {
        estado: s.fibra,
        sinalDbm: s.fibra === "online" ? Number(base.toFixed(1)) : null,
        uptimeDesde: s.fibra === "online" ? iso(6 * 24 * 3600_000) : null,
        ultimaQuedaEm: iso(13 * 24 * 3600_000),
        atualizadoEm: iso(opts.fresh ? 1_000 : 4 * 60_000),
      },
      autenticacao: {
        estado: s.ppp,
        ip: s.ppp === "conectado" ? `100.64.${this.seed(login) % 200}.${(this.seed(login) >> 8) % 250}` : null,
        desde: s.ppp === "conectado" ? iso(6 * 24 * 3600_000) : null,
        atualizadoEm: iso(opts.fresh ? 2_000 : 9 * 60_000),
      },
      contrato: { estado: s.contrato, desde: "2026-09-30", atualizadoEm: iso(60_000) },
      onu: { serial: `ZTEGC${String(this.seed(login) % 10_000_000).padStart(7, "0")}`, modelo: "F670L", olt: "OLT_SANTA_INES", vlan: 2500 },
    };
  }

  async signal(login: string, partnerCode: string, dias: number): Promise<SignalSeries | null> {
    this.calls.push(`signal:${login}:${dias}`);
    if (!this.guard(login, partnerCode)) return null;
    const seed = this.seed(login);
    const base = -19 - (seed % 40) / 10;
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
      dias >= 14 ? [{ inicio: new Date(now - 13 * 24 * 3600_000).toISOString(), fim: new Date(now - 13 * 24 * 3600_000 + 25 * 60_000).toISOString(), tipo: "loss" }] : [];
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
      return { login, fibra: s.fibra, autenticacao: s.ppp, contrato: s.contrato, fibraEm: at, autenticacaoEm: at };
    });
  }
}
