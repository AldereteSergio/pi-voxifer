/**
 * wer.ts — tasa de error por palabra, para comparar transcriptores con un número y no
 * con "cuál me gusta más". El ojo perdona una palabra inventada si la frase suena linda.
 *
 * Normaliza antes de comparar: acentos, mayúsculas y puntuación no son errores de
 * transcripción, son decisiones de formato. Las palabras sí.
 */

export function normalizarPalabras(texto: string): string[] {
  return (texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Levenshtein sobre palabras: inserciones + borrados + sustituciones. */
export function distanciaPalabras(a: readonly string[], b: readonly string[]): number {
  const filas: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) filas[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      filas[i]![j] = Math.min(
        filas[i - 1]![j]! + 1,
        filas[i]![j - 1]! + 1,
        filas[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return filas[a.length]![b.length]!;
}

/**
 * WER = errores / palabras de la referencia. Puede pasar de 1 cuando el motor agrega
 * texto de más (un motor que alucina una frase entera puntúa peor que uno que se calla).
 */
export function wer(referencia: string, hipotesis: string): number {
  const r = normalizarPalabras(referencia);
  const h = normalizarPalabras(hipotesis);
  if (!r.length) return h.length ? 1 : 0;
  return distanciaPalabras(r, h) / r.length;
}
