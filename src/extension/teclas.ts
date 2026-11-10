/**
 * teclas.ts — qué tecla apretó el usuario, en el idioma de pi.
 *
 * Por qué existe: `ctrl+space` no dispara en la máquina de Andréy y `ctrl+shift+d` cierra
 * el terminal entero. Las dos posibilidades son la misma cosa vista de dos lados: el
 * sistema se come la combinación antes de que llegue a pi. No hay forma de detectar eso
 * desde adentro, así que la salida es **preguntarle a pi qué tecla vio**: el comando
 * `/voxifer-settings → Ver y cambiar atajos` captura una pulsación y la muestra con su nombre.
 *
 * La tabla es chica y explícita a propósito: cubre las teclas razonables para un atajo y
 * para el resto devuelve `null`, que el llamador muestra como bytes crudos. Mejor un
 * diagnóstico feo que una adivinanza.
 */

export interface TeclaCapturada {
  /** Nombre utilizable en `atajo`, o null si pi recibió algo que no sabemos nombrar. */
  nombre: string | null;
  /** Representación legible para mostrar, siempre disponible. */
  legible: string;
}

const SIMPLES: Record<string, string> = {
  "\x00": "ctrl+space",
  "\x01": "ctrl+a",
  "\x02": "ctrl+b",
  "\x03": "ctrl+c",
  "\x04": "ctrl+d",
  "\x05": "ctrl+e",
  "\x06": "ctrl+f",
  "\x07": "ctrl+g",
  // pi-tui mapea el byte 08 a "ctrl+backspace" SOLO en Windows Terminal y a "backspace"
  // en el resto (keys.js). Desde acá no sé qué terminal es, así que dejo lo conservador:
  // una entrada mentirosa en una tabla de diagnóstico es peor que una ausente.
  "\x08": "backspace",
  "\t": "tab",
  "\r": "enter",
  "\n": "enter",
  "\x0b": "ctrl+k",
  "\x0c": "ctrl+l",
  "\x0e": "ctrl+n",
  "\x0f": "ctrl+o",
  "\x10": "ctrl+p",
  "\x11": "ctrl+q",
  "\x12": "ctrl+r",
  "\x13": "ctrl+s",
  "\x14": "ctrl+t",
  "\x15": "ctrl+u",
  "\x16": "ctrl+v",
  "\x17": "ctrl+w",
  "\x18": "ctrl+x",
  "\x19": "ctrl+y",
  "\x1a": "ctrl+z",
  "\x7f": "backspace",
  // Ctrl+Shift+Space en terminales que lo mandan como NUL con modificador.
  "\x1b[32;6~": "ctrl+shift+space",
};

const FUNCIONES: Record<string, string> = {
  "\x1bOP": "f1",
  "\x1bOQ": "f2",
  "\x1bOR": "f3",
  "\x1bOS": "f4",
  "\x1b[15~": "f5",
  "\x1b[17~": "f6",
  "\x1b[18~": "f7",
  "\x1b[19~": "f8",
  "\x1b[20~": "f9",
  "\x1b[21~": "f10",
  "\x1b[23~": "f11",
  "\x1b[24~": "f12",
};

/** Traduce el `data` crudo de `handleInput` a un nombre de atajo, si lo conocemos. */
/**
 * Escape, en un solo lugar. Antes cada ventana comparaba con su propio literal: una con el
 * byte real y otra con lo que el editor mostraba en pantalla, y solo una funcionaba.
 */
export const ESC = "\u001b";

export function esEscape(data: string): boolean {
  return data === ESC;
}

export function nombreDeTecla(data: string): TeclaCapturada {
  if (!data) return { nombre: null, legible: "(nada)" };

  const simple = SIMPLES[data] ?? FUNCIONES[data];
  if (simple) return { nombre: simple, legible: simple };

  // Alt+letra llega como ESC + letra.
  const alt = /^\x1b([a-z0-9])$/.exec(data);
  if (alt) return { nombre: `alt+${alt[1]}`, legible: `alt+${alt[1]}` };

  // Letra o dígito suelto: sirve como atajo si el usuario lo quiere configurar.
  if (/^[a-z0-9]$/i.test(data)) return { nombre: data.toLowerCase(), legible: data };

  const hex = [...data].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join(" ");
  return { nombre: null, legible: `bytes [${hex}]` };
}
