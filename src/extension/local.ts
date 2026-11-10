/**
 * local.ts — el motor de transcripción adentro del proceso de pi.
 *
 * Por qué así: `sherpa-onnx-node` es un binding nativo de npm que corre Parakeet,
 * Whisper y Moonshine en el mismo proceso, sin Python, sin Docker y sin servidor
 * (medido: carga 2,07 s, decodifica 10 s de audio en 0,55 s). Es el mismo camino que
 * usa `rpiv-voice`.
 *
 * Dos reglas que sostienen todo:
 *  - **El binding es opcional**: si no hay binario para esta plataforma, el motor local
 *    no existe y el resto del dictado sigue con los remotos. El dictado degrada, pi no.
 *  - **El modelo se baja una vez y se carga en el primer dictado**: 49-652 MB de descarga
 *    y ~930 MB de RSS no pueden pagarse al arrancar una sesión que quizá nunca dicte.
 *
 * Qué se carga cuándo, para que nadie "optimice" la cosa equivocada:
 *  - el **binding** (`sherpa-onnx-node`) se carga al arrancar, para saber si el motor local
 *    se puede ofrecer; pesa poco y no reserva el modelo;
 *  - el **modelo** se carga en el primer dictado local y se libera a los 30 min sin uso.
 *
 * La decodificación corre en el hilo principal: el overlay se congela ~0,55 s por cada 12 s
 * de audio y escala con el largo. Se midió y hoy se acepta; si algún día molesta, la salida
 * es un worker thread, no "optimizar" el loop.
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

import type { Motor } from "./motores.ts";

const execFileAsync = promisify(execFile);

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models";
const SENTINELA = ".download-complete";

/**
 * Familias que el binding de Node sabe cargar.
 * `moonshine` queda afuera: el paquete en español trae 2 archivos (`encoder_model.ort` +
 * `decoder_model_merged.ort`) y el binding pide 4 (`preprocessor`, `encoder`,
 * `uncachedDecoder`, `cachedDecoder`). Se midió en 14% de WER por Python, pero por Node
 * no carga; cuando salga un paquete compatible, entra con una entrada más.
 */
export type TipoLocal = "parakeet" | "whisper";

export interface ModeloLocal {
  /** Alias del motor, el mismo que se escribe en `motor`. */
  alias: string;
  tipo: TipoLocal;
  /** Nombre del archivo del release, sin `.tar.bz2`. */
  archivo: string;
  /** Peso aproximado del paquete, para poder avisar antes de bajar. */
  mb: number;
  nota: string;
}

export const MODELOS_LOCALES: readonly ModeloLocal[] = [
  {
    alias: "parakeet",
    tipo: "parakeet",
    archivo: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
    mb: 652,
    nota: "el más preciso: 10% WER y 0,65 s por audio de 12 s, pero baja 652 MB",
  },
  {
    alias: "whisper-small",
    tipo: "whisper",
    archivo: "sherpa-onnx-whisper-small",
    mb: 610,
    nota: "13% WER y ~8 s (610 MB); usa los .onnx int8 si están",
  },
  {
    alias: "whisper-base",
    tipo: "whisper",
    archivo: "sherpa-onnx-whisper-base",
    mb: 198,
    nota: "default local: 28% WER y 1,4 s con solo 198 MB de descarga",
  },
];

/** Los modelos locales como motores: `formato: "local"` y `modelo` = archivo. */
export const MOTORES_LOCALES: readonly Motor[] = MODELOS_LOCALES.map((m) => ({
  alias: m.alias,
  formato: "local" as const,
  baseUrl: "",
  modelo: m.archivo,
  key: { desde: "ninguna" as const },
  nota: m.nota,
}));

export function dirModelos(): string {
  return join(homedir(), ".pi", "models");
}

export function dirDelModelo(modelo: ModeloLocal, base: string = dirModelos()): string {
  return join(base, modelo.alias);
}

/** ¿Está el binding nativo en esta plataforma? Falso = el motor local no se ofrece. */
export function bindingDisponible(cargar: () => unknown = () => cargarModulo()): boolean {
  try {
    cargar();
    return true;
  } catch {
    return false;
  }
}

export interface Progreso {
  fase: "descargando" | "extrayendo" | "verificando";
  mensaje: string;
}

export interface OpcionesDescarga {
  base?: string;
  fetchImpl?: typeof fetch;
  /** Inyectable para los tests: por defecto usa `tar` del sistema (bsdtar en Windows). */
  extraer?: (archivo: string, destino: string) => Promise<void>;
  alProgresar?: (progreso: Progreso) => void;
}

/**
 * Deja el modelo listo en disco y devuelve su directorio.
 * Si ya está (centinela presente) no toca la red. Una descarga parcial se borra y se
 * reintenta: nunca queda un modelo a medias marcado como completo.
 */
export async function asegurarModelo(modelo: ModeloLocal, opciones: OpcionesDescarga = {}): Promise<string> {
  const base = opciones.base ?? dirModelos();
  const destino = dirDelModelo(modelo, base);
  const centinela = join(destino, SENTINELA);

  if (existsSync(centinela)) return destino;

  // Restos de un intento anterior: se limpian antes de empezar.
  if (existsSync(destino)) rmSync(destino, { recursive: true, force: true });
  mkdirSync(destino, { recursive: true });
  mkdirSync(base, { recursive: true });

  const archivo = join(base, `${modelo.archivo}.tar.bz2`);
  const url = `${RELEASE}/${modelo.archivo}.tar.bz2`;
  const fetchImpl = opciones.fetchImpl ?? fetch;

  try {
    opciones.alProgresar?.({ fase: "descargando", mensaje: `descargando ${modelo.alias} (${modelo.mb} MB)` });
    const respuesta = await fetchImpl(url);
    if (!respuesta.ok || !respuesta.body) throw new Error(`HTTP ${respuesta.status} al bajar ${url}`);
    await pipeline(Readable.fromWeb(respuesta.body as never), createWriteStream(archivo));

    opciones.alProgresar?.({ fase: "extrayendo", mensaje: `extrayendo ${modelo.alias}` });
    await (opciones.extraer ?? extraerConTar)(archivo, destino);

    opciones.alProgresar?.({ fase: "verificando", mensaje: `verificando ${modelo.alias}` });
    verificar(modelo, destino);

    writeFileSync(centinela, "", "utf-8");
    return destino;
  } catch (error) {
    // Un modelo a medias es peor que ninguno: se borra para que el próximo intento
    // empiece limpio en vez de encontrar restos y creerlos buenos.
    rmSync(destino, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(archivo, { force: true });
  }
}

async function extraerConTar(archivo: string, destino: string): Promise<void> {
  // En Windows, `tar` del PATH resuelve al GNU tar de Git for Windows, que necesita
  // `bzip2.exe` (que no está) y falla con "corrupted data". El bsdtar que trae Windows en
  // System32 sí abre .tar.bz2, así que se prefiere ese cuando existe.
  await execFileAsync(tarBin(), ["xjf", archivo, "-C", destino, "--strip-components=1"]);
}

/** Ruta al `tar` que sabe abrir .tar.bz2 en esta plataforma. */
export function tarBin(
  plataforma: NodeJS.Platform = process.platform,
  entorno: NodeJS.ProcessEnv = process.env,
): string {
  if (plataforma === "win32") {
    const raiz = entorno.SystemRoot ?? entorno.windir ?? "C:\Windows";
    const bsdtar = join(raiz, "System32", "tar.exe");
    if (existsSync(bsdtar)) return bsdtar;
  }
  return "tar";
}

/** Qué archivos tienen que existir después de extraer, según la familia del modelo. */
export function verificar(modelo: ModeloLocal, destino: string): void {
  const presentes = new Set(readdirSync(destino));
  const falta = (nombre: string) => !presentes.has(nombre);

  if (modelo.tipo === "parakeet") {
    for (const f of ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"]) {
      if (falta(f)) throw new Error(`al modelo ${modelo.alias} le falta ${f}`);
    }
    return;
  }
  // Whisper: los nombres llevan prefijo del paquete y hay variantes fp32/int8.
  const hay = (patron: RegExp) => [...presentes].some((n) => patron.test(n));
  if (!hay(/-?encoder.*\.onnx$/)) throw new Error(`al modelo ${modelo.alias} le falta el encoder`);
  if (!hay(/-?decoder.*\.onnx$/)) throw new Error(`al modelo ${modelo.alias} le falta el decoder`);
  if (!hay(/tokens\.txt$/)) throw new Error(`al modelo ${modelo.alias} le faltan los tokens`);
}

/**
 * El motor local vivo: carga perezosa y liberación explícita.
 * `cargar()` es idempotente; `liberar()` suelta el modelo para que la memoria vuelva.
 */
export class MotorLocal {
  private recognizer: any = null;
  private ultimoUso = 0;
  private readonly modelo: ModeloLocal;
  private readonly directorio: string;

  private readonly idioma: string;

  constructor(modelo: ModeloLocal, directorio: string, opciones: { idioma?: string } = {}) {
    this.modelo = modelo;
    this.directorio = directorio;
    // Whisper necesita el idioma al cargar; los demás modelos lo detectan solos.
    this.idioma = opciones.idioma && opciones.idioma !== "auto" ? opciones.idioma : "es";
  }

  get cargado(): boolean {
    return this.recognizer !== null;
  }

  get inactivoMs(): number {
    return this.ultimoUso ? Date.now() - this.ultimoUso : 0;
  }

  cargar(): void {
    if (this.recognizer) return;
    const sherpa = cargarModulo();
    this.recognizer = crearReconocedor(sherpa, this.modelo, this.directorio, this.idioma);
    this.ultimoUso = Date.now();
  }

  transcribir(pcm: Buffer): string {
    if (!this.recognizer) throw new Error("el modelo local no está cargado");
    this.ultimoUso = Date.now();
    const muestras = new Float32Array(pcm.length / 2);
    for (let i = 0; i < muestras.length; i++) muestras[i] = pcm.readInt16LE(i * 2) / 32768;

    const flujo = this.recognizer.createStream();
    flujo.acceptWaveform({ samples: muestras, sampleRate: 16_000 });
    this.recognizer.decode(flujo);
    return String(this.recognizer.getResult(flujo).text ?? "").trim();
  }

  liberar(): void {
    this.recognizer = null;
  }
}

/** Carga `sherpa-onnx-node` sin romper el arranque si no está. */
function cargarModulo(): any {
  // Carga tolerante (no perezosa): si el binding no existe para esta plataforma, el motor
  // local no se ofrece y el resto de la extensión sigue viva. El que es perezoso es el
  // modelo, no el módulo.
  // `createRequire` porque esto se carga como ESM; `typeof require` cubre el caso de que
  // algún día el archivo se evalúe como CJS.
  const requerir =
    typeof require === "function" ? require : createRequire(import.meta.url);
  return requerir("sherpa-onnx-node");
}

function crearReconocedor(sherpa: any, modelo: ModeloLocal, dir: string, idioma: string): any {
  const base = { featConfig: { sampleRate: 16_000, featureDim: 80 } };

  if (modelo.tipo === "parakeet") {
    return new sherpa.OfflineRecognizer({
      ...base,
      modelConfig: {
        transducer: {
          encoder: join(dir, "encoder.int8.onnx"),
          decoder: join(dir, "decoder.int8.onnx"),
          joiner: join(dir, "joiner.int8.onnx"),
        },
        tokens: join(dir, "tokens.txt"),
        modelType: "nemo_transducer",
        numThreads: 4,
        provider: "cpu",
        debug: 0,
      },
    });
  }

  const archivos = readdirSync(dir);
  const encoder = archivos.find((n) => /encoder\.int8\.onnx$/.test(n)) ?? archivos.find((n) => /encoder.*\.onnx$/.test(n));
  const decoder = archivos.find((n) => /decoder\.int8\.onnx$/.test(n)) ?? archivos.find((n) => /decoder.*\.onnx$/.test(n));
  const tokens = archivos.find((n) => /tokens\.txt$/.test(n));
  if (!encoder || !decoder || !tokens) throw new Error(`modelo whisper incompleto en ${dir}`);
  // El binding de Node es config-based (no hay `fromWhisper`): el modelo se declara
  // dentro de `modelConfig.whisper`.
  return new sherpa.OfflineRecognizer({
    ...base,
    modelConfig: {
      whisper: {
        encoder: join(dir, encoder),
        decoder: join(dir, decoder),
        language: idioma,
        task: "transcribe",
      },
      tokens: join(dir, tokens),
      numThreads: 4,
      provider: "cpu",
      debug: 0,
    },
  });
}
