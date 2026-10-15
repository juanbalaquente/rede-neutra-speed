import { useCallback, useEffect, useRef, useState } from "react";
import { api, photoUrl, type Photo, type PhotoKind } from "../api";
import { useToast } from "./Toast";

const KINDS: { kind: PhotoKind; label: string; hint: string }[] = [
  { kind: "medicao", label: "Medição na CTO", hint: "Foto do medidor na porta, antes de instalar. Obrigatória." },
  { kind: "cto_aberta", label: "CTO aberta", hint: "A caixa aberta, mostrando a porta usada." },
  { kind: "etiqueta_porta", label: "Etiqueta da porta", hint: "A etiqueta do cliente na porta." },
  { kind: "sobra_fibra", label: "Sobra de fibra", hint: "A reserva técnica de fibra." },
  { kind: "onu_instalada", label: "ONU instalada", hint: "A ONU no cliente, ligada." },
];

const MAX_SIDE = 1600;

/** Reduz a foto antes de enviar (celular 4G, 8 MB não compensa) e tira o EXIF ao reencodar. */
async function shrink(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.8));
    if (blob) return blob;
  } catch {
    // Formato que o navegador não decodifica: segue o arquivo original.
  }
  return file;
}

/** Localização do aparelho, se o técnico permitir. Nunca trava o envio. */
function locate(): Promise<GeolocationPosition | null> {
  if (!("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((ok) => navigator.geolocation.getCurrentPosition(ok, () => ok(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 }));
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Fotos de uma reserva. `onMedicao` avisa quando a foto obrigatória (medição na CTO) existe. */
export function PhotoSlots({ reservationId, onMedicao }: { reservationId: string; onMedicao: (has: boolean) => void }) {
  const say = useToast();
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [busy, setBusy] = useState<PhotoKind | null>(null);
  const inputs = useRef<Partial<Record<PhotoKind, HTMLInputElement | null>>>({});

  const load = useCallback(() => {
    api.photos(reservationId).then((r) => setPhotos(r.photos)).catch(() => setPhotos([]));
  }, [reservationId]);
  useEffect(load, [load]);

  useEffect(() => {
    if (photos) onMedicao(photos.some((p) => p.kind === "medicao"));
  }, [photos, onMedicao]);

  async function send(kind: PhotoKind, file: File) {
    setBusy(kind);
    try {
      const [blob, pos] = await Promise.all([shrink(file), locate()]);
      await api.uploadPhoto(reservationId, {
        kind,
        file: blob,
        ...(pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy } : {}),
        capturedAt: new Date().toISOString(),
      });
      say(pos ? "Foto enviada" : "Foto enviada, sem localização");
      load();
    } catch (e) {
      say(e instanceof Error ? e.message : "Falha ao enviar a foto.", "bad");
    } finally {
      setBusy(null);
    }
  }

  const latest = (kind: PhotoKind) => photos?.find((p) => p.kind === kind) ?? null;

  return (
    <div className="fld">
      <span>Fotos</span>
      <div className="ph-grid">
        {KINDS.map(({ kind, label, hint }) => {
          const p = latest(kind);
          return (
            <div key={kind} className={`ph-slot ${p ? "done" : ""} ${kind === "medicao" && !p ? "req" : ""}`}>
              <button type="button" className="ph-pic" disabled={busy !== null} onClick={() => inputs.current[kind]?.click()} aria-label={p ? `Refazer a foto: ${label}` : `Tirar a foto: ${label}`}>
                {p ? <img src={photoUrl(p.id)} alt={label} loading="lazy" /> : <span aria-hidden="true">{busy === kind ? "…" : "+"}</span>}
              </button>
              <b>{label}{kind === "medicao" && <em> obrigatória</em>}</b>
              <small>{busy === kind ? "Enviando…" : p ? `${fmtTime(p.createdAt)}${p.lat === null ? " · sem localização" : ""}` : hint}</small>
              <input
                ref={(el) => { inputs.current[kind] = el; }}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void send(kind, f);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
