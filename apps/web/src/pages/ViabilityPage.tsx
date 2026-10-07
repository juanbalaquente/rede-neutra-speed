import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Partner, type User, type ViabilityCto, type ViabilityResult } from "../api";
import { PinIcon } from "../ui/Icons";
import { MiniMap } from "../ui/MiniMap";
import { useToast } from "../ui/Toast";

const BLOCKED: Record<NonNullable<ViabilityCto["blockedReason"]>, { label: string; tone: string }> = {
  sem_porta_livre: { label: "Sem porta livre", tone: "b-mute" },
  limite_ocupacao: { label: "Limite de ocupação atingido", tone: "b-warn" },
  sem_dados_de_porta: { label: "Sem dados de porta", tone: "b-mute" },
  conferir: { label: "A Speed precisa conferir esta CTO", tone: "b-warn" },
};

const STEPS = ["Endereço", "CTO e porta", "Reserva"];

export function ViabilityPage({
  user,
  partner,
  seed,
  onReserved,
}: {
  user: User;
  partner: Partner | null;
  /** Endereço vindo da busca Ctrl K; o nonce faz a mesma busca valer de novo. */
  seed: { address: string; nonce: number } | null;
  onReserved: () => void;
}) {
  const say = useToast();
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<ViabilityResult | null>(null);
  const [queried, setQueried] = useState("");
  const [sel, setSel] = useState<{ cto: ViabilityCto; port: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reserving, setReserving] = useState(false);
  const canReserve = user.role !== "admin_speed";

  const search = useCallback(async (text: string) => {
    setBusy(true);
    setError(null);
    setResult(null);
    setSel(null);
    try {
      setResult(await api.viability(text));
      setQueried(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha na consulta.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!seed) return;
    setAddress(seed.address);
    void search(seed.address);
  }, [seed, search]);

  function submit(e: FormEvent) {
    e.preventDefault();
    void search(address);
  }

  async function reserve() {
    if (!sel) return;
    setReserving(true);
    setError(null);
    try {
      await api.reserve({ ctoId: sel.cto.ctoId, port: sel.port, address: queried, lat: result?.point?.lat, lng: result?.point?.lng });
      say(`Porta ${sel.port} da ${sel.cto.name} reservada por 48 horas`);
      onReserved();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Falha ao reservar.";
      setError(message);
      say(message, "bad");
    } finally {
      setReserving(false);
    }
  }

  const step = !result ? 0 : sel ? 2 : 1;

  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>Nova venda</h1>
          <p>Do endereço do cliente à porta reservada, num fluxo só.</p>
        </div>
      </div>

      <div className="steps" aria-label="Etapas">
        {STEPS.map((s, i) => (
          <span key={s} style={{ display: "contents" }}>
            {i > 0 && <span className={`bar ${i <= step ? "done" : ""}`} />}
            <span className={`step ${i < step ? "done" : i === step ? "cur" : ""}`}>
              <i>{i < step ? "✓" : i + 1}</i>
              {s}
            </span>
          </span>
        ))}
      </div>

      <div className="g11">
        <div className="card">
          <form className="vsearch" onSubmit={submit}>
            <label>
              <span style={{ color: "var(--mute)", display: "grid" }}><PinIcon /></span>
              <input
                placeholder="Rua, número, bairro, cidade"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                minLength={8}
                required
                aria-label="Endereço do cliente"
              />
            </label>
            <button className="btn" disabled={busy}>{busy ? "Consultando…" : "Consultar"}</button>
          </form>

          {error && <p className="error" style={{ padding: "12px 18px 0" }}>{error}</p>}
          {!result && !busy && !error && <p className="empty">Digite o endereço completo, com rua e número. Plus Code não é aceito pelo mapa.</p>}

          {result && (
            <div className="ctol">
              {result.ctos.length === 0 && <p className="empty" style={{ padding: "18px 0" }}>Nenhuma CTO da Speed num raio de 300 m deste endereço.</p>}
              {result.ctos.map((cto, i) => {
                const free = new Set(cto.freePorts);
                const blocked = cto.blockedReason ? BLOCKED[cto.blockedReason] : null;
                return (
                  <div className="ctor" key={cto.ctoId} style={{ animationDelay: `${i * 60}ms` }}>
                    <b>{cto.name}</b>
                    {blocked ? <span className={`badge ${blocked.tone}`}>{blocked.label}</span> : <span className="badge b-ok">{cto.freePorts.length} livres</span>}
                    <small>{cto.distanceM} m do endereço{cto.totalPorts > 0 ? ` · ${cto.totalPorts} portas` : ""}</small>
                    {!blocked && (
                      <div className="prt" role="group" aria-label={`Portas da ${cto.name}`}>
                        {Array.from({ length: cto.totalPorts }, (_, n) => n + 1).map((port) => {
                          const isFree = free.has(port);
                          const selected = sel?.cto.ctoId === cto.ctoId && sel.port === port;
                          return (
                            <button
                              key={port}
                              className={`${isFree ? "f" : ""} ${selected ? "sel" : ""}`}
                              disabled={!isFree}
                              aria-pressed={selected}
                              title={isFree ? `Porta ${port} livre` : `Porta ${port} indisponível`}
                              onClick={() => setSel(selected ? null : { cto, port })}
                            >
                              {String(port).padStart(2, "0")}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <MiniMap point={result?.point ?? null} ctos={result?.ctos ?? []} selectedId={sel?.cto.ctoId ?? null} />
          <div className="summary">
            {!result && <p className="muted" style={{ margin: 0 }}>O resultado da consulta aparece aqui.</p>}
            {result && (
              <div className={`verdict ${result.viable ? "ok" : "no"}`}>
                {result.viable ? "Há viabilidade neste endereço" : "Sem viabilidade neste endereço"}
              </div>
            )}
            {result && result.plans.length > 0 && (
              <div className="sumrow"><span>Planos</span><b style={{ fontWeight: 500 }}>{result.plans.map((p) => p.name).join(" · ")}</b></div>
            )}
            {sel && (
              <>
                <div className="sumrow"><span>CTO</span><b className="mono" style={{ fontWeight: 500 }}>{sel.cto.name}</b></div>
                <div className="sumrow"><span>Porta</span><b className="mono" style={{ fontWeight: 500 }}>{String(sel.port).padStart(2, "0")}</b></div>
                <div className="sumrow"><span>Distância</span><b style={{ fontWeight: 500 }}>{sel.cto.distanceM} m</b></div>
                <div className="sumrow"><span>Reserva</span><b style={{ fontWeight: 500 }}>48 horas</b></div>
                {partner && <div className="sumrow"><span>Seu limite</span><b style={{ fontWeight: 500 }}>{partner.maxCtoOccupancyPct}% das portas da caixa</b></div>}
              </>
            )}
            {result?.viable && !sel && <p className="muted" style={{ margin: 0 }}>Escolha uma porta livre para reservar.</p>}
            {result?.viable && (
              <button className="btn" disabled={!sel || !canReserve || reserving} onClick={reserve} title={canReserve ? undefined : "Somente parceiros reservam"}>
                {reserving ? "Reservando…" : sel ? `Reservar porta ${sel.port}` : "Reservar porta"}
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
