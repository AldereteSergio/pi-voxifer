/**
 * audio.ts — traducir las fallas de audio del sistema a algo accionable.
 *
 * El caso real: en WSL sin WSLg, `inputDevices()` no devuelve una lista vacía, **tira** un
 * error de ALSA (`cannot find card '0'`, `Unknown PCM default`) y la extensión contestaba
 * "la grabación falló" con el texto crudo de la librería. Un mensaje que nombra la causa
 * equivocada manda a buscar el problema al lugar que no es.
 *
 * Acá se clasifica el error del sistema y se agrega qué hacer en **esta** plataforma:
 * Windows, Linux nativo, WSL o contenedor, que tienen causas distintas.
 */

export type EntornoAudio = "windows" | "wsl" | "linux" | "macos" | "otro";

export interface DiagnosticoAudio {
  /** Para el usuario, en una línea. */
  mensaje: string;
  /** Detalle accionable: comandos o causas concretas. */
  detalle: string;
}

export function entornoAudio(
  plataforma: NodeJS.Platform = process.platform,
  entorno: NodeJS.ProcessEnv = process.env,
  leerProcVersion: () => string = () => "",
): EntornoAudio {
  if (plataforma === "win32") return "windows";
  if (plataforma === "darwin") return "macos";
  if (entorno.WSL_DISTRO_NAME || entorno.WSL_INTEROP) return "wsl";
  if (plataforma === "linux") {
    try {
      if (/microsoft|wsl/i.test(leerProcVersion())) return "wsl";
    } catch {
      /* sin /proc/version: se asume Linux nativo */
    }
    return "linux";
  }
  return "otro";
}

/** ¿El error viene de que no hay dispositivo de audio, y no de otra cosa? */
export function esErrorSinDispositivo(mensaje: string): boolean {
  return /enumerate devices|no longer available|cannot find card|unknown pcm|no such device|device not found|audio device|alsa/i.test(
    mensaje,
  );
}

export function diagnosticarAudio(
  mensaje: string,
  entorno: EntornoAudio = entornoAudio(),
): DiagnosticoAudio {
  // El error de ALSA viene con varias líneas: se recorta para que quepa en el aviso.
  const crudo = mensaje.replace(/\s+/g, " ").trim();
  const recortado = crudo.length > 140 ? `${crudo.slice(0, 140)}…` : crudo;

  if (entorno === "wsl") {
    return {
      mensaje: "no hay dispositivo de audio en WSL",
      detalle:
        `WSL no tiene micrófono propio. Necesita WSLg (Windows 11 con audio) o un servidor PulseAudio en Windows al que WSL apunte; si no, dictá desde pi instalado en Windows. Error del sistema: ${recortado}`,
    };
  }
  if (entorno === "linux") {
    return {
      mensaje: "no encontré ningún dispositivo de audio",
      detalle:
        `revisá con "arecord -l" (alsa-utils) o "pactl list short sources" y poné la parte distintiva en PI_VOXIFER_DEVICE, por ejemplo "pulse" o "alsa_input". Si la máquina no tiene placa ni servidor de sonido, no hay micrófono que ofrecer. Error del sistema: ${recortado}`,
    };
  }
  if (entorno === "windows") {
    return {
      mensaje: "no encontré el micrófono",
      detalle: `revisá la entrada de audio en Windows › Sonido y que no esté deshabilitada. Error del sistema: ${recortado}`,
    };
  }
  if (entorno === "macos") {
    return {
      mensaje: "no encontré el micrófono",
      detalle: `revisá Privacidad › Micrófono en Ajustes del Sistema. Error del sistema: ${recortado}`,
    };
  }
  return { mensaje: "no hay dispositivo de audio", detalle: `Error del sistema: ${recortado}` };
}
