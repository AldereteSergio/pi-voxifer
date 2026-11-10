/**
 * transcript.ts — sacar el texto de la respuesta del proveedor, y decidir si se pega.
 *
 * La regla del producto en una línea: **solo se pega cuando hay transcripción con voz**.
 * Este módulo es donde esa regla se implementa, lejos de la red y del micrófono, para
 * poder testearla con respuestas reales guardadas.
 *
 * Dos rarezas medidas contra `mimo-v2.6-flash` que el parseo tiene que aguantar:
 *
 *  1. La transcripción puede llegar fuera de `message.content`. Medido hoy, tres
 *     variantes del MISMO audio: `content` poblado (con system + reasoning apagado),
 *     `content: null` con el texto en `reasoning`, y `content: null` con el texto en
 *     `reasoning_content`. Se leen los tres campos en ese orden y nunca se confía en uno.
 *  2. Con silencio el modelo a veces inventa ("Gracias"). Por eso el VAD filtra antes
 *     del request y además, si el texto vuelve como `[sin voz]`, no se pega: es un aviso.
 */

export type MotivoNoPegar = "sin-voz" | "vacia" | "ilegible";

export type DecisionTranscript =
  | { accion: "pegar"; texto: string }
  | { accion: "avisar"; motivo: MotivoNoPegar };

/** Extrae el texto crudo de una respuesta de chat completions; null si no hay nada. */
export function extractTranscript(body: unknown): string | null {
  const mensaje = (body as { choices?: Array<{ message?: Record<string, unknown> }> })?.choices?.[0]?.message;
  if (!mensaje || typeof mensaje !== "object") return null;

  // `content` primero porque es el campo canónico. Los otros dos son los nombres que
  // usó el proveedor cuando decidió "pensar" la transcripción: `reasoning` y
  // `reasoning_content` aparecieron los dos, con el mismo modelo y el mismo audio.
  for (const campo of ["content", "reasoning", "reasoning_content"] as const) {
    const valor = mensaje[campo];
    if (typeof valor === "string") {
      const limpio = limpiar(valor);
      if (limpio) return limpio;
    }
  }
  return null;
}

/**
 * Aplica la regla del producto al texto extraído.
 * `null` = no vino nada; el texto `[sin voz]` = el modelo dice que no hay voz.
 */
export function decidirTranscript(texto: string | null): DecisionTranscript {
  if (texto === null) return { accion: "avisar", motivo: "vacia" };
  if (esSinVoz(texto)) return { accion: "avisar", motivo: "sin-voz" };
  if (!texto.trim()) return { accion: "avisar", motivo: "vacia" };
  return { accion: "pegar", texto };
}

/** Atajo: respuesta cruda → decisión, sin que el llamador repita los dos pasos. */
export function decidirRespuesta(body: unknown): DecisionTranscript {
  return decidirTranscript(extractTranscript(body));
}

/** `[sin voz]`, `[Sin voz]`, `sin voz.`, `SIN VOZ` → todos cuentan como "no hay voz". */
export function esSinVoz(texto: string): boolean {
  const normalizado = texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalizado === "sin voz";
}

/**
 * Limpieza mínima y deliberadamente conservadora: el producto promete literalidad.
 * - Saca espacios de los extremos (el modelo los agrega).
 * - Saca un bloque de código si envolvió el texto (pasa con respuestas largas).
 * - Saca comillas que envuelvan TODO el texto, no las de adentro.
 * No toca puntuación, muletillas, mayúsculas ni acentos: eso es lo dictado.
 */
function limpiar(texto: string): string {
  let t = texto.trim();

  const bloque = t.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (bloque) t = bloque[1]!.trim();

  const comillas = t.match(/^(["'“”«»])([\s\S]*)\1$/);
  if (comillas && comillas[2]) t = comillas[2].trim();

  return t;
}
