/**
 * diff.ts — alinear dos transcripciones palabra por palabra (LCS).
 *
 * Para qué: comparar motores no es "cuál texto me gusta más", es **qué palabras cambian**.
 * `[-palabra]` es lo que dijo un motor y el otro no; `[+palabra]` al revés. Con esto el
 * issue #5 se lee como una lista de sustituciones, no como una impresión.
 *
 * El LCS clásico es O(n·m): para una frase de dictado (decenas de palabras) es instantáneo
 * y no vale la pena la versión con memoria optimizada.
 */

export function alinearPalabras(izquierda: string, derecha: string): string {
  const a = palabras(izquierda);
  const b = palabras(derecha);

  const tabla: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      tabla[i]![j] = a[i] === b[j] ? tabla[i + 1]![j + 1]! + 1 : Math.max(tabla[i + 1]![j]!, tabla[i]![j + 1]!);
    }
  }

  const marcas: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      marcas.push(a[i]!);
      i++;
      j++;
    } else if (tabla[i + 1]![j]! >= tabla[i]![j + 1]!) {
      marcas.push(`[-${a[i]}]`);
      i++;
    } else {
      marcas.push(`[+${b[j]}]`);
      j++;
    }
  }
  while (i < a.length) marcas.push(`[-${a[i++]}]`);
  while (j < b.length) marcas.push(`[+${b[j++]}]`);

  return marcas.join(" ");
}

/** Cuántas palabras cambian (sustituciones + agregados + faltantes). */
export function contarCambios(izquierda: string, derecha: string): number {
  return (alinearPalabras(izquierda, derecha).match(/\[[-+][^\]]*\]/g) ?? []).length;
}

function palabras(texto: string): string[] {
  return (texto ?? "").split(/\s+/).filter(Boolean);
}
