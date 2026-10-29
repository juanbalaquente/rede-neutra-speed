/**
 * Mensagens de campo em português. O navegador mostra "Please fill out this field" no idioma dele; aqui trocamos
 * pelas frases do portal. Vale para todo formulário, sem mexer em cada campo.
 */
function message(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): string {
  const v = el.validity;
  if (v.valueMissing) return el instanceof HTMLSelectElement ? "Escolha uma opção." : "Preencha este campo.";
  if (v.typeMismatch) return el.type === "email" ? "Informe um e-mail válido, como nome@empresa.com.br." : "Valor em formato inválido.";
  if (v.tooShort) return `Use pelo menos ${el.getAttribute("minlength")} caracteres (agora tem ${el.value.length}).`;
  if (v.tooLong) return `Use no máximo ${el.getAttribute("maxlength")} caracteres.`;
  if (v.patternMismatch) return "O formato não está certo. Confira o exemplo do campo.";
  if (v.rangeUnderflow) return el.type === "datetime-local" || el.type === "date" ? "Essa data já passou ou é anterior ao permitido." : `O menor valor é ${el.getAttribute("min")}.`;
  if (v.rangeOverflow) return el.type === "datetime-local" || el.type === "date" ? "Essa data está longe demais." : `O maior valor é ${el.getAttribute("max")}.`;
  if (v.badInput) return "Valor inválido.";
  return "";
}

export function installPtBrValidation() {
  document.addEventListener(
    "invalid",
    (e) => {
      const el = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      el.setCustomValidity("");
      const text = message(el);
      if (text) el.setCustomValidity(text);
    },
    true,
  );
  // A mensagem personalizada precisa sair assim que a pessoa corrige, senão o campo continua "inválido".
  document.addEventListener("input", (e) => (e.target as HTMLInputElement).setCustomValidity?.(""), true);
}
