import { useEffect, useRef, useState } from "react";
import { api, type Address } from "../api";
import { BRAZIL_UFS, maskCep } from "../validators";

export const emptyAddress: Address = { cep: "", rua: "", numero: "", complemento: "", bairro: "", cidade: "", uf: "MG" };

/** Endereço guardado na reserva, com o CEP só em dígitos (a demonstração guarda com hífen). */
export function normalizeAddress(a: Partial<Address> | null | undefined): Address {
  return { ...emptyAddress, ...a, cep: (a?.cep ?? "").replace(/\D/g, "").slice(0, 8), uf: (a?.uf || "MG").toUpperCase() };
}

export function addressValid(a: Address): boolean {
  return (
    a.cep.replace(/\D/g, "").length === 8 &&
    a.rua.trim().length >= 2 &&
    a.numero.trim() !== "" &&
    a.bairro.trim().length >= 2 &&
    a.cidade.trim().length >= 2 &&
    BRAZIL_UFS.includes(a.uf.trim().toUpperCase())
  );
}

/** O que falta no endereço, em uma frase, para explicar o botão bloqueado. */
export function addressProblem(a: Address): string | null {
  if (a.cep.replace(/\D/g, "").length !== 8) return "Informe o CEP com 8 dígitos.";
  if (a.rua.trim().length < 2) return "Informe a rua.";
  if (a.numero.trim() === "") return "Informe o número (ou S/N).";
  if (a.bairro.trim().length < 2) return "Informe o bairro.";
  if (a.cidade.trim().length < 2) return "Informe a cidade.";
  if (!BRAZIL_UFS.includes(a.uf.trim().toUpperCase())) return "Escolha a UF.";
  return null;
}

/** Endereço no formato que a API espera. */
export function addressPayload(a: Address): Address {
  return { ...a, cep: a.cep.replace(/\D/g, ""), uf: a.uf.trim().toUpperCase() };
}

/** Campos do endereço da instalação: CEP, rua, número, complemento, bairro, cidade e UF. */
export function AddressFields({ value, onChange }: { value: Address; onChange: (changes: Partial<Address>) => void }) {
  return (
    <>
      <div className="g2">
        <label className="fld"><span>CEP</span><input value={value.cep} onChange={(e) => onChange({ cep: e.target.value.replace(/\D/g, "").slice(0, 8) })} inputMode="numeric" placeholder="34505000" /></label>
        <label className="fld"><span>Rua</span><input value={value.rua} onChange={(e) => onChange({ rua: e.target.value })} maxLength={120} /></label>
      </div>
      <div className="g3">
        <label className="fld"><span>Número</span><input value={value.numero} onChange={(e) => onChange({ numero: e.target.value })} maxLength={12} /></label>
        <label className="fld"><span>Complemento</span><input value={value.complemento} onChange={(e) => onChange({ complemento: e.target.value })} maxLength={60} /></label>
        <label className="fld"><span>Bairro</span><input value={value.bairro} onChange={(e) => onChange({ bairro: e.target.value })} maxLength={80} /></label>
      </div>
      <div className="g2">
        <label className="fld"><span>Cidade</span><input value={value.cidade} onChange={(e) => onChange({ cidade: e.target.value })} maxLength={80} /></label>
        <label className="fld"><span>UF</span><select value={value.uf} onChange={(e) => onChange({ uf: e.target.value })} style={{ maxWidth: 110 }}>{BRAZIL_UFS.map((u) => <option key={u} value={u}>{u}</option>)}</select></label>
      </div>
    </>
  );
}

/**
 * Versão enxuta para quem já informou o endereço na consulta: pede só CEP, número e complemento,
 * completa rua, bairro, cidade e UF pelo CEP e mostra o resultado numa linha. "Editar" abre todos os campos
 * (também abre sozinho quando o CEP não resolve).
 */
export function AddressCompact({ value, onChange }: { value: Address; onChange: (changes: Partial<Address>) => void }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "erro" | "nao_achou">("idle");
  // CEP que já veio preenchido não é consultado de novo: o que está salvo vale mais.
  const asked = useRef(value.cep);
  const cep = value.cep.replace(/\D/g, "");

  useEffect(() => {
    if (cep.length !== 8 || cep === asked.current) return;
    asked.current = cep;
    let live = true;
    setState("busy");
    api
      .cep(cep)
      .then(({ endereco: e }) => {
        if (!live) return;
        onChange({ rua: e.rua || value.rua, bairro: e.bairro || value.bairro, cidade: e.cidade || value.cidade, uf: e.uf || value.uf });
        setState("idle");
        // CEP geral de cidade pequena vem sem rua ou bairro: deixa digitar.
        if (!e.rua || !e.bairro) setOpen(true);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setState(err instanceof Error && /não encontrado/i.test(err.message) ? "nao_achou" : "erro");
        setOpen(true);
      });
    return () => { live = false; };
    // Só reage à troca do CEP.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cep]);

  if (open) {
    return (
      <>
        {state === "nao_achou" && <p className="hint">CEP não encontrado. Confira os dígitos ou preencha o endereço à mão.</p>}
        {state === "erro" && <p className="hint">Não consegui consultar o CEP agora. Preencha o endereço à mão.</p>}
        <AddressFields value={value} onChange={onChange} />
      </>
    );
  }
  const place = [value.bairro, [value.cidade, value.cidade && value.uf].filter(Boolean).join("/")].filter(Boolean).join(" · ");
  return (
    <>
      <div className="g3">
        <label className="fld"><span>CEP</span><input value={maskCep(value.cep)} onChange={(e) => onChange({ cep: e.target.value.replace(/\D/g, "").slice(0, 8) })} inputMode="numeric" placeholder="00000-000" /></label>
        <label className="fld"><span>Número</span><input value={value.numero} onChange={(e) => onChange({ numero: e.target.value })} maxLength={12} placeholder="ou S/N" /></label>
        <label className="fld"><span>Complemento</span><input value={value.complemento} onChange={(e) => onChange({ complemento: e.target.value })} maxLength={60} /></label>
      </div>
      <p className="hint">
        {state === "busy" ? "Consultando o CEP…" : value.rua ? <>{value.rua}{place ? ` · ${place}` : ""}</> : "Informe o CEP para completar rua, bairro e cidade."}
        {" "}
        <button type="button" className="linkbtn" onClick={() => setOpen(true)}>Editar endereço</button>
      </p>
    </>
  );
}
