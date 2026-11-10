/**
 * wav.ts — la cabecera PCM que convierte lo que entrega el micrófono en un WAV.
 *
 * `decibri` entrega chunks de PCM int16 little-endian, sin contenedor. El endpoint
 * acepta `input_audio` con `format: "wav"`, así que alcanza con anteponer 44 bytes:
 * un encoder de mp3 en el camino sería una pieza más (ffmpeg o nativo) para ahorrar
 * ~2,8× de tamaño en dictados de 5-20 s, donde no duele.
 *
 * Nada de esto toca disco ni red: entra un Buffer de PCM, sale un Buffer de WAV.
 */

export const WAV_HEADER_BYTES = 44;

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export const FORMATO_CAPTURA: WavFormat = {
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
};

/**
 * Cabecera WAV canónica (RIFF/WAVE, PCM entero). 44 bytes exactos, con los campos
 * en el orden y los offsets que espera cualquier lector, no solo el proveedor.
 */
export function buildWavHeader(dataBytes: number, fmt: WavFormat = FORMATO_CAPTURA): Buffer {
  const { sampleRate, channels, bitsPerSample } = validarFormato(fmt);
  if (!Number.isInteger(dataBytes) || dataBytes < 0) {
    throw new RangeError(`dataBytes inválido: ${dataBytes}`);
  }
  // RIFF es de 32 bits: un WAV de más de 4 GB no entra en el header.
  if (36 + dataBytes > 0xffff_ffff) {
    throw new RangeError(`audio demasiado grande para un WAV: ${dataBytes} bytes`);
  }

  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(WAV_HEADER_BYTES);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // tamaño del bloque fmt
  header.writeUInt16LE(1, 20); // 1 = PCM entero
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);

  return header;
}

/** PCM crudo → WAV listo para base64. */
export function pcmToWav(pcm: Buffer, fmt: WavFormat = FORMATO_CAPTURA): Buffer {
  const { channels, bitsPerSample } = validarFormato(fmt);
  const blockAlign = (channels * bitsPerSample) / 8;
  if (pcm.length % blockAlign !== 0) {
    throw new RangeError(
      `PCM desalineado: ${pcm.length} bytes no es múltiplo de ${blockAlign} (${channels} canales × ${bitsPerSample} bits)`,
    );
  }
  return Buffer.concat([buildWavHeader(pcm.length, fmt), pcm]);
}

/** Segundos de audio que representa un buffer PCM. */
export function duracionSegundos(bytes: number, fmt: WavFormat = FORMATO_CAPTURA): number {
  const { sampleRate, channels, bitsPerSample } = validarFormato(fmt);
  return bytes / (sampleRate * channels * (bitsPerSample / 8));
}

function validarFormato(fmt: WavFormat): WavFormat {
  const { sampleRate, channels, bitsPerSample } = fmt;
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`sampleRate inválido: ${sampleRate}`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new RangeError(`channels fuera de rango (1-2): ${channels}`);
  }
  // El resto de la extensión asume int16: float32 cambiaría el significado de los
  // bytes que `decibri` entrega y rompería el WAV en silencio.
  if (bitsPerSample !== 16) {
    throw new RangeError(`solo se soporta 16 bits por muestra: ${bitsPerSample}`);
  }
  return fmt;
}
