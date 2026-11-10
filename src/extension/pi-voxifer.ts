/**
 * pi-voxifer — dictado por voz para pi. Hablás, se transcribe, y el texto cae en el
 * editor. No se envía: el que decide sos vos.
 *
 *   Micrófono → decibri (PCM 16 kHz + VAD) → motor → transcripción → pasteToEditor()
 *
 * Dos clases de motor, y `formato` es el único campo que cambia el camino:
 *  - `local`: el modelo corre en este proceso con `sherpa-onnx-node`, sin red ni costo;
 *  - `transcriptions` y `chat-completions`: un endpoint compatible con OpenAI.
 *
 * La regla del producto, en una línea: **solo se pega cuando hay transcripción con
 * voz**. Todo lo demás es un aviso y el editor queda como estaba. Las decisiones de
 * "no hay voz", "no hay texto" y "qué significa este error" viven en `vad.ts`,
 * `transcript.ts` y `errors.ts`, con tests; acá solo se conectan.
 *
 * Lo que se aprendió midiendo y está codificado: sin voz no se llama al proveedor (un
 * silencio volvió como "Gracias"), el silencio de los bordes se recorta antes de mandar,
 * y el audio viaja en WAV 16 kHz mono.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Microphone, inputDevices } from "decibri";
import type { CommandContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CredencialResuelta } from "./auth.ts";
import { guardarTranscripcion, guardarWav } from "./guardado.ts";
import {
  caminoConfig,
  guardarConfig,
  leerConfigArchivo,
  migrarConfigSiHaceFalta,
  parsearArgsConfig,
  timeoutEfectivo,
} from "./config.ts";
import {
  IDIOMA_DEFAULT,
  VAR_KEY_UNICA,
  cabecerasDeMotor,
  motoresDisponibles,
  normalizarIdioma,
  normalizarMotoresExtra,
  resolverMotor,
  type Motor,
} from "./motores.ts";
import { recortarSilencio } from "./recorte.ts";
import { esEscape, nombreDeTecla } from "./teclas.ts";
import { diagnosticarAudio, esErrorSinDispositivo, entornoAudio } from "./audio.ts";
import { EqualizerView, nivelRms } from "./equalizer.ts";
import {
  MODELOS_LOCALES,
  MOTORES_LOCALES,
  MotorLocal,
  asegurarModelo,
  bindingDisponible,
} from "./local.ts";
import { DictadoError, extractoHttp, mensajeDeError } from "./errors.ts";
import { SYSTEM, construirPrompt, normalizarGlosario } from "./prompt.ts";
import { decidirRespuesta, esSinVoz } from "./transcript.ts";
import { decidirVoz, leerConfigVad, type VadConfig } from "./vad.ts";
import { FORMATO_CAPTURA, duracionSegundos, pcmToWav } from "./wav.ts";

const CONFIG_PATH = caminoConfig();
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
/** Techo de espera del proveedor; `timeoutMs` en la config lo mueve. */
const TIMEOUT_MS = 60_000;
const LENTO_MS = 15_000;
/** Techo por defecto de un dictado; `maxGrabacionMs` en la config lo alarga. */
const MAX_GRABACION_POR_DEFECTO_MS = 60_000;
const MAX_GRABACION_TOPE_MS = 30 * 60_000;
const FRAMES_POR_CHUNK = 1_600; // 100 ms a 16 kHz = 3.200 bytes de PCM


interface Config {
  device?: number | string | { id: string };
  /** Segundos de espera del proveedor (default 60; piso 5, tope 600). */
  timeoutMs?: number;
  vad?: unknown;
  glosario?: unknown;
  /** Alias del motor activo: los del catálogo o los de `motores`. */
  motor?: unknown;
  /** Idioma para el ASR: dos/tres letras o "auto". */
  idioma?: unknown;
  /** Credenciales por nombre de variable, para no depender del entorno. */
  apiKeys?: Record<string, unknown>;
  /** Forma vieja de la credencial de OpenRouter. Se sigue aceptando (con aviso mental). */
  openrouterApiKey?: unknown;
  /** Tecla para dictar sin escribir el comando (default ctrl+space). */
  atajo?: unknown;
  /** Segunda tecla, por si la primera la intercepta el sistema (default ctrl+shift+d). */
  atajoAlternativo?: unknown;
  /** Motores propios: [{ alias, tipo, proveedor, modelo, nota? }]. Pisan a los del código. */
  motores?: unknown;
  /** Guardar cada dictado (audio + transcripción automática) en el dataset. */
  guardarAudios?: unknown;
  /** Largo máximo de una grabación en ms (default 60 s, tope 30 min). */
  maxGrabacionMs?: unknown;
}

/**
 * Medido en la máquina de Andréy: `ctrl+space` no dispara (el IME de Windows se lo come)
 * y `ctrl+shift+d` **cierra el terminal entero** (atajo de la terminal, no de pi).
 *
 * Verificado en la máquina de Andréy: **`f9` funciona**; `ctrl+space` y `ctrl+alt+z` no
 * llegan (el IME o el layout se los come). Por eso el default es `f9` y el alternativo
 * `ctrl+alt+z`, y `/voxifer-settings → Ver y cambiar atajos` queda para cualquier tecla que quiera probar.
 */
const ATAJO_DEFAULT = "f9";
/**
 * Segunda tecla registrada siempre. En Windows el IME o el layout pueden quedarse con
 * `ctrl+space` antes de que la terminal lo vea, y no hay forma de detectarlo desde acá:
 * tener un segundo atajo evita que el usuario quede sin dictado mientras averigua.
 */
const ATAJO_ALTERNATIVO_DEFAULT = "ctrl+alt+z";

// Estado de proceso: el micrófono abierto y el request en vuelo, para que
// `session_shutdown` pueda cerrarlos sin dejar nada colgado.
let micActivo: Microphone | null = null;
let abortActivo: AbortController | null = null;
let ocupado = false;

/** Local encendido una vez por proceso: si el binding no está, no se ofrece. */
const localOk = bindingDisponible();
/** Modelo local vivo (uno por vez) y su temporizador de liberación. */
let motorLocal: { alias: string; motor: MotorLocal } | null = null;
let timerLiberar: ReturnType<typeof setTimeout> | null = null;
/** Sin uso por 30 minutos, el modelo se libera: ~930 MB no pueden quedarse de adorno. */
const LIBERAR_TRAS_MS = 30 * 60 * 1000;
/** Aviso de config que se muestra una sola vez, al primer uso. */
let avisoPendiente: string | undefined;

function localesDisponibles() {
  return localOk ? MOTORES_LOCALES : [];
}

/**
 * Sin motor configurado: `whisper-base` local si el binding está, si no el remoto.
 * Es el default local más barato de entrada (~198 MB, carga 686 ms) aunque no sea el más
 * preciso: el que nunca configuró nada no puede recibir 652 MB de descarga sorpresa.
 * `parakeet` (10% WER, 652 MB) queda como elección explícita.
 */
function motorPreferido(): string | undefined {
  return localOk ? "whisper-base" : undefined;
}

function liberarMotorLocal(): void {
  motorLocal?.motor.liberar();
  motorLocal = null;
  if (timerLiberar) clearTimeout(timerLiberar);
  timerLiberar = null;
}

function programarLiberacion(): void {
  if (timerLiberar) clearTimeout(timerLiberar);
  timerLiberar = setTimeout(liberarMotorLocal, LIBERAR_TRAS_MS);
  // No mantener vivo el proceso de pi solo por este temporizador.
  timerLiberar.unref?.();
}

export default function (pi: ExtensionAPI) {
  // El atajo se registra al cargar la extensión, así que leerlo de la config es una
  // lectura sincrónica: cambiarlo necesita recargar o reiniciar pi.
  // Migración del directorio viejo (pi-dictado → pi-voxifer): copia el config una vez y
  // avisa. Sin esto, quien actualiza arranca sin motor, sin idioma y sin key.
  avisoPendiente = migrarConfigSiHaceFalta();
  const { atajo, alternativo, aviso: avisoAtajo } = leerAtajos(leerConfigArchivo().cfg as Config);
  avisoPendiente = [avisoPendiente, avisoAtajo].filter(Boolean).join("; ") || undefined;

  pi.registerCommand("voxifer", {
    description: "Dictá por voz: graba, transcribe y deja el texto en el editor (no lo envía)",
    handler: async (_args, ctx) => {
      await ejecutar(ctx);
    },
  });

  pi.registerCommand("voxifer-settings", {
    description: "Configuración de voxifer: modelo, atajos, credencial e idioma",
    handler: async (_args, ctx) => {
      await menuConfiguracion(ctx);
    },
  });

  pi.registerShortcut(atajo, {
    description: "Dictado por voz (mismo flujo que /voxifer)",
    handler: async (ctx) => {
      await ejecutar(ctx);
    },
  });
  if (alternativo !== atajo) {
    pi.registerShortcut(alternativo, {
      description: "Dictado por voz (atajo alternativo)",
      handler: async (ctx) => {
        await ejecutar(ctx);
      },
    });
  }

  pi.on("session_shutdown", () => {
    liberarMotorLocal();
    micActivo?.stop();
    micActivo = null;
    abortActivo?.abort();
    abortActivo = null;
  });
}

/**
 * `/voxifer-settings`: menú único de configuración. Cada opción guarda **solo la clave
 * que cambia**: el resto de la config (key, dispositivo, glosario, motor) queda intacto.
 */
async function menuConfiguracion(ctx: CommandContext): Promise<void> {
  const { cfg } = leerConfig();
  const { atajo, alternativo } = leerAtajos(cfg);
  const { motor, aviso } = resolverMotor(cfg.motor ?? motorPreferido(), [
    ...normalizarMotoresExtra(cfg.motores).motores,
    ...localesDisponibles(),
  ]);
  const dataset = cfg.guardarAudios === true ? "activado" : "apagado";

  const opcion = await ctx.ui.select("Voxifer — configuración", [
    `Elegir modelo (actual: ${motor.alias})`,
    `Ver y cambiar atajos (actual: ${atajo})`,
    "Cargar credencial",
    `Idioma (actual: ${cfg.idioma ?? IDIOMA_DEFAULT})`,
    `Guardar audios para dataset (actual: ${dataset})`,
    `Largo máximo de grabación (actual: ${Math.round(leerMaxGrabacion(cfg) / 1000)} s)`,
  ]);
  if (!opcion) return;
  if (aviso) ctx.ui.notify(`pi-voxifer: ${aviso}`, "warning");

  if (opcion.startsWith("Elegir modelo")) return configurarDictado("", ctx);

  if (opcion.startsWith("Ver y cambiar atajos")) {
    ctx.ui.notify(`atajos registrados → ${atajo} y ${alternativo}`, "info");
    return capturarAtajo(ctx);
  }

  if (opcion.startsWith("Cargar credencial")) {
    // Se guarda bajo el nombre que ESTE motor busca. Con un motor propio que declara
    // `key.nombre: "DEEPINFRA_API_KEY"`, guardar en la variable única le decía "guardada"
    // y después el dictado fallaba con 401: la key estaba bajo otro nombre.
    const nombreKey = motorKeyParaGuardar(motor);
    const valor = await ctx.ui.input(`Pegá la API key de ${motor.alias}`, "sk-…");
    if (!valor?.trim()) return;
    const r = guardarConfig({ apiKeys: { [nombreKey]: valor.trim() } });
    ctx.ui.notify(
      r.ok
        ? `credencial guardada como ${nombreKey} (no se muestra en pantalla)`
        : `pi-voxifer: ${r.aviso}`,
      r.ok ? "info" : "error",
    );
    return;
  }

  if (opcion.startsWith("Idioma")) {
    const elegido = await ctx.ui.select(`Idioma del dictado (actual: ${cfg.idioma ?? IDIOMA_DEFAULT})`, [
      "es",
      "pt",
      "en",
      "auto",
    ]);
    if (!elegido) return;
    const r = guardarConfig({ idioma: elegido });
    ctx.ui.notify(r.ok ? `idioma = ${elegido}` : `pi-voxifer: ${r.aviso}`, r.ok ? "info" : "error");
    return;
  }

  if (opcion.startsWith("Largo máximo")) {
    const segundos = await ctx.ui.select(
      `Largo máximo de una grabación (actual: ${Math.round(leerMaxGrabacion(cfg) / 1000)} s)`,
      ["30", "60", "120", "300", "600"],
    );
    if (!segundos) return;
    const r = guardarConfig({ maxGrabacionMs: Number(segundos) * 1000 });
    ctx.ui.notify(r.ok ? `largo máximo = ${segundos} s` : `pi-voxifer: ${r.aviso}`, r.ok ? "info" : "error");
    return;
  }

  if (opcion.startsWith("Guardar audios")) {
    const activar = cfg.guardarAudios !== true;
    const r = guardarConfig({ guardarAudios: activar });
    ctx.ui.notify(
      r.ok ? `dataset ${activar ? "activado" : "apagado"}` : `pi-voxifer: ${r.aviso}`,
      r.ok ? "info" : "error",
    );
  }
}

/**
 * Selector de motor (o argumento directo desde la config). Guarda solo esa clave.
 */
async function configurarDictado(args: string, ctx: CommandContext): Promise<void> {
  const { parche, error } = parsearArgsConfig(args);
  if (error) {
    ctx.ui.notify(error, "error");
    return;
  }

  let aGuardar = parche;

  if (!Object.keys(parche).length) {
    const { cfg } = leerConfig();
    const extra = normalizarMotoresExtra(cfg.motores);
    const catalogo = [...extra.motores, ...localesDisponibles()];
    const { motor: actual } = resolverMotor(cfg.motor ?? motorPreferido(), catalogo);
    const propios = new Set(extra.motores.map((m) => m.alias));
    const etiquetas = motoresDisponibles(catalogo).map(
      (m) =>
        `${m.alias === actual.alias ? "✓" : " "}${propios.has(m.alias) ? "+" : " "} ${m.alias} — ${m.nota}`,
    );
    const elegido = await ctx.ui.select(`Motor de dictado (activo: ${actual.alias})`, etiquetas);
    if (!elegido) return;
    const alias = elegido.replace(/^[✓\s]*\+?\s*/, "").split(" ")[0] ?? "";
    const { motor } = resolverMotor(alias, catalogo);
    if (motor.alias !== alias) {
      ctx.ui.notify(`no reconocí el motor elegido (${alias}); no cambié nada`, "error");
      return;
    }
    aGuardar = { motor: motor.alias };
  }

  const resultado = guardarConfig(aGuardar);
  if (!resultado.ok) {
    ctx.ui.notify(`pi-voxifer: ${resultado.aviso ?? "no pude guardar la config"}`, "error");
    return;
  }
  const resumen = Object.entries(aGuardar)
    .map(([clave, valor]) => `${clave} = ${Array.isArray(valor) ? valor.join(", ") : String(valor)}`)
    .join(", ");
  ctx.ui.notify(`pi-voxifer: guardado ${resumen} en ${CONFIG_PATH}`, "info");
}

export interface Atajos {
  atajo: string;
  alternativo: string;
  aviso?: string;
}

/** Valida "modificador+tecla"; un atajo inventado no puede romper el arranque. */
/**
 * Largo máximo de una grabación. Default 60 s; el tope de 30 min evita que un valor
 * absurdo en la config deje el micrófono abierto toda la tarde.
 */
export function leerMaxGrabacion(cfg: Config): number {
  const valor = cfg.maxGrabacionMs;
  if (typeof valor !== "number" || !Number.isFinite(valor)) return MAX_GRABACION_POR_DEFECTO_MS;
  return Math.min(MAX_GRABACION_TOPE_MS, Math.max(5_000, Math.round(valor)));
}

export function normalizarAtajo(valor: unknown): string | undefined {
  if (typeof valor !== "string") return undefined;
  const texto = valor.trim().toLowerCase().replace(/\s+/g, "");
  if (!/^(ctrl|alt|shift|super)(\+(ctrl|alt|shift|super))*\+[a-z0-9]+$/.test(texto)) return undefined;
  return texto;
}

export function leerAtajos(cfg: Config = {}): Atajos {
  const pedido = cfg.atajo;
  const alternativoPedido = cfg.atajoAlternativo;
  const atajo = normalizarAtajo(pedido) ?? ATAJO_DEFAULT;
  const alternativo = normalizarAtajo(alternativoPedido) ?? ATAJO_ALTERNATIVO_DEFAULT;

  const avisos: string[] = [];
  if (pedido !== undefined && normalizarAtajo(pedido) === undefined) {
    avisos.push(`atajo "${String(pedido)}" inválido; uso ${ATAJO_DEFAULT}`);
  }
  if (alternativoPedido !== undefined && normalizarAtajo(alternativoPedido) === undefined) {
    avisos.push(`atajoAlternativo "${String(alternativoPedido)}" inválido; uso ${ATAJO_ALTERNATIVO_DEFAULT}`);
  }
  return { atajo, alternativo, aviso: avisos.join("; ") || undefined };
}

/**
 * `/voxifer-settings → Ver y cambiar atajos`: deja que el usuario apriete una tecla y dice qué vio pi.
 * Es la única forma de distinguir "el sistema se la come" de "la tecla sí llega".
 */
async function capturarAtajo(ctx: CommandContext): Promise<void> {
  const capturado = await ctx.ui.custom<{ nombre: string | null; legible: string } | null>(
    (_tui, theme, _keybindings, done) => ({
      render: () => [
        theme.fg("accent", "Apretá la tecla que querés usar para dictar"),
        "Esc para cancelar · se guarda en el config y necesita /reload",
      ],
      handleInput: (data: string) => {
        if (esEscape(data)) {
          done(null);
          return;
        }
        done(nombreDeTecla(data));
      },
      invalidate: () => {},
    }),
    { overlay: true },
  );

  if (!capturado) {
    ctx.ui.notify("pi-voxifer: captura cancelada", "info");
    return;
  }
  if (!capturado.nombre) {
    ctx.ui.notify(
      `pi-voxifer: pi recibió ${capturado.legible}, pero no sé nombrarla como atajo. Probá con otra (letra, F9 o combinación con ctrl/alt).`,
      "warning",
    );
    return;
  }

  const resultado = guardarConfig({ atajo: capturado.nombre });
  if (!resultado.ok) {
    ctx.ui.notify(`pi-voxifer: ${resultado.aviso ?? "no pude guardar el atajo"}`, "error");
    return;
  }
  ctx.ui.notify(
    `pi-voxifer: atajo guardado → ${capturado.nombre}. Corré /reload y probalo ahora: ` +
      `si no dispara, el sistema se la está comiendo antes de pi — volvé a /voxifer-settings → Ver y cambiar atajos con otra.`,
    "info",
  );
}

async function ejecutar(ctx: CommandContext): Promise<void> {
  if (ocupado) {
    ctx.ui.notify("ya estoy grabando; terminá el dictado anterior primero", "warning");
    return;
  }

  ocupado = true;
  try {
    if (avisoPendiente) {
      ctx.ui.notify(`pi-voxifer: ${avisoPendiente}`, "warning");
      avisoPendiente = undefined;
    }
    const { cfg, avisos } = leerConfig();
    const glosario = normalizarGlosario(cfg.glosario);
    const extra = normalizarMotoresExtra(cfg.motores);
    const { motor, aviso: avisoMotor } = resolverMotor(cfg.motor ?? motorPreferido(), [
      ...extra.motores,
      ...localesDisponibles(),
    ]);
    const { idioma, aviso: avisoIdioma } = normalizarIdioma(cfg.idioma);
    for (const aviso of [...avisos, ...extra.avisos, ...glosario.avisos, avisoMotor, avisoIdioma].filter(Boolean)) {
      ctx.ui.notify(`pi-voxifer: ${aviso}`, "warning");
    }

    const dispositivo = resolverDispositivo(cfg);
    const resultado = await ventanaDictado(ctx, cfg, dispositivo, glosario.lista, motor, idioma);

    switch (resultado.tipo) {
      case "texto":
        ctx.ui.pasteToEditor(resultado.texto);
        ctx.ui.notify(
          `dictado listo (${resultado.segundos.toFixed(1)} s de voz)` +
            (resultado.audioGuardado ? ` · audio en ${resultado.audioGuardado}` : ""),
          "info",
        );
        break;
      case "aviso": {
        const aviso = mensajeDeError(resultado.error);
        ctx.ui.notify(aviso.mensaje, aviso.level);
        break;
      }
    }
  } catch (error) {
    const aviso = mensajeDeError(error);
    ctx.ui.notify(aviso.mensaje, aviso.level);
  } finally {
    // La bandera se libera pase lo que pase: si queda trabada, /voxifer deja de existir
    // hasta reiniciar pi, y eso no se descubre hasta que hace falta dictar.
    ocupado = false;
    micActivo?.stop();
    micActivo = null;
    abortActivo = null;
  }
}

type Resultado =
  | { tipo: "texto"; texto: string; segundos: number; audioGuardado?: string }
  | { tipo: "aviso"; error: unknown };

/**
 * Una sola ventana para las dos fases: graba, y al cortar sigue la misma ventana
 * latiendo como "transcribiendo" con el reloj corrido. Cerrarla y reabrirla cambiaría
 * el contador visual y el usuario vería un salto de 4 s a 24 s.
 */
async function ventanaDictado(
  ctx: CommandContext,
  cfg: Config,
  dispositivo: ReturnType<typeof resolverDispositivo>,
  glosario: readonly string[],
  motor: Motor = resolverMotor(undefined).motor,
  idioma = "es",
): Promise<Resultado> {
  // Credencial antes de grabar: si falta la key, no tiene sentido abrir el micrófono
  // ni hacerte hablar para nada.
  const credencial = resolverCredencial(motor, cfg);
  const { cfg: vadConfig } = leerConfigVad(cfg.vad);

  return ctx.ui.custom<Resultado>(
    async (tui, theme, keybindings, done) => {
      const inicio = Date.now();
      const maxGrabacion = leerMaxGrabacion(cfg);
      // Onda portada de rpiv-voice: 7 filas con silueta de ruido fBm que viaja. Se
      // alimenta con RMS crudo del PCM (no con `vadScore`, que es probabilidad de voz y
      // como altura daría un bloque plano en voz alta).
      const onda = new EqualizerView(theme);
      const abort = new AbortController();
      let mic: Microphone | null = null;
      let fase: "grabando" | "transcribiendo" = "grabando";
      const audio: Buffer[] = [];
      const scores: number[] = [];
      let pico = 0;
      let cerrado = false;
      let timer: ReturnType<typeof setInterval> | null = null;

      const limpiar = () => {
        if (timer) clearInterval(timer);
        timer = null;
        mic?.stop();
        if (micActivo === mic) micActivo = null;
        mic = null;
        if (abortActivo === abort) abortActivo = null;
      };

      const fin = (resultado: Resultado) => {
        if (cerrado) return;
        cerrado = true;
        limpiar();
        done(resultado);
      };

      const error = (e: unknown) => fin({ tipo: "aviso", error: e });

      /** Corta la grabación y decide: avisar o transcribir. */
      const cortar = () => {
        if (fase !== "grabando") return;

        const voz = decidirVoz(scores, vadConfig);
        if (!voz.hayVoz) {
          error(
            new DictadoError(
              "sin-voz",
              "no escuché voz",
              `máx ${voz.maxScore.toFixed(2)} con umbral ${vadConfig.threshold}; si hablaste bajá el umbral en la config`,
            ),
          );
          return;
        }

        const pcm = Buffer.concat(audio);
        if (!pcm.length) {
          error(new DictadoError("sin-voz", "no grabé nada", "el micrófono no entregó audio"));
          return;
        }

        // Silencio en los bordes: Whisper rellena el silencio inicial con "¡Gracias!".
        // Se recorta ANTES de mandar (y de guardar), así lo que se compara es lo que viajó.
        const recorte = recortarSilencio(pcm, { sampleRate: FORMATO_CAPTURA.sampleRate });
        const limpio = recorte.pcm;
        const segundos = duracionSegundos(limpio.length, FORMATO_CAPTURA);
        // Dataset para finetuning: si está activado, el audio va a disco con su
        // transcripción automática al lado (la revisión humana es un paso posterior).
        const audioGuardado = cfg.guardarAudios === true ? guardarWav(limpio) : undefined;
        mic?.stop();
        if (micActivo === mic) micActivo = null;
        mic = null;
        fase = "transcribiendo";

        transcribir(limpio, {
          avisar: (mensaje) => ctx.ui.notify(`pi-voxifer: ${mensaje}`, "info"),
          motor,
          idioma,
          credencial: credencial!,
          prompt: construirPrompt(glosario),
          sessionId: ctx.sessionManager.getSessionId(),
          timeoutMs: timeoutEfectivo((cfg as Config).timeoutMs),
          abort,
        })
          .then((texto) => {
            if (audioGuardado) {
              guardarTranscripcion(audioGuardado, {
                texto,
                motor: motor.alias,
                modelo: motor.modelo,
                idioma,
                segundos,
              });
            }
            fin({ tipo: "texto", texto, segundos, audioGuardado });
          })
          .catch((e) => error(e));
      };

      try {
        mic = await Microphone.open({
          ...FORMATO_CAPTURA,
          dtype: "int16",
          framesPerBuffer: FRAMES_POR_CHUNK,
          vad: "silero",
          ...(dispositivo === undefined ? {} : { device: dispositivo }),
        });
      } catch (e) {
        const mensaje = (e as { message?: string })?.message ?? "no pude abrir el micrófono";
        if (esErrorSinDispositivo(mensaje)) {
          const diagnostico = diagnosticarAudio(mensaje, entornoAudio());
          done({ tipo: "aviso", error: new DictadoError("sin-microfono", diagnostico.mensaje, diagnostico.detalle) });
        } else {
          done({ tipo: "aviso", error: new DictadoError("grabacion-fallida", mensaje, mensaje) });
        }
        return { render: () => [], handleInput: () => {}, invalidate: () => {} };
      }

      micActivo = mic;
      abortActivo = abort;

      mic.on("data", (chunk: Buffer) => {
        if (fase === "transcribiendo") return;
        audio.push(chunk);
        onda.setProps({ level: nivelRms(chunk), status: "recording", enabled: true });
        scores.push(mic?.vadScore ?? 0);
        for (let i = 0; i + 1 < chunk.length; i += 2) {
          const muestra = Math.abs(chunk.readInt16LE(i));
          if (muestra > pico) pico = muestra;
        }
      });
      mic.on("error", (e: { message?: string }) => {
        const mensaje = e?.message ?? "el micrófono falló";
        error(new DictadoError("grabacion-fallida", mensaje, mensaje));
      });

      timer = setInterval(() => {
        const transcurrido = Date.now() - inicio;
        if (fase === "grabando" && transcurrido >= maxGrabacion) cortar();
        tui.requestRender?.();
      }, 100);

      const marco = (width: number) => theme.fg("dim", "─".repeat(Math.max(0, width)));

      const linea = (texto: string, width: number) => {
        const plano = texto.replace(/\u001b\[[0-9;]*m/g, "");
        return plano.length > width ? plano.slice(0, Math.max(0, width - 1)) + "…" : plano;
      };

      // Minimalista y en el área del input: una línea de estado, la onda y una ayuda.
      // Sin barra ASCII extra (la onda ya dice el nivel) y sin relleno arriba ni abajo.
      return {
        render(width: number): string[] {
          const seg = ((Date.now() - inicio) / 1000).toFixed(1);
          if (fase === "grabando") {
            const sordo = Date.now() - inicio > 1_200 && decidirVoz(scores, vadConfig).chunksSobreUmbral === 0;
            return [
              marco(width),
              linea(theme.fg("error", "● grabando") + theme.fg("muted", `  ${seg} s`), width),
              ...onda.render(width),
              linea(
                sordo
                  ? theme.fg("warning", "todavía no te escuché")
                  : theme.fg("dim", "Enter corta · Esc cancela"),
                width,
              ),
              marco(width),
            ];
          }
          const tarda = Date.now() - inicio > LENTO_MS;
          return [
            marco(width),
            linea(theme.fg("accent", "… transcribiendo") + theme.fg("muted", `  ${seg} s`), width),
            linea(
              tarda
                ? theme.fg("warning", "el proveedor está tardando · Esc cancela")
                : theme.fg("dim", "Esc cancela"),
              width,
            ),
            marco(width),
          ];
        },
        handleInput(data: string): void {
          const confirma =
            (keybindings?.matches?.(data, "tui.select.confirm") ?? false) || data === "\r" || data === "\n";
          const cancela = (keybindings?.matches?.(data, "tui.select.cancel") ?? false) || data === "\u001b";
          if (cancela) {
            abort.abort();
            fin({ tipo: "aviso", error: new DictadoError("cancelado", "cancelado") });
          } else if (confirma && fase === "grabando") {
            cortar();
          }
        },
        invalidate(): void {},
      };
    },
    // Sin `overlay`: el componente reemplaza al editor mientras dura el dictado, así la
    // onda vive en el área del input en vez de flotar en el medio de la pantalla.
  );
}

/**
 * Bajo qué nombre se guarda la key que el usuario pega en el menú: el que el motor activo
 * va a buscar en `apiKeys`, no siempre la variable única.
 */
export function motorKeyParaGuardar(motor: Motor): string {
  return motor.key.desde === "entorno" ? motor.key.nombre : VAR_KEY_UNICA;
}

/** Credencial del proveedor que pide el motor elegido. */
/**
 * Credencial del motor según su `key`: de entorno (`process.env` o `apiKeys` del config)
 * o escrita en la config. Sin key declarada, algunos endpoints locales no la necesitan.
 */
export function resolverCredencial(motor: Motor, cfg: Config): CredencialResuelta {
  const key = motor.key;

  if (key.desde === "config") return { apiKey: key.valor, baseUrl: motor.baseUrl };

  if (key.desde === "entorno") {
    const candidatos: Array<{ valor?: unknown; de: string }> = [
      { valor: process.env[key.nombre], de: key.nombre },
      { valor: cfg.apiKeys?.[key.nombre], de: `apiKeys.${key.nombre}` },
    ];

    // Compatibilidad: la variable única es la nueva, pero una config vieja puede tener
    // `OPENROUTER_API_KEY` en el entorno o el campo `openrouterApiKey` del JSON.
    if (key.nombre === VAR_KEY_UNICA) {
      candidatos.push(
        { valor: process.env.OPENROUTER_API_KEY, de: "OPENROUTER_API_KEY" },
        { valor: cfg.openrouterApiKey, de: "openrouterApiKey (config vieja)" },
      );
    }

    const encontrado = candidatos.find((c) => typeof c.valor === "string" && c.valor.trim());
    if (encontrado) return { apiKey: String(encontrado.valor).trim(), baseUrl: motor.baseUrl };

    throw new DictadoError(
      "sin-credencial",
      `falta la credencial de ${motor.alias}`,
      `exportá ${key.nombre} (sirve para cualquier proveedor) o ponela en "apiKeys": { "${key.nombre}": "…" } en ${CONFIG_PATH}`,
    );
  }

  // Sin key declarada: se manda sin Authorization (endpoints locales que no la piden).
  return { apiKey: "", baseUrl: motor.baseUrl };
}

/**
 * Camino `local`: descarga el modelo la primera vez, lo carga si no está cargado y
 * transcribe en el proceso. Después programa la liberación por inactividad.
 */
async function transcribirLocal(pcm: Buffer, opts: OpcionesTranscripcion): Promise<string> {
  const modelo = MODELOS_LOCALES.find((m) => m.archivo === opts.motor.modelo);
  if (!modelo) {
    throw new DictadoError("modelo-local", "modelo local desconocido", `motor: ${opts.motor.alias}`);
  }

  let directorio: string;
  try {
    directorio = await asegurarModelo(modelo, {
      alProgresar: (p) => opts.avisar?.(p.mensaje),
    });
  } catch (e) {
    const mensaje = (e as { message?: string })?.message ?? "no pude bajar el modelo";
    throw new DictadoError("modelo-local", mensaje, mensaje);
  }

  if (!motorLocal || motorLocal.alias !== modelo.alias) {
    liberarMotorLocal();
    motorLocal = { alias: modelo.alias, motor: new MotorLocal(modelo, directorio, { idioma: opts.idioma }) };
  }

  try {
    motorLocal.motor.cargar();
    const texto = motorLocal.motor.transcribir(pcm);
    if (!texto) throw new DictadoError("transcripcion-vacia", "la transcripción vino vacía");
    if (esSinVoz(texto)) throw new DictadoError("sin-voz", "el modelo no encontró voz");
    programarLiberacion();
    return texto;
  } catch (e) {
    if (e instanceof DictadoError) throw e;
    const mensaje = (e as { message?: string })?.message ?? "el motor local falló";
    throw new DictadoError("modelo-local", mensaje, mensaje);
  }
}

/**
 * Camino `transcriptions`: multipart a `/audio/transcriptions`, sin prompt.
 * El idioma va siempre: sin `language`, Whisper traduce al inglés de forma intermitente.
 */
async function transcribirAsr(pcm: Buffer, opts: OpcionesTranscripcion): Promise<string> {
  const wav = pcmToWav(pcm);
  const forma = new FormData();
  forma.append("model", opts.motor.modelo);
  // `new Uint8Array(wav)` copia a un buffer propio: Blob no acepta el Buffer de Node
  // directamente porque su ArrayBuffer puede ser compartido.
  forma.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "dictado.wav");
  if (opts.idioma !== "auto") forma.append("language", opts.idioma);

  const senal = AbortSignal.any([opts.abort.signal, AbortSignal.timeout(opts.timeoutMs)]);
  let respuesta: Response;
  try {
    respuesta = await fetch(`${opts.motor.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: cabecerasDeMotor(opts.motor, opts.credencial.apiKey, opts.sessionId),
      body: forma,
      signal: senal,
    });
  } catch (e) {
    throw errorDeRed(e, opts.abort, opts.timeoutMs);
  }

  const cuerpo = await respuesta.text();
  if (!respuesta.ok) {
    throw new DictadoError("http", `HTTP ${respuesta.status}`, `${respuesta.status} ${extractoHttp(cuerpo)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(cuerpo);
  } catch {
    throw new DictadoError("respuesta-ilegible", "la respuesta no es JSON", extractoHttp(cuerpo));
  }

  // El ASR devuelve `{ text }` en la raíz, no `choices[0].message`.
  const texto = typeof (json as { text?: unknown })?.text === "string" ? (json as { text: string }).text.trim() : "";
  if (!texto) throw new DictadoError("transcripcion-vacia", "la transcripción vino vacía");
  if (esSinVoz(texto)) throw new DictadoError("sin-voz", "el modelo no encontró voz");
  return texto;
}

/** Envía el audio al motor y devuelve la transcripción, por el camino de su formato. */
async function transcribir(
  pcm: Buffer,
  opts: OpcionesTranscripcion,
): Promise<string> {
  if (opts.motor.formato === "local") return transcribirLocal(pcm, opts);
  return opts.motor.formato === "transcriptions" ? transcribirAsr(pcm, opts) : transcribirLlmAudio(pcm, opts);
}

/** Traduce el error de red a la tabla de errores: cancelado, timeout o HTTP. */
function errorDeRed(e: unknown, abort: AbortController, timeoutMs: number): DictadoError {
  if (abort.signal.aborted) return new DictadoError("cancelado", "cancelado");
  if ((e as { name?: string })?.name === "TimeoutError") {
    return new DictadoError("timeout", `sin respuesta en ${timeoutMs / 1000} s`);
  }
  const mensaje = (e as { message?: string })?.message ?? "no pude llegar al proveedor";
  return new DictadoError("http", mensaje, mensaje);
}

interface OpcionesTranscripcion {
  motor: Motor;
  /** Aviso al usuario (progreso de descarga del modelo, por ejemplo). */
  avisar?: (mensaje: string) => void;
  credencial: CredencialResuelta;
  prompt: string;
  sessionId: string;
  idioma: string;
  /** Timeout efectivo del request, ya validado (`timeoutEfectivo`). */
  timeoutMs: number;
  abort: AbortController;
}

async function transcribirLlmAudio(pcm: Buffer, opts: OpcionesTranscripcion): Promise<string> {
  const wav = pcmToWav(pcm);
  const senal = AbortSignal.any([opts.abort.signal, AbortSignal.timeout(opts.timeoutMs)]);

  let respuesta: Response;
  try {
    respuesta = await fetch(`${opts.motor.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        ...cabecerasDeMotor(opts.motor, opts.credencial.apiKey, opts.sessionId),
        "content-type": "application/json",

      },
      body: JSON.stringify({
        model: opts.motor.modelo,
        reasoning: { enabled: false },
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: [
              { type: "input_audio", input_audio: { data: wav.toString("base64"), format: "wav" } },
              { type: "text", text: opts.prompt },
            ],
          },
        ],
      }),
      signal: senal,
    });
  } catch (e) {
    throw errorDeRed(e, opts.abort, opts.timeoutMs);
  }

  const cuerpo = await respuesta.text();
  if (!respuesta.ok) {
    throw new DictadoError("http", `HTTP ${respuesta.status}`, `${respuesta.status} ${extractoHttp(cuerpo)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(cuerpo);
  } catch {
    throw new DictadoError("respuesta-ilegible", "la respuesta no es JSON", extractoHttp(cuerpo));
  }

  const decision = decidirRespuesta(json);
  if (decision.accion === "avisar") {
    if (decision.motivo === "sin-voz") throw new DictadoError("sin-voz", "el modelo no encontró voz");
    if (decision.motivo === "vacia") {
      throw new DictadoError("transcripcion-vacia", "la transcripción vino vacía");
    }
    throw new DictadoError("respuesta-ilegible", "no pude leer la transcripción");
  }
  return decision.texto;
}

function leerConfig(): { cfg: Config; avisos: string[] } {
  const { cfg, avisos } = leerConfigArchivo();
  return { cfg: cfg as Config, avisos: avisos.map((a) => (a.includes(CONFIG_PATH) ? a : `${a} (${CONFIG_PATH})`)) };
}

/**
 * Orden de resolución del micrófono: env → config → default del sistema. Si el
 * dispositivo pedido no existe, se dice con la lista de los que sí, porque el error
 * de un dispositivo mal escrito es indistinguible de "no hay micrófono" si no se nombra.
 */
function resolverDispositivo(cfg: Config): number | string | { id: string } | undefined {
  // En WSL sin audio, enumerar no devuelve lista vacía: **tira** un error de ALSA. Se
  // clasifica acá para no contestar "la grabación falló" con el texto de la librería.
  let disponibles;
  try {
    disponibles = inputDevices();
  } catch (e) {
    const mensaje = (e as { message?: string })?.message ?? "falló la enumeración de dispositivos";
    const diagnostico = diagnosticarAudio(mensaje, entornoAudio());
    throw new DictadoError("sin-microfono", diagnostico.mensaje, diagnostico.detalle);
  }
  if (!disponibles.length) {
    const diagnostico = diagnosticarAudio("la enumeración volvió vacía", entornoAudio());
    throw new DictadoError("sin-microfono", diagnostico.mensaje, diagnostico.detalle);
  }

  const deEnv = process.env.PI_VOXIFER_DEVICE?.trim();
  const pedido = deEnv ? normalizarDispositivo(deEnv) : cfg.device;
  if (pedido === undefined || pedido === null || pedido === "") return undefined;

  const existe = disponibles.some((d) => {
    if (typeof pedido === "number") return d.index === pedido;
    if (typeof pedido === "string") return d.name.toLowerCase().includes(pedido.toLowerCase());
    return d.id === pedido.id;
  });

  if (!existe) {
    const lista = disponibles.map((d) => `${d.index}: ${d.name}`).join(", ");
    throw new DictadoError("dispositivo-inexistente", "el micrófono configurado no está", `pedido ${JSON.stringify(pedido)}; disponibles: ${lista}`);
  }
  return pedido;
}

function normalizarDispositivo(valor: string | number): number | string {
  if (typeof valor === "number") return valor;
  // "0" desde una variable de entorno es un índice, no un nombre que contiene "0".
  return /^\d+$/.test(valor) ? Number(valor) : valor;
}
