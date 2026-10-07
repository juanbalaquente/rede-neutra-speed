import { useState, type FormEvent } from "react";
import { api, type User, type ViabilityCto, type ViabilityResult } from "../api";

const BLOCKED_LABEL: Record<NonNullable<ViabilityCto["blockedReason"]>, string> = {
  sem_porta_livre: "Sem porta livre",
  limite_ocupacao: "Limite de ocupação atingido",
  sem_dados_de_porta: "Sem dados de porta",
  conferir: "A Speed precisa conferir esta CTO",
};

export function ViabilityPage({ user, onReserved }: { user: User; onReserved: () => void }) {
  const [address, setAddress] = useState("");
  const [result, setResult] = useState<ViabilityResult | null>(null);
  const [queried, setQueried] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reserving, setReserving] = useState<string | null>(null);
  const canReserve = user.role !== "admin_speed";

  async function search(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.viability(address));
      setQueried(address);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha na consulta.");
    } finally {
      setBusy(false);
    }
  }

  async function reserve(cto: ViabilityCto, port: number) {
    const key = `${cto.name}#${port}`;
    if (!confirm(`Reservar a porta ${port} da ${cto.name} por 48 horas?`)) return;
    setReserving(key);
    setError(null);
    try {
      await api.reserve({ ctoName: cto.name, port, address: queried, lat: result?.point?.lat, lng: result?.point?.lng });
      onReserved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao reservar.");
    } finally {
      setReserving(null);
    }
  }

  return (
    <section>
      <h1>Consulta de viabilidade</h1>
      <form className="search" onSubmit={search}>
        <input
          placeholder="Rua, número, bairro, cidade"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          minLength={8}
          required
        />
        <button className="primary" disabled={busy}>
          {busy ? "Consultando…" : "Consultar"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}

      {result && (
        <>
          <div className={`banner ${result.viable ? "ok" : "no"}`}>
            {result.viable ? "Há viabilidade neste endereço." : "Sem viabilidade neste endereço."}
          </div>
          {result.plans.length > 0 && (
            <p className="muted">Planos disponíveis: {result.plans.map((p) => p.name).join(" · ")}</p>
          )}
          <div className="cto-list">
            {result.ctos.map((cto) => (
              <article key={cto.name} className="card cto">
                <header>
                  <strong>{cto.name}</strong>
                  <span className="muted">
                    {cto.distanceM} m · {cto.totalPorts} portas
                  </span>
                </header>
                {cto.blockedReason ? (
                  <p className="tag">{BLOCKED_LABEL[cto.blockedReason]}</p>
                ) : (
                  <div className="ports">
                    {cto.freePorts.map((port) => (
                      <button
                        key={port}
                        className="port"
                        disabled={!canReserve || reserving !== null}
                        title={canReserve ? "Reservar por 48h" : "Somente parceiros reservam"}
                        onClick={() => reserve(cto, port)}
                      >
                        {reserving === `${cto.name}#${port}` ? "…" : `Porta ${port}`}
                      </button>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
