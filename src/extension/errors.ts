/**
 * errors.ts — la tabla de errores del plan, en un solo lugar.
 *
 * La invariante es una: **solo se pega cuando hay transcripción con voz**. Todo lo que
 * aparece acá termina en un aviso, nunca en un texto pegado. Que los mensajes vivan
 * juntos, y no repartidos en cada rama de la extensión, es lo que hace que la tabla se
 * pueda testear sin micrófono y sin red.
 */

export type CodigoError =
  | "sin-microfono"
  | "dispositivo-inexistente"
  | "sin-credencial"
  | "cancelado"
  | "sin-voz"
  | "transcripcion-vacia"
  | "timeout"
  | "http"
  | "respuesta-ilegible"
  | "modelo-local"
  | "grabacion-fallida"
  | "desconocido";

export class DictadoError extends Error {
  readonly codigo: CodigoError;
  readonly detalle?: string;

  constructor(codigo: CodigoError, mensaje: string, detalle?: string) {
    super(mensaje);
    this.name = "DictadoError";
    this.codigo = codigo;
    if (detalle !== undefined) this.detalle = detalle;
  }
}

export interface AvisoError {
  level: "warning" | "error";
  mensaje: string;
}

/** Recorta el cuerpo de una respuesta HTTP para poder mostrarlo sin llenar la pantalla. */
export function extractoHttp(cuerpo: string, maximo = 200): string {
  const limpio = cuerpo.replace(/\s+/g, " ").trim();
  return limpio.length > maximo ? `${limpio.slice(0, maximo)}…` : limpio;
}

/**
 * Traduce cualquier falla a un aviso. No decide si se pega: esa decisión ya está tomada
 * antes de llegar acá, y siempre es "no".
 */
export function mensajeDeError(error: unknown): AvisoError {
  if (error instanceof DictadoError) {
    switch (error.codigo) {
      case "cancelado":
        return { level: "warning", mensaje: "dictado cancelado; no pegué nada" };
      case "sin-voz":
        return {
          level: "warning",
          mensaje: `no escuché voz${error.detalle ? ` (${error.detalle})` : ""}; no pegué nada`,
        };
      case "transcripcion-vacia":
        return { level: "warning", mensaje: "la transcripción vino vacía; no pegué nada. Probá de nuevo" };
      case "timeout":
        return {
          level: "error",
          mensaje: "el proveedor tardó demasiado (60 s); no pegué nada. Probá de nuevo",
        };
      case "http":
        return {
          level: "error",
          mensaje: `el proveedor respondió con error${error.detalle ? ` (${error.detalle})` : ""}; no pegué nada`,
        };
      case "sin-microfono":
        return {
          level: "error",
          mensaje: `no encontré micrófono${error.detalle ? `: ${error.detalle}` : ""}. Revisá la entrada de audio del sistema`,
        };
      case "dispositivo-inexistente":
        return {
          level: "error",
          mensaje: `el micrófono configurado no existe${error.detalle ? ` (${error.detalle})` : ""}; revisá PI_VOXIFER_DEVICE o la config`,
        };
      case "sin-credencial":
        // El proveedor va en el detalle: antes estaba hardcodeado "opencode-go" y mentía
        // cuando el motor era un ASR de OpenRouter. Un mensaje que nombra al proveedor
        // equivocado manda a buscar el problema al archivo que no es.
        return {
          level: "error",
          mensaje: `no encontré credencial${error.detalle ? `: ${error.detalle}` : ""}; no llamé al proveedor`,
        };
      case "respuesta-ilegible":
        return { level: "error", mensaje: "la respuesta del proveedor no se pudo leer; no pegué nada" };
      case "modelo-local":
        return {
          level: "error",
          mensaje: `no pude preparar el modelo local${error.detalle ? `: ${error.detalle}` : ""}; no pegué nada`,
        };
      case "grabacion-fallida":
        return {
          level: "error",
          mensaje: `la grabación falló${error.detalle ? `: ${error.detalle}` : ""}; no pegué nada`,
        };
      default:
        return { level: "error", mensaje: error.message || "error desconocido en el dictado; no pegué nada" };
    }
  }

  const nombre = (error as { name?: unknown })?.name;
  if (nombre === "AbortError") return { level: "warning", mensaje: "dictado cancelado; no pegué nada" };
  if (nombre === "TimeoutError") {
    return { level: "error", mensaje: "el proveedor tardó demasiado (60 s); no pegué nada. Probá de nuevo" };
  }

  const mensaje = (error as { message?: unknown })?.message;
  return {
    level: "error",
    mensaje: `el dictado falló: ${typeof mensaje === "string" && mensaje ? mensaje : "error desconocido"}`,
  };
}
