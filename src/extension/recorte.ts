/**
 * recorte.ts — sacar el silencio de los bordes antes de mandar el audio.
 *
 * Por qué existe: whisper-large-v3 y whisper-turbo devolvieron **"¡Gracias!"** al principio
 * de dos audios que arrancaban en silencio. No es azar: es el modelo rellenando un tramo
 * sin voz. El VAD decide si hay voz en el audio; esto limpia los bordes para que el modelo
 * no tenga dónde rellenar.
 *
 * Es conservador a propósito: recorta solo lo que está por debajo del umbral, y deja un
 * margen de audio antes y después para no cortar el ataque de la primera sílaba.
 */

export interface OpcionesRecorte {
  /** Umbral absoluto de amplitud (int16), por debajo del cual es silencio. */
  umbral?: number;
  /** Cuánto audio dejar alrededor del primer y último sonido, en milisegundos. */
  margenMs?: number;
  sampleRate?: number;
  /** Tamaño de la ventana para medir el nivel, en milisegundos. */
  ventanaMs?: number;
}

export interface ResultadoRecorte {
  pcm: Buffer;
  /** Milisegundos quitados del principio y del final. */
  quitadoInicioMs: number;
  quitadoFinMs: number;
}

const PISO_ABSOLUTO = 200; // ~0,6% de escala completa: por debajo no hay voz, hay ruido
const PISO_RELATIVO = 0.02; // 2% del pico global: cubre micrófonos con ruido de fondo alto

export function recortarSilencio(pcm: Buffer, opciones: OpcionesRecorte = {}): ResultadoRecorte {
  const sampleRate = opciones.sampleRate ?? 16_000;
  const umbralBase = opciones.umbral ?? PISO_ABSOLUTO;
  const margenMs = opciones.margenMs ?? 100;
  const ventanaMs = opciones.ventanaMs ?? 10;

  const bytesPorMuestra = 2;
  const muestrasPorVentana = Math.max(1, Math.round((sampleRate * ventanaMs) / 1000));
  const totalMuestras = Math.floor(pcm.length / bytesPorMuestra);
  if (totalMuestras === 0) return { pcm, quitadoInicioMs: 0, quitadoFinMs: 0 };

  // Un pico global bajo significa micrófono flojo: si aplicáramos solo el piso absoluto
  // no recortaríamos nada. El piso relativo se adapta sin llegar a cortar voz baja.
  let picoGlobal = 0;
  for (let i = 0; i < totalMuestras; i++) {
    const valor = Math.abs(pcm.readInt16LE(i * bytesPorMuestra));
    if (valor > picoGlobal) picoGlobal = valor;
  }
  const umbral = Math.max(umbralBase, picoGlobal * PISO_RELATIVO);

  const ventanas = Math.ceil(totalMuestras / muestrasPorVentana);
  const haySonido = new Array<boolean>(ventanas).fill(false);

  for (let v = 0; v < ventanas; v++) {
    const desde = v * muestrasPorVentana;
    const hasta = Math.min(totalMuestras, desde + muestrasPorVentana);
    for (let i = desde; i < hasta; i++) {
      if (Math.abs(pcm.readInt16LE(i * bytesPorMuestra)) >= umbral) {
        haySonido[v] = true;
        break;
      }
    }
  }

  const primera = haySonido.indexOf(true);
  const ultima = haySonido.lastIndexOf(true);
  // Audio entero por debajo del umbral: no se toca. Decidir "no hay voz" es del VAD,
  // no de esta función: acá solo se limpia el borde.
  if (primera === -1 || ultima === -1) return { pcm, quitadoInicioMs: 0, quitadoFinMs: 0 };

  const margenMuestras = Math.round((sampleRate * margenMs) / 1000);
  const inicioMuestra = Math.max(0, primera * muestrasPorVentana - margenMuestras);
  const finMuestra = Math.min(totalMuestras, (ultima + 1) * muestrasPorVentana + margenMuestras);

  if (inicioMuestra === 0 && finMuestra === totalMuestras) {
    return { pcm, quitadoInicioMs: 0, quitadoFinMs: 0 };
  }

  const recortado = pcm.subarray(inicioMuestra * bytesPorMuestra, finMuestra * bytesPorMuestra);
  return {
    pcm: recortado,
    quitadoInicioMs: ms(inicioMuestra, sampleRate),
    quitadoFinMs: ms(totalMuestras - finMuestra, sampleRate),
  };
}

function ms(muestras: number, sampleRate: number): number {
  return Math.round((muestras / sampleRate) * 1000);
}
