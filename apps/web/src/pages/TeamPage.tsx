import type { Partner, User } from "../api";
import { UsersPanel } from "../ui/UsersPanel";

/** Supervisor do parceiro: cadastra, desativa e reativa a própria equipe. */
export function TeamPage({ user, partner }: { user: User; partner: Partner | null }) {
  return (
    <main className="page fade-page">
      <div className="ph">
        <div>
          <h1>Equipe</h1>
          <p>Quem do {partner?.name ?? "seu provedor"} entra no portal. Cada pessoa com o próprio login: tudo fica registrado em nome dela.</p>
        </div>
      </div>
      <div style={{ maxWidth: 820 }}>
        <UsersPanel maxUsers={partner?.maxUsers ?? null} meId={user.id} emptyHint="Nenhum usuário ainda." />
      </div>
    </main>
  );
}
