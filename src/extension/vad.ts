/**
 * vad.ts — decidir si hubo voz, ANTES de gastar un request.
 *
 * Por qué existe este archivo: con un silencio de 3 s mandado como wav, el modelo
 * devolvió **"Gracias"**. No falló: alucinó con seguridad, que es peor. El filtro
 * tiene que estar antes del endpoint, no en el post-parseo.
 *
 * Números medidos en esta máquina (08-nov-2026):
 *   - voz por archivo (`File.analyze`, ventanas de 32 ms): p50 1,000, 222/326 ventanas ≥ 0,5
 *   - micrófono en habitación en silencio: máximo 0,021 (y 0,041 en otra corrida)
 * Separación de casi 25× → umbral 0,5, que además es el default de Silero.
 *
 * Con el motor local el umbral importa menos (no hay costo por mandar audio de más), pero
 * sigue decidiendo si se llama o no al proveedor remoto; se mueve por config.
 */

export interface VadConfig {
  /** `vadScore` mínimo (0-1) para contar un chunk como voz. */
  threshold: number;
  /** Duración de cada chunk que entrega `decibri` con `framesPerBuffer: 1600`. */
  chunkMs: number;
  /** Cuánto tiene que sostenerse la voz para no confundir una tos con un dictado. */
  minSpeechMs: number;
}

export const VAD_DEFAULT: VadConfig = {
  threshold: 0.5,
  chunkMs: 100,
  minSpeechMs: 400,
};

export interface VadResultado {
  hayVoz: boolean;
  chunksSobreUmbral: number;
  chunksRequeridos: number;
  maxScore: number;
  /** Segundos estimados de voz, para el mensaje de diagnóstico. */
  segundosSobreUmbral: number;
}

export function decidirVoz(scores: readonly number[], cfg: VadConfig = VAD_DEFAULT): VadResultado {
  const chunksRequeridos = Math.max(1, Math.ceil(cfg.minSpeechMs / cfg.chunkMs));
  const validos = scores.filter((s) => Number.isFinite(s));
  const sobre = validos.filter((s) => s >= cfg.threshold).length;
  return {
    hayVoz: sobre >= chunksRequeridos,
    chunksSobreUmbral: sobre,
    chunksRequeridos,
    maxScore: validos.length ? Math.max(...validos) : 0,
    segundosSobreUmbral: (sobre * cfg.chunkMs) / 1000,
  };
}

/**
 * Normaliza el bloque `vad` de la config (`~/.pi/agent/extensions/pi-voxifer/config.json`).
 * Un valor inválido NO se corrige en silencio: cae al default y lo informa, porque un
 * umbral mal escrito que "anda igual" es peor que un error visible.
 */
export function leerConfigVad(crudo: unknown): { cfg: VadConfig; avisos: string[] } {
  const cfg = { ...VAD_DEFAULT };
  const avisos: string[] = [];
  if (crudo === undefined || crudo === null) return { cfg, avisos };

  if (typeof crudo !== "object") {
    return { cfg, avisos: [`config.vad no es un objeto; uso el default (${JSON.stringify(VAD_DEFAULT)})`] };
  }

  const obj = crudo as Record<string, unknown>;

  if (obj.threshold !== undefined) {
    const v = obj.threshold;
    if (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1) cfg.threshold = v;
    else avisos.push(`vad.threshold inválido (${JSON.stringify(v)}); uso ${VAD_DEFAULT.threshold}`);
  }
  if (obj.minSpeechMs !== undefined) {
    const v = obj.minSpeechMs;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 5_000) cfg.minSpeechMs = v;
    else avisos.push(`vad.minSpeechMs inválido (${JSON.stringify(v)}); uso ${VAD_DEFAULT.minSpeechMs}`);
  }
  if (obj.chunkMs !== undefined) {
    const v = obj.chunkMs;
    if (typeof v === "number" && Number.isFinite(v) && v >= 20 && v <= 500) cfg.chunkMs = v;
    else avisos.push(`vad.chunkMs inválido (${JSON.stringify(v)}); uso ${VAD_DEFAULT.chunkMs}`);
  }

  return { cfg, avisos };
}
