import type { Address } from "../api";

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
    /^[A-Za-z]{2}$/.test(a.uf.trim())
  );
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
        <label className="fld"><span>UF</span><input value={value.uf} onChange={(e) => onChange({ uf: e.target.value.slice(0, 2).toUpperCase() })} maxLength={2} style={{ maxWidth: 90 }} /></label>
      </div>
    </>
  );
}
