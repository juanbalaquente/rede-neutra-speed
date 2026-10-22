import { RouteLink } from "../ui/RouteLink";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, photoUrl, type Installation, type InstallationDetail, type Photo, type User } from "../api";
import { PHOTO_KINDS, PHOTO_LABEL } from "../photoKinds";
import { BatchBar } from "../ui/BatchBar";
import { ClientStatusPanel } from "../ui/ClientStatusPanel";
import { CustomerActionsPanel } from "../ui/CustomerActionsPanel";
import { PhotoSlots } from "../ui/PhotoSlots";
import { useToast } from "../ui/Toast";
import { useDraft } from "../ui/useDraft";

const ACT_LABEL: Record<string, { label: string; tone: string }> = {
  recebida: { label: "Na fila", tone: "b-data" },
  aguardando_cliente: { label: "Aguardando cliente", tone: "b-warn" },
  autorizando: { label: "Autorizando", tone: "b-data" },
  medindo_sinal: { label: "Medindo sinal", tone: "b-data" },
  aguardando_decisao: { label: "Trava de sinal", tone: "b-warn" },
  provisionando: { label: "Configurando", tone: "b-data" },
  online: { label: "ONU online", tone: "b-ok" },
  falha_provisionamento: { label: "Falha na configuração", tone: "b-bad" },
  cancelada: { label: "Cancelada", tone: "b-mute" },
  falhou: { label: "Falhou", tone: "b-bad" },
};

type Filter = "todas" | "andamento" | "os" | "concluidas" | "canceladas";

const fmtDate = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const errMsg = (e: unknown, fb: string) => (e instanceof Error ? e.message : fb);

function Gallery({ reservationId, reloadKey }: { reservationId: string; reloadKey: number }) {
  const say = useToast();
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [link, setLink] = useState<{ id: string; text: string; expires: string } | null>(null);

  useEffect(() => {
    api.photos(reservationId).then((r) => setPhotos(r.photos)).catch(() => setPhotos([]));
  }, [reservationId, reloadKey]);

  async function makeLink(p: Photo) {
    try {
      const r = await api.photoLink(p.id, 48);
      const full = r.url ?? `${window.location.origin}${r.path}`;
      setLink({ id: p.id, text: full, expires: r.expiresAt });
      await navigator.clipboard.writeText(full).then(() => say("Link copiado. Vale por 48 horas."), () => say("Link gerado. Copie o texto abaixo."));
    } catch (e) {
      say(errMsg(e, "Falha ao gerar o link."), "bad");
    }
  }

  if (photos === null) return <p className="muted">Carregando fotos…</p>;
  if (photos.length === 0) return <p className="note">Nenhuma foto enviada ainda.</p>;
  return (
    <>
      <div className="ph-gallery">
        {[...photos].sort((a, b) => PHOTO_KINDS.findIndex((k) => k.kind === a.kind) - PHOTO_KINDS.findIndex((k) => k.kind === b.kind)).map((p) => (
          <figure key={p.id}>
            <a href={photoUrl(p.id)} target="_blank" rel="noopener">
              <img src={photoUrl(p.id)} alt={PHOTO_LABEL[p.kind] ?? p.kind} loading="lazy" />
            </a>
            <figcaption>
              <b>{PHOTO_LABEL[p.kind] ?? p.kind}</b>
              <small>{fmtDate(p.createdAt)}{p.contract ? ` · contrato ${p.contract}` : ""}</small>
              <small>
                {p.lat !== null && p.lng !== null ? (
                  <a href={`https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=18/${p.lat}/${p.lng}`} target="_blank" rel="noopener noreferrer">ver no mapa</a>
                ) : (
                  "sem localização"
                )}
                {" · "}
                <button type="button" className="linkbtn" onClick={() => void makeLink(p)}>link para a Infra</button>
              </small>
            </figcaption>
          </figure>
        ))}
      </div>
      {link && (
        <div className="note" style={{ wordBreak: "break-all" }}>
          Link da foto (vale até {fmtDate(link.expires)}, sem login): <span className="mono">{link.text}</span>
        </div>
      )}
    </>
  );
}

function OsForm({ inst, onClosed }: { inst: InstallationDetail; onClosed: (i: InstallationDetail) => void }) {
  const say = useToast();
  const [draft, setDraft, clearDraft] = useDraft(`os:${inst.id}`, { porta: "", sinal: inst.sinalOnuLidoDbm !== null ? String(inst.sinalOnuLidoDbm).replace(".", ",") : "", modelo: "", serial: inst.onuSerial ?? "", obs: "", just: "" });
  const { porta, sinal, modelo, serial, obs, just } = draft;
  const setJust = (v: string) => setDraft({ just: v });
  const setPorta = (v: string) => setDraft({ porta: v });
  const setSinal = (v: string) => setDraft({ sinal: v });
  const setModelo = (v: string) => setDraft({ modelo: v });
  const setSerial = (v: string) => setDraft({ serial: v });
  const setObs = (v: string) => setDraft({ obs: v });
  const [busy, setBusy] = useState(false);
  const dbm = Number(sinal.replace(",", "."));
  const sinalOk = sinal.trim() !== "" && Number.isFinite(dbm) && dbm <= 0 && dbm >= -40;
  const missing = inst.fotosObrigatorias ? inst.fotosFaltando : [];
  // Abaixo do mínimo da ativação (sinal da CTO menos o limite) a O.S. só fecha com justificativa.
  const foraDoLimite = sinalOk && inst.sinalMinimoDbm !== null && dbm < inst.sinalMinimoDbm;
  const serialOk = /^[A-Za-z0-9]{6,40}$/.test(serial.trim());
  const blocker =
    missing.length > 0 ? `Faltam fotos: ${missing.map((k) => PHOTO_LABEL[k] ?? k).join(", ")}.`
    : !sinalOk ? "Informe o sinal final medido na ONU, entre -40 e 0 dBm."
    : foraDoLimite && just.trim().length < 10 ? "Sinal abaixo do mínimo: escreva a justificativa (mínimo 10 caracteres)."
    : modelo.trim().length < 2 ? "Informe o modelo da ONU."
    : !serialOk ? "Informe o serial da ONU (6 a 40 letras ou números)."
    : null;
  const valid = blocker === null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.closeOs(inst.id, { porta: porta.trim() || null, sinalFinalDbm: dbm, modeloOnu: modelo.trim(), serialOnu: serial.trim(), observacao: obs.trim() || null, ...(foraDoLimite ? { justificativaSinal: just.trim() } : {}) });
      clearDraft();
      say("O.S. fechada. O contrato entra na contagem de portas ativas.");
      onClosed(r.installation);
    } catch (err) {
      say(errMsg(err, "Falha ao fechar a O.S."), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="summary" onSubmit={submit} style={{ borderTop: "1px solid var(--line)" }}>
      <b style={{ fontWeight: 500 }}>Fechar a O.S.</b>
      {missing.length > 0 && (
        <p className="note">Faltam fotos para fechar: {missing.map((k) => PHOTO_LABEL[k] ?? k).join(", ")}. Envie acima.</p>
      )}
      <div className="g2">
        <label className="fld">
          <span>Sinal final medido na ONU (dBm)</span>
          <input value={sinal} onChange={(e) => setSinal(e.target.value)} inputMode="decimal" placeholder="ex.: -21,2" />
          <small>{sinal && !sinalOk ? "Informe um valor entre -40 e 0." : inst.sinalOnuLidoDbm !== null && sinal === String(inst.sinalOnuLidoDbm).replace(".", ",") ? "Sugestão: o que o sistema leu na ONU ao ativar. Confirme com a sua medição." : "O que ficou entregue ao cliente."}{inst.sinalMinimoDbm !== null ? ` Mínimo aceitável: ${String(inst.sinalMinimoDbm).replace(".", ",")} dBm.` : ""}</small>
        </label>
        <label className="fld">
          <span>Porta usada (opcional)</span>
          <input value={porta} onChange={(e) => setPorta(e.target.value)} maxLength={20} placeholder="ex.: 05" />
          <small>A reserva é por vaga; se quiser registrar a porta, escreva aqui.</small>
        </label>
        <label className="fld">
          <span>Modelo da ONU</span>
          <input value={modelo} onChange={(e) => setModelo(e.target.value)} placeholder="ex.: F670L" />
        </label>
        <label className="fld">
          <span>Serial da ONU</span>
          <input value={serial} onChange={(e) => setSerial(e.target.value.toUpperCase())} className="mono" />
        </label>
      </div>
      {foraDoLimite && (
        <div className="atv-trava">
          <b>Sinal abaixo do mínimo aceitável</b>
          <p>Você informou {String(dbm).replace(".", ",")} dBm e o mínimo é {String(inst.sinalMinimoDbm).replace(".", ",")} dBm. Refaça a medição; se o valor for esse mesmo, explique o motivo. A justificativa fica na O.S. e na auditoria.</p>
          <label className="fld"><span>Justificativa</span><input value={just} onChange={(e) => setJust(e.target.value)} maxLength={500} placeholder="ex.: fibra longa, conector refeito, medição repetida com power meter" /></label>
        </div>
      )}
      <label className="fld">
        <span>Observação (opcional)</span>
        <input value={obs} onChange={(e) => setObs(e.target.value)} maxLength={1000} />
      </label>
      <div><button className="btn" disabled={!valid || busy}>{busy ? "Fechando…" : "Fechar O.S."}</button></div>
      {blocker && <p className="hint">{blocker}</p>}
    </form>
  );
}

function Detail({ id, user, onChanged, onOpenTicket }: { id: string; user: User; onChanged: () => void; onOpenTicket?: (installationId: string) => void }) {
  const [inst, setInst] = useState<InstallationDetail | null>(null);
  const [tick, setTick] = useState(0);
  const isPartner = user.role !== "admin_speed";
  const top = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);

  const load = useCallback(() => {
    api.installation(id).then((r) => setInst(r.installation)).catch(() => setInst(null));
  }, [id]);
  useEffect(load, [load, tick]);

  // A lista fica acima: ao abrir um cliente, a tela desce até o detalhe (antes ficava fora da vista).
  useEffect(() => {
    if (inst && !scrolled.current) {
      scrolled.current = true;
      top.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [inst]);

  if (!inst) return <div className="card"><p className="empty">Carregando…</p></div>;
  const open = isPartner && inst.status === "convertida" && !inst.osClosedAt;
  return (
    <div className="card" ref={top} style={{ scrollMarginTop: 70 }}>
      <div className="ch">
        <div>
          <h3>{inst.contract ? `Contrato ${inst.contract}` : "Sem contrato ainda"}{inst.nickname ? ` · ${inst.nickname}` : ""}</h3>
          <small>{inst.ctoName} · {inst.address}{inst.partnerName ? ` · ${inst.partnerName}` : ""}</small>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
            <RouteLink to={{ lat: inst.ctoLat, lng: inst.ctoLng }} label="Rota até a CTO" />
            <RouteLink to={{ lat: inst.lat, lng: inst.lng }} label="Rota até o cliente" />
          </div>
        </div>
        {inst.customerStatus === "cancelado" ? <span className="badge b-mute">Cliente cancelado</span> : inst.customerStatus === "bloqueado" ? <span className="badge b-warn">Bloqueado</span> : inst.osClosedAt ? <span className="badge b-ok">O.S. fechada</span> : inst.status === "convertida" ? <span className="badge b-warn">O.S. pendente</span> : <span className="badge b-data">Reservada</span>}
      </div>
      <div className="summary">
        <b style={{ fontWeight: 500 }}>Fotos</b>
        <Gallery reservationId={inst.id} reloadKey={tick} />
        {isPartner && !inst.osClosedAt && inst.status !== "ativa" && (
          <details>
            <summary className="linkbtn" style={{ cursor: "pointer" }}>Enviar ou refazer fotos</summary>
            <div style={{ marginTop: 12 }}>
              <PhotoSlots reservationId={inst.id} onMedicao={() => {}} onChanged={() => { setTick((t) => t + 1); }} />
            </div>
          </details>
        )}
      </div>
      {inst.os && (
        <div className="summary" style={{ borderTop: "1px solid var(--line)" }}>
          <b style={{ fontWeight: 500 }}>O.S. fechada em {inst.osClosedAt ? fmtDate(inst.osClosedAt) : ""}</b>
          <div className="g3 os-sum">
            <div><small>Sinal final</small><span className="mono">{inst.os.sinalFinalDbm.toString().replace(".", ",")} dBm</span></div>
            <div><small>ONU</small><span>{inst.os.modeloOnu} · <span className="mono">{inst.os.serialOnu}</span></span></div>
            <div><small>Porta</small><span>{inst.os.porta ?? "não informada"}</span></div>
          </div>
          {inst.os.justificativaSinal && <p className="note" style={{ margin: 0 }}><b>Sinal abaixo do mínimo.</b> Justificativa: {inst.os.justificativaSinal}</p>}
          {inst.os.observacao && <p className="muted" style={{ margin: 0 }}>{inst.os.observacao}</p>}
        </div>
      )}
      {inst.osClosedAt && inst.customerStatus !== "cancelado" && <ClientStatusPanel installationId={inst.id} onOpenTicket={isPartner ? onOpenTicket : undefined} />}
      {isPartner && inst.osClosedAt && (
        <CustomerActionsPanel installationId={inst.id} customerStatus={inst.customerStatus} user={user} onChanged={() => { load(); onChanged(); }} />
      )}
      {open && (
        <OsForm
          inst={inst}
          onClosed={(i) => {
            setInst(i);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** Instalações: acompanhamento de cada cliente até a O.S. fechada, com as fotos de campo. */
export function InstallationsPage({ user, initialId, onOpenTicket }: { user: User; initialId?: string | null; onOpenTicket?: (installationId: string) => void }) {
  const say = useToast();
  const [list, setList] = useState<Installation[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [filter, setFilter] = useState<Filter>("todas");
  const [picked, setPicked] = useState<string[]>([]);
  const isAdmin = user.role === "admin_speed";
  // Contrato escolhido na busca (Ctrl K) com esta tela já aberta: abre o detalhe dele.
  useEffect(() => {
    if (initialId) setSelected(initialId);
  }, [initialId]);

  const load = useCallback(() => {
    api.installations().then((r) => setList(r.installations)).catch((e) => { say(errMsg(e, "Falha ao carregar."), "bad"); setList([]); });
  }, [say]);
  useEffect(load, [load]);

  const shown = useMemo(() => {
    const all = list ?? [];
    switch (filter) {
      case "andamento": return all.filter((i) => i.status === "ativa" || (i.status === "convertida" && !i.osClosedAt && i.activationState !== "online"));
      case "os": return all.filter((i) => i.status === "convertida" && !i.osClosedAt);
      case "concluidas": return all.filter((i) => i.osClosedAt && i.customerStatus !== "cancelado");
      case "canceladas": return all.filter((i) => i.customerStatus === "cancelado");
      default: return all;
    }
  }, [list, filter]);

  // Só cliente instalado e não cancelado entra em ação em lote (até 50 por vez).
  const batchable = shown.filter((i) => i.osClosedAt && i.customerStatus !== "cancelado");
  const FILTERS: [Filter, string][] = [["todas", "Todas"], ["andamento", "Em andamento"], ["os", "O.S. pendente"], ["concluidas", "Concluídas"], ["canceladas", "Canceladas"]];

  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>Instalações</h1>
          <p>{isAdmin ? "Todas as instalações dos parceiros, com as fotos e a O.S." : "Cada cliente, da reserva à O.S. fechada, com as fotos de campo."}</p>
        </div>
      </div>
      <div className="seg" role="tablist" aria-label="Filtro">
        {FILTERS.map(([f, label]) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{label}</button>
        ))}
      </div>

      {!isAdmin && <BatchBar selected={picked} all={list ?? []} onClear={() => setPicked([])} onDone={() => { setPicked([]); load(); }} />}

      <div className="card">
        {list === null ? (
          <p className="empty">Carregando…</p>
        ) : shown.length === 0 ? (
          <p className="empty">Nenhuma instalação neste filtro.</p>
        ) : (
          <table className="hist inst">
            <thead>
              <tr>
                {!isAdmin && (
                  <th style={{ width: 34 }}>
                    <input
                      type="checkbox"
                      aria-label="Selecionar todos os clientes instalados desta lista"
                      style={{ width: "auto" }}
                      checked={batchable.length > 0 && batchable.every((i) => picked.includes(i.id))}
                      onChange={(e) => setPicked(e.target.checked ? batchable.slice(0, 50).map((i) => i.id) : [])}
                    />
                  </th>
                )}
                <th>Contrato</th>
                {isAdmin && <th>Parceiro</th>}
                <th>CTO</th>
                <th>Fotos</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((i) => (
                <tr key={i.id} className={`clk ${i.id === selected ? "on" : ""}`} onClick={() => setSelected(i.id)}>
                  {!isAdmin && (
                    <td onClick={(e) => e.stopPropagation()}>
                      {i.osClosedAt && i.customerStatus !== "cancelado" ? (
                        <input
                          type="checkbox"
                          aria-label={`Selecionar ${i.contract ?? "cliente"}`}
                          style={{ width: "auto" }}
                          checked={picked.includes(i.id)}
                          onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, i.id].slice(0, 50) : cur.filter((x) => x !== i.id)))}
                        />
                      ) : null}
                    </td>
                  )}
                  <td style={{ fontFamily: "var(--font)" }}>
                    <button className="rowbtn" onClick={() => setSelected(i.id)}>
                      {i.contract ?? "sem contrato"}{i.nickname ? ` · ${i.nickname}` : ""}
                    </button>
                    <div className="muted" style={{ fontSize: 12 }}>{i.address}</div>
                  </td>
                  {isAdmin && <td style={{ fontFamily: "var(--font)" }}>{i.partnerName}</td>}
                  <td className="mono">{i.ctoName}</td>
                  <td className="tab">{PHOTO_KINDS.filter((k) => i.photoKinds.includes(k.kind)).length} / {PHOTO_KINDS.length}</td>
                  <td>
                    {i.customerStatus === "cancelado" ? (
                      <span className="badge b-mute">Cancelado</span>
                    ) : i.customerStatus === "bloqueado" ? (
                      <span className="badge b-warn">Bloqueado</span>
                    ) : i.osClosedAt ? (
                      <span className="badge b-ok">O.S. fechada</span>
                    ) : i.activationState === "online" ? (
                      <span className="badge b-warn">O.S. pendente</span>
                    ) : i.activationState ? (
                      <span className={`badge ${ACT_LABEL[i.activationState]?.tone ?? "b-mute"}`}>{ACT_LABEL[i.activationState]?.label ?? i.activationState}</span>
                    ) : (
                      <span className="badge b-data">Reservada</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selected && <Detail key={selected} id={selected} user={user} onChanged={load} onOpenTicket={onOpenTicket} />}
    </main>
  );
}
