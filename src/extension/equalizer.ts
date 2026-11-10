/**
 * equalizer.ts — la onda del overlay, portada de `rpiv-voice`.
 *
 * **Origen:** `rpiv-mono/packages/rpiv-voice/view/components/equalizer-view.ts`
 * (vía `vika-analisis-leader`). Es el mismo dibujo, con las mismas constantes, para que
 * se comporte igual que el de rpiv y podamos tocarlo desde una base conocida.
 *
 * Cómo dibuja, en corto: 7 filas con el centro en la fila 3, barras en columnas pares,
 * envolvente de campana, y una silueta de ruido fBm (tres octavas) que deriva con el
 * tiempo — de ahí que "vibre" en vez de ser una barra rígida. Sin FFT: la señal es RMS.
 *
 * Diferencias con el original, todas obligadas por el host:
 *  - `StatefulView`/`RecordingStatus` se reemplazan por props simples.
 *  - El tema de pi llega con `fg()` y, si está, `getFgAnsi()` para el gradiente truecolor.
 */

const COLOR_ACCENT = "accent";
const COLOR_DIM = "dim";

// Gradiente vertical: se escala cada canal del `accent` truecolor del tema, por anillo
// hacia afuera desde la línea central. Si el tema no es truecolor, se usan claves de sombra.
const GRADIENT_BRIGHTNESS = [1.0, 0.65, 0.4, 0.22] as const;
const SHADE_FALLBACK = ["accent", "borderAccent", "muted", "dim"] as const;
const ANSI_FG_RESET = "\x1b[39m";
const TRUECOLOR_FG_REGEX = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;

// Lattice: `amp` cuenta anillos hacia afuera desde la fila central, así toda barra es
// simétrica (amp=1 enciende solo el centro; amp=MAX llena la columna).
const HALF_SPAN = 3;
const CENTER_ROW = HALF_SPAN;
const ROW_COUNT = HALF_SPAN * 2 + 1;
const MAX_AMP = HALF_SPAN + 1;

// Barras en columnas pares; las impares son separación obligatoria.
const BAR_GLYPH = "█";
const SPACE_GLYPH = " ";
const BAR_STRIDE = 2;

// Ruido fBm: tres octavas a escalas decrecientes, con deriva temporal descorrelacionada.
const NOISE_OCTAVES = [
  { spacing: 10, weight: 0.55, drift: 0.04, seed: 13.7 },
  { spacing: 5, weight: 0.3, drift: 0.07, seed: 29.3 },
  { spacing: 2.5, weight: 0.15, drift: 0.11, seed: 47.1 },
] as const;

const HASH_FREQ = 12.9898;
const HASH_AMP = 43758.5453;
const NOISE_PEAK_GAIN = 1.15;

// Ganancia perceptual RMS → altura: sqrt(level * 15) satura cerca de level≈0,067, o sea
// que el volumen normal de habla ya llena las barras. **Asume RMS crudo**: si se le pasa
// el nivel ya amplificado, satura siempre y la onda queda clavada.
const PERCEPTUAL_GAIN = 15;

// Suavizado de un polo sobre el RMS vivo: ~1 s de caída natural en silencio.
const SMOOTHING = 0.3;

export interface ThemeLike {
  fg(color: string, text: string): string;
  /** Solo en temas truecolor; si falta, se usa `fg` con las claves de sombra. */
  getFgAnsi?(color: string): string;
}

export type EstadoOnda = "recording" | "paused";

export interface PropsOnda {
  level: number;
  status: EstadoOnda;
  enabled: boolean;
}

/** Ventana Hann mezclada (0,5·rc² + 0,5·rc⁵): hombros anchos y punta central afinada. */
function bellEnvelope(t: number): number {
  const rc = 0.5 - 0.5 * Math.cos(2 * Math.PI * t);
  const rc2 = rc * rc;
  const rc5 = rc2 * rc2 * rc;
  return 0.5 * rc2 + 0.5 * rc5;
}

export class EqualizerView {
  private props: PropsOnda = { level: 0, status: "recording", enabled: false };
  private envelope: Float64Array = new Float64Array(0);
  private currentBarCount = 0;
  private phase = 0;
  private pendingTicks = 0;
  private smoothedLevel = 0;
  private gradient: readonly string[] | null = null;
  private gradientResolved = false;
  // Campo explícito y no `constructor(private readonly theme)`: Node ejecuta los .ts de
  // este repo con type-stripping, y las parameter properties no están soportadas.
  private readonly theme: ThemeLike;

  constructor(theme: ThemeLike) {
    this.theme = theme;
  }

  setProps(props: PropsOnda): void {
    if (props.enabled && props.status === "recording") {
      this.smoothedLevel = (1 - SMOOTHING) * this.smoothedLevel + SMOOTHING * props.level;
      this.pendingTicks += 1;
    }
    this.props = props;
  }

  reset(): void {
    this.smoothedLevel = 0;
    this.pendingTicks = 0;
    this.phase = 0;
  }

  /** Fila de nivel suavizado, para diagnóstico. */
  get nivelActual(): number {
    return this.smoothedLevel;
  }

  render(width: number): string[] {
    if (!this.props.enabled) return [];
    if (width <= 0) return new Array<string>(ROW_COUNT).fill("");

    const nBars = Math.ceil(width / BAR_STRIDE);
    if (this.currentBarCount !== nBars) {
      this.envelope = new Float64Array(nBars);
      for (let i = 0; i < nBars; i++) {
        const t = nBars === 1 ? 0.5 : i / (nBars - 1);
        this.envelope[i] = bellEnvelope(t);
      }
      this.currentBarCount = nBars;
    }

    this.phase += this.pendingTicks;
    this.pendingTicks = 0;

    // `smoothedLevel` solo avanza grabando: en pausa quedan las últimas alturas.
    const audioGain = Math.min(1, Math.sqrt(this.smoothedLevel * PERCEPTUAL_GAIN));
    // La silueta se refleja alrededor del centro para que la barra i y su espejo vean
    // el mismo ruido y el dibujo quede centrado en cada frame.
    const center = (nBars - 1) / 2;
    const amps = new Uint8Array(nBars);
    for (let i = 0; i < nBars; i++) {
      const shape = fbmShape(Math.abs(i - center), this.phase);
      amps[i] = quantize(shape * this.envelope[i]! * audioGain);
    }

    this.ensureGradient();
    const recording = this.props.status === "recording";
    const out: string[] = new Array(ROW_COUNT);
    for (let r = 0; r < ROW_COUNT; r++) {
      let raw = "";
      for (let c = 0; c < width; c++) {
        if (c % BAR_STRIDE !== 0) {
          raw += SPACE_GLYPH;
          continue;
        }
        raw += rowLit(amps[c / BAR_STRIDE]!, r) ? BAR_GLYPH : SPACE_GLYPH;
      }
      out[r] = this.paintRow(raw, r, recording);
    }
    return out;
  }

  private ensureGradient(): void {
    if (this.gradientResolved) return;
    this.gradientResolved = true;
    if (typeof this.theme.getFgAnsi !== "function") return;
    const accentAnsi = this.theme.getFgAnsi(COLOR_ACCENT);
    const match = accentAnsi?.match(TRUECOLOR_FG_REGEX);
    if (!match) return;
    const r = Number(match[1]);
    const g = Number(match[2]);
    const b = Number(match[3]);
    this.gradient = GRADIENT_BRIGHTNESS.map((factor) => rgbAnsi(r * factor, g * factor, b * factor));
  }

  private paintRow(raw: string, row: number, recording: boolean): string {
    if (!recording) return this.theme.fg(COLOR_DIM, raw);
    const dist = Math.abs(row - CENTER_ROW);
    if (this.gradient) {
      const idx = Math.min(dist, this.gradient.length - 1);
      return `${this.gradient[idx]}${raw}${ANSI_FG_RESET}`;
    }
    const fallbackIdx = Math.min(dist, SHADE_FALLBACK.length - 1);
    return this.theme.fg(SHADE_FALLBACK[fallbackIdx]!, raw);
  }
}

/**
 * Nivel de amplitud 0..1 a partir de PCM int16 mono, para alimentar la onda.
 * **Se pasa crudo**: la ganancia perceptual del dibujo (`sqrt(level * 15)`) ya está
 * calibrada para RMS de habla normal; amplificarlo antes satura las barras.
 */
export function nivelRms(pcm: Buffer): number {
  const bytes = Math.floor(pcm.length / 2);
  if (!bytes) return 0;
  let suma = 0;
  for (let i = 0; i < bytes; i++) {
    const muestra = pcm.readInt16LE(i * 2) / 32768;
    suma += muestra * muestra;
  }
  const rms = Math.sqrt(suma / bytes);
  return Math.min(1, Math.max(0, rms));
}

function valueNoise(x: number, seed: number): number {
  const xi = Math.floor(x);
  const xf = x - xi;
  const u = xf * xf * (3 - 2 * xf);
  const a = valueHash(xi, seed);
  const b = valueHash(xi + 1, seed);
  return a + (b - a) * u;
}

function valueHash(x: number, seed: number): number {
  const v = Math.sin(x * HASH_FREQ + seed) * HASH_AMP;
  return v - Math.floor(v);
}

function fbmShape(i: number, phase: number): number {
  let sum = 0;
  for (const o of NOISE_OCTAVES) {
    sum += valueNoise(i / o.spacing + phase * o.drift, o.seed) * o.weight;
  }
  return sum * NOISE_PEAK_GAIN;
}

function rgbAnsi(r: number, g: number, b: number): string {
  return `\x1b[38;2;${clamp8(r)};${clamp8(g)};${clamp8(b)}m`;
}

function clamp8(v: number): number {
  const rounded = Math.round(v);
  return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

function rowLit(amp: number, row: number): boolean {
  if (amp <= 0) return false;
  return Math.abs(row - CENTER_ROW) < amp;
}

function quantize(level: number): number {
  const idx = Math.round(level * MAX_AMP);
  return idx < 0 ? 0 : idx > MAX_AMP ? MAX_AMP : idx;
}
