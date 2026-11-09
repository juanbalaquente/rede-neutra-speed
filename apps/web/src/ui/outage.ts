/**
 * A Wiki manda "sistema_externo_indisponivel: <erro>" no motivo de uma operação aceita que ficou 10 min sem avançar
 * porque Voalle, OLTCloud ou CodeMaps não respondem (21 out 2026). Não é falha: ela segue tentando e o motivo some
 * na primeira rodada que der certo. O erro técnico depois dos dois pontos fica de fora da tela.
 */
export function outageText(motivo: string | null | undefined): string | null {
  if (!motivo || !motivo.startsWith("sistema_externo_indisponivel")) return null;
  return "Sistema da Speed indisponível no momento, tentando de novo automaticamente.";
}
