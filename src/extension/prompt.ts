/**
 * prompt.ts — lo que se le pide al modelo, en un solo lugar.
 *
 * Vive aparte de la extensión porque el test de humo (`scripts/smoke.mjs`) tiene que
 * mandar EXACTAMENTE el mismo prompt que el dictado real. Un smoke que prueba otro
 * prompt prueba otra cosa.
 */

/**
 * El camino `chat-completions` (un LLM que acepta audio) sigue soportado, pero **no tiene
 * motor por defecto**: sus dos únicos usuarios eran mimo/OpenCode Go, que se retiraron por
 * 63% de WER. Un default que apunta a un proveedor muerto hace que el smoke falle siempre
 * y que el error parezca del código. Quien quiera ese camino declara su motor en la config.
 */
export const MOTIVO_SIN_CHAT_DEFAULT = "el formato chat-completions no tiene motor por defecto; declaralo en \"motores\"";

/** El modelo a veces "piensa" la transcripción; el system la pide sin vueltas. */
export const SYSTEM =
  "Sos un transcriptor de audio. Devolvés únicamente la transcripción literal, sin razonar, sin comentar, sin formato.";

/**
 * Literalidad: no traducir, no corregir, no resumir, no comentar.
 *
 * La línea del dialecto no es adorno: quien dicta habla rioplatense y mezcla términos
 * técnicos en inglés. Sin ese contexto el modelo "normaliza" al español neutro (podés →
 * puedes) y ahí deja de transcribir para empezar a corregir. Se le dice quién habla,
 * no cómo tiene que escribir.
 */
export const PROMPT = `Transcribí el audio literal, palabra por palabra, en el mismo idioma en que se habla.
Contexto de quien habla: es un programador argentino. Usa español rioplatense (vos, podés, tenés, decime)
y mezcla términos técnicos en inglés (commit, branch, header, deploy).
Reglas:
- No traduzcas: si el audio está en inglés, transcribí en inglés; si está en español, en español.
- No lo pases a español neutro ni cambies voseo por tuteo: escribí como suena.
- No corrijas modismos, muletillas ni errores: escribí lo que se escucha.
- No agregues puntuación que no esté implícita en las pausas.
- No resumas, no expliques, no comentes.
- Si no hay voz, respondé exactamente: [sin voz]
Devolvé solo la transcripción.`;

/**
 * Glosario de nombres y términos que el modelo no puede adivinar por sonido:
 * "Vika", "Viktor", "pi", "OpenCode", el nombre del proyecto de Andréy. Sin esto,
 * "Vika" suena a "vica" y "pi" a "pibe" — y no hay prompt literal que lo arregle,
 * porque el problema es la decodificación, no la obediencia.
 *
 * El costo es deliberadamente chico: una línea, sólo si hay términos. Con el glosario
 * vacío el prompt es byte por byte el de siempre, así que activarlo o no es una
 * decisión que se puede medir (ver #5) sin tocar código.
 */
export function construirPrompt(glosario: readonly string[] = []): string {
  if (!glosario.length) return PROMPT;
  return `${PROMPT}
- Si el audio suena como alguno de estos nombres, escribilos exactamente así: ${glosario.join(", ")}.`;
}

/** Cuántos términos y caracteres se aceptan: un glosario gigante ahoga la llamada. */
export const GLOSARIO_MAX_TERMINOS = 40;
export const GLOSARIO_MAX_CARACTERES = 400;

/**
 * Normaliza el `glosario` de la config. Acepta lista de strings y también un string
 * separado por comas (lo que la gente escribe en un JSON a mano).
 * Un glosario inválido no rompe el dictado: se ignora y se avisa.
 */
export function normalizarGlosario(crudo: unknown): { lista: string[]; avisos: string[] } {
  if (crudo === undefined || crudo === null) return { lista: [], avisos: [] };

  let candidatos: unknown[];
  if (typeof crudo === "string") candidatos = crudo.split(",");
  else if (Array.isArray(crudo)) candidatos = crudo;
  else return { lista: [], avisos: [`glosario debe ser lista o texto separado por comas; lo ignoro`] };

  const vistos = new Set<string>();
  const lista: string[] = [];
  const ignorados: unknown[] = [];

  for (const candidato of candidatos) {
    if (typeof candidato !== "string") {
      ignorados.push(candidato);
      continue;
    }
    const termino = candidato.trim();
    if (!termino) continue;
    const clave = termino.toLowerCase();
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    lista.push(termino);
  }

  const avisos: string[] = [];
  if (ignorados.length) avisos.push(`glosario: ignoré ${ignorados.length} entrada(s) que no eran texto`);

  const recortada = lista.slice(0, GLOSARIO_MAX_TERMINOS);
  if (lista.length > recortada.length) {
    avisos.push(`glosario: uso los primeros ${GLOSARIO_MAX_TERMINOS} términos de ${lista.length}`);
  }

  let total = 0;
  const final: string[] = [];
  for (const termino of recortada) {
    total += termino.length + 2;
    if (total > GLOSARIO_MAX_CARACTERES) {
      avisos.push(`glosario: recorté en ${GLOSARIO_MAX_CARACTERES} caracteres para no inflar la llamada`);
      break;
    }
    final.push(termino);
  }

  return { lista: final, avisos };
}
