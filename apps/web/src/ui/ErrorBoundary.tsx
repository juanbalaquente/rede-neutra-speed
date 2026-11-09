import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Um erro de renderização não pode deixar a tela em branco (o técnico em campo não sabe o que
 * fazer). Mostra uma mensagem e deixa recarregar; o que foi digitado nos formulários fica salvo
 * como rascunho e volta depois do reload.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Erro de tela:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="login-wrap">
        <div className="card login" role="alert">
          <h1>Algo deu errado</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>
            A tela travou. O que você já preencheu nos formulários continua salvo. Recarregue para tentar de novo; se repetir, avise a Speed.
          </p>
          <button className="btn" onClick={() => window.location.reload()}>Recarregar</button>
        </div>
      </div>
    );
  }
}
