import { deflateSync } from "node:zlib";
import type { PhotoKind } from "../db/schema.js";

/**
 * Ilustrações das fotos de campo da demonstração, em PNG, sem dependência nenhuma. Não imitam foto real:
 * cada uma traz "FOTO DE EXEMPLO" na faixa de baixo, para ninguém confundir com uma instalação de verdade.
 */
const W = 640;
const H = 480;
type Rgb = [number, number, number];

/** Fonte 5x7 (só maiúsculas sem acento, números e alguns sinais). */
const FONT: Record<string, string> = {
  "0": "01110100011001110101110011000101110", "1": "00100011000010000100001000010001110", "2": "01110100010000100010001000100011111",
  "3": "11111000100010000010000011000101110", "4": "00010001100101010010111110001000010", "5": "11111100001111000001000011000101110",
  "6": "00110010001000011110100011000101110", "7": "11111000010001000100010000100001000", "8": "01110100011000101110100011000101110",
  "9": "01110100011000101111000010001001100", A: "01110100011000111111100011000110001", B: "11110100011000111110100011000111110",
  C: "01110100011000010000100001000101110", D: "11100100101000110001100011001011100", E: "11111100001000011110100001000011111",
  F: "11111100001000011110100001000010000", G: "01110100011000010111100011000101111", H: "10001100011000111111100011000110001",
  I: "01110001000010000100001000010001110", J: "00111000100001000010000101001001100", K: "10001100101010011000101001001010001",
  L: "10000100001000010000100001000011111", M: "10001110111010110101100011000110001", N: "10001100011100110101100111000110001",
  O: "01110100011000110001100011000101110", P: "11110100011000111110100001000010000", Q: "01110100011000110001101011001001101",
  R: "11110100011000111110101001001010001", S: "01111100001000001110000010000111110", T: "11111001000010000100001000010000100",
  U: "10001100011000110001100011000101110", V: "10001100011000110001100010101000100", W: "10001100011000110101101011010101010",
  X: "10001100010101000100010101000110001", Y: "10001100010101000100001000010000100", Z: "11111000010001000100010001000011111",
  "-": "00000000000000011111000000000000000", ".": "00000000000000000000000000110001100", ",": "00000000000000000000001100010001000",
  ":": "00000011000110000000011000110000000", "/": "00001000010001000100010001000010000", "_": "00000000000000000000000000000011111",
  " ": "00000000000000000000000000000000000",
};

class Canvas {
  readonly px = new Uint8Array(W * H * 3);

  set(x: number, y: number, c: Rgb, a = 1) {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 3;
    for (let k = 0; k < 3; k++) this.px[i + k] = a >= 1 ? c[k]! : Math.round(this.px[i + k]! * (1 - a) + c[k]! * a);
  }

  /** Fundo em degradê vertical. */
  gradient(top: Rgb, bottom: Rgb) {
    for (let y = 0; y < H; y++) {
      const t = y / (H - 1);
      const c: Rgb = [0, 1, 2].map((k) => Math.round(top[k]! + (bottom[k]! - top[k]!) * t)) as Rgb;
      for (let x = 0; x < W; x++) this.set(x, y, c);
    }
  }

  rect(x: number, y: number, w: number, h: number, c: Rgb, r = 0, a = 1) {
    for (let yy = Math.max(0, y); yy < Math.min(H, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(W, x + w); xx++) {
        if (r > 0) {
          const cx = xx < x + r ? x + r : xx >= x + w - r ? x + w - r - 1 : xx;
          const cy = yy < y + r ? y + r : yy >= y + h - r ? y + h - r - 1 : yy;
          if ((xx - cx) ** 2 + (yy - cy) ** 2 > r * r) continue;
        }
        this.set(xx, yy, c, a);
      }
    }
  }

  circle(cx: number, cy: number, r: number, c: Rgb, inner = 0) {
    for (let y = Math.floor(cy - r); y <= cy + r; y++) {
      for (let x = Math.floor(cx - r); x <= cx + r; x++) {
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d <= r * r && d >= inner * inner) this.set(x, y, c);
      }
    }
  }

  /** Linha grossa (cabo de fibra). */
  line(x0: number, y0: number, x1: number, y1: number, c: Rgb, width: number) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let i = 0; i <= steps; i++) this.circle(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, width / 2, c);
  }

  text(s: string, x: number, y: number, scale: number, c: Rgb) {
    // Centralizar dá posição fracionária, e o índice do pixel precisa ser inteiro.
    let cx = Math.round(x);
    y = Math.round(y);
    for (const ch of plain(s)) {
      const g = FONT[ch] ?? FONT[" "]!;
      for (let i = 0; i < 35; i++) if (g[i] === "1") this.rect(cx + (i % 5) * scale, y + Math.floor(i / 5) * scale, scale, scale, c);
      cx += 6 * scale;
    }
  }

  textWidth(s: string, scale: number) {
    return plain(s).length * 6 * scale - scale;
  }

  png(): Uint8Array {
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
      raw[y * (W * 3 + 1)] = 0;
      raw.set(this.px.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
  }
}

const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  let crc = 0xffffffff;
  for (const b of Buffer.concat([head.subarray(4), data])) crc = CRC[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

export interface PhotoScene {
  kind: PhotoKind;
  ctoName: string;
  contract: string;
  /** Sinal que aparece no medidor (medição na CTO ou na ONU). */
  dbm?: number;
  porta?: string;
  /** Data e hora mostradas na faixa, já formatadas. */
  when: string;
  /** Varia a cena entre instalações (posição das fibras, cor da parede). */
  seed: number;
}

const YELLOW: Rgb = [244, 190, 40];
const WHITE: Rgb = [245, 245, 242];
const INK: Rgb = [30, 34, 40];

function meter(c: Canvas, s: PhotoScene, label: string) {
  c.gradient([52, 62, 74], [24, 28, 34]);
  c.rect(170, 40, 300, 340, [32, 36, 42], 26);
  c.rect(176, 46, 288, 328, YELLOW, 22);
  c.rect(206, 80, 228, 130, [60, 70, 52], 8);
  c.rect(212, 86, 216, 118, [168, 196, 140], 6);
  const value = (s.dbm ?? -19.5).toFixed(2);
  c.text(value, 320 - c.textWidth(value, 6) / 2, 104, 6, [28, 40, 24]);
  c.text("DBM", 386, 172, 3, [28, 40, 24]);
  c.text("1490NM", 222, 172, 3, [28, 40, 24]);
  for (let i = 0; i < 3; i++) c.circle(250 + i * 70, 260, 20, [40, 44, 50]);
  c.rect(286, 314, 68, 30, [40, 44, 50], 6);
  c.line(320, 380, 320 + ((s.seed % 5) - 2) * 30, 470, YELLOW, 10);
  c.text(label, 320 - c.textWidth(label, 3) / 2, 18, 3, WHITE);
}

function ctoOpen(c: Canvas, s: PhotoScene) {
  c.gradient([92, 110, 96], [52, 62, 54]);
  c.rect(110, 30, 420, 360, [46, 50, 56], 18);
  c.rect(124, 44, 392, 332, [74, 80, 88], 12);
  c.text(s.ctoName, 320 - c.textWidth(s.ctoName, 3) / 2, 60, 3, WHITE);
  // Splitter: 2 x 8 conectores; verdes ocupados, azuis livres.
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 8; col++) {
      const used = (s.seed >> (row * 8 + col)) % 3 !== 0;
      const x = 162 + col * 45;
      const y = 120 + row * 90;
      c.rect(x - 14, y - 22, 28, 44, [210, 214, 220], 4);
      c.circle(x, y, 10, used ? [46, 170, 90] : [60, 120, 210]);
      if (used) c.line(x, y + 22, x + ((col % 3) - 1) * 20, 330, YELLOW, 4);
    }
  }
  c.rect(150, 320, 340, 40, [58, 64, 70], 8);
}

function label(c: Canvas, s: PhotoScene) {
  c.gradient([70, 76, 84], [40, 44, 50]);
  c.line(0, 300, 640, 260, YELLOW, 16);
  c.rect(190, 120, 260, 170, WHITE, 10);
  c.rect(190, 120, 260, 36, [210, 60, 60], 10);
  c.rect(190, 140, 260, 16, [210, 60, 60]);
  c.text("PORTA", 320 - c.textWidth("PORTA", 3) / 2, 128, 3, WHITE);
  const porta = s.porta ?? "P01";
  c.text(porta, 320 - c.textWidth(porta, 9) / 2, 172, 9, INK);
  c.text(s.ctoName, 320 - c.textWidth(s.ctoName, 2) / 2, 252, 2, INK);
  c.text(s.contract, 320 - c.textWidth(s.contract, 2) / 2, 268, 2, [90, 96, 104]);
}

function slack(c: Canvas, s: PhotoScene) {
  c.gradient([118, 104, 88], [70, 60, 50]);
  c.rect(120, 60, 400, 320, [56, 60, 66], 20);
  c.rect(132, 72, 376, 296, [86, 92, 100], 14);
  const cx = 320 + ((s.seed % 7) - 3) * 4;
  for (let i = 0; i < 6; i++) c.circle(cx, 220, 120 - i * 7, YELLOW, 116 - i * 7);
  c.circle(cx, 220, 62, [86, 92, 100]);
  c.line(cx + 110, 220, 520, 120, YELLOW, 4);
  for (let i = 0; i < 4; i++) c.rect(cx - 6 + (i - 1.5) * 70, 210, 12, 20, [30, 30, 30], 3);
}

function onu(c: Canvas, s: PhotoScene) {
  const walls: Rgb[] = [[226, 218, 200], [210, 220, 226], [228, 214, 214], [216, 226, 210]];
  const wall = walls[s.seed % walls.length]!;
  c.gradient(wall, wall.map((v) => v - 40) as Rgb);
  c.rect(150, 150, 340, 150, [200, 200, 196], 20);
  c.rect(146, 140, 340, 150, WHITE, 20);
  c.text("ZTE", 176, 166, 3, [120, 126, 134]);
  const leds = ["PWR", "PON", "LOS", "LAN", "WIFI"];
  leds.forEach((name, i) => {
    const x = 196 + i * 62;
    c.circle(x, 236, 8, name === "LOS" ? [190, 190, 190] : [40, 200, 90]);
    c.text(name, x - c.textWidth(name, 2) / 2, 254, 2, [110, 116, 124]);
  });
  c.line(486, 260, 600, 470, YELLOW, 8);
  c.line(150, 260, 40, 470, [70, 70, 70], 8);
}

/** Desenha a cena e devolve o PNG. */
export function renderDemoPhoto(s: PhotoScene): Uint8Array {
  const c = new Canvas();
  if (s.kind === "medicao") meter(c, s, "MEDICAO NA CTO");
  else if (s.kind === "medicao_onu") meter(c, s, "MEDICAO NA ONU");
  else if (s.kind === "cto_aberta") ctoOpen(c, s);
  else if (s.kind === "etiqueta_porta") label(c, s);
  else if (s.kind === "sobra_fibra") slack(c, s);
  else onu(c, s);
  c.rect(0, H - 52, W, 52, [0, 0, 0], 0, 0.62);
  c.text("FOTO DE EXEMPLO", 16, H - 40, 3, YELLOW);
  c.text(`${s.contract}  ${s.when}`, 16, H - 16, 2, WHITE);
  return c.png();
}
