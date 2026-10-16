/** Link para abrir a rota até um ponto no app de mapas do celular (Google Maps). Sem posição, não renderiza nada. */
export const routeUrl = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}`;

export function RouteLink({ to, label }: { to: { lat: number | null; lng: number | null } | null | undefined; label: string }) {
  if (!to || to.lat === null || to.lng === null) return null;
  return (
    <a className="btn sec sm" href={routeUrl(to.lat, to.lng)} target="_blank" rel="noopener noreferrer">
      {label}
    </a>
  );
}
