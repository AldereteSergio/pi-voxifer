/**
 * guardado.ts — el dataset de dictados: audio + transcripción automática.
 *
 * Para qué: finetunear un modelo necesita pares (audio, texto). El audio no se puede
 * regenerar; el texto automático es un punto de partida que después alguien revisa, por
 * eso se guarda con `revisado: false` en vez de hacerse pasar por verdad.
 *
 * Regla de oro: **el guardado nunca rompe el dictado**. Si el disco falla, devuelve
 * `undefined` y el texto se pega igual.
 */

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { pcmToWav } from "./wav.ts";

export function directorioPorDefecto(): string {
  return join(homedir(), ".pi", "agent", "extensions", "pi-voxifer", "dataset");
}

/**
 * Guarda el PCM como WAV y devuelve la ruta. `undefined` si no se pudo: el que llama
 * sigue adelante sin audio, nunca con excepción.
 */
export function guardarWav(
  pcm: Buffer,
  opciones: { dir?: string; ahora?: Date } = {},
): string | undefined {
  try {
    const dir = opciones.dir ?? directorioPorDefecto();
    mkdirSync(dir, { recursive: true });
    const sello = (opciones.ahora ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const ruta = join(dir, `dictado-${sello}.wav`);
    writeFileSync(ruta, pcmToWav(pcm));
    return ruta;
  } catch {
    return undefined;
  }
}

/**
 * El WAV guardado más reciente, o `null` si no hay ninguno.
 * El orden es por nombre y no por mtime a propósito: el nombre lleva el sello ISO, que
 * ordena cronológicamente, y así el resultado no depende de la resolución del reloj del
 * sistema de archivos (en Windows, dos archivos escritos en el mismo tick empatan).
 */
export function ultimoWav(dir: string = directorioPorDefecto()): string | null {
  try {
    const nombres = readdirSync(dir)
      .filter((nombre) => nombre.endsWith(".wav"))
      .sort((a, b) => b.localeCompare(a));
    const primero = nombres[0];
    return primero ? join(dir, primero) : null;
  } catch {
    return null;
  }
}

/**
 * Escribe la transcripción al lado del audio, para que el par (audio, texto) quede
 * completo en el dataset. `revisado: false` porque es la salida automática del modelo:
 * la verdad para finetuning es la versión que alguien corrija después.
 */
export function guardarTranscripcion(
  rutaAudio: string,
  datos: { texto: string; motor: string; modelo: string; idioma: string; segundos: number },
): string | undefined {
  try {
    const ruta = rutaAudio.replace(/\.wav$/i, ".json");
    const contenido = {
      audio: basename(rutaAudio),
      texto: datos.texto,
      motor: datos.motor,
      modelo: datos.modelo,
      idioma: datos.idioma,
      segundos: Number(datos.segundos.toFixed(2)),
      revisado: false,
      fecha: new Date().toISOString(),
    };
    writeFileSync(ruta, JSON.stringify(contenido, null, 2) + String.fromCharCode(10));
    return ruta;
  } catch {
    return undefined;
  }
}
