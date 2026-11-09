import type { PhotoKind } from "./api";

/** Checklist fotográfico (planejamento, etapa 6) mais a medição na CTO, exigida antes de ativar. */
export const PHOTO_KINDS: { kind: PhotoKind; label: string; hint: string }[] = [
  { kind: "medicao", label: "Medição na CTO", hint: "O medidor na porta, antes de instalar. Obrigatória para liberar a ONU." },
  { kind: "cto_aberta", label: "CTO aberta", hint: "A caixa aberta, mostrando a organização das fibras." },
  { kind: "etiqueta_porta", label: "Etiqueta da porta", hint: "Comprova a porta ocupada." },
  { kind: "medicao_onu", label: "Medição na ONU", hint: "O sinal entregue na ONU do cliente." },
  { kind: "sobra_fibra", label: "Sobra de fibra", hint: "A reserva técnica organizada." },
  { kind: "onu_instalada", label: "ONU instalada", hint: "O acabamento no ponto do assinante." },
];

export const PHOTO_LABEL: Record<string, string> = Object.fromEntries(PHOTO_KINDS.map((k) => [k.kind, k.label]));
