// Aplica o tema salvo antes da primeira pintura, para não piscar.
// Arquivo externo (e não script inline) para o CSP poder proibir script inline.
try {
  var t = localStorage.getItem("rn-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
