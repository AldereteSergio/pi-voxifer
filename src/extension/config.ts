/**
 * config.ts — leer y escribir la config del dictado sin pisar lo que no se toca.
 *
 * Regla: cambiar el motor desde el selector NO puede borrar la key, el dispositivo ni
 * el glosario. Se lee el JSON, se fusiona el parche y se escribe en un temporal que
 * después se renombra: si el proceso muere a mitad, el archivo bueno sigue ahí.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const NOMBRE_EXTENSION = "pi-voxifer";
const NOMBRE_ANTERIOR = "pi-dictado";

export function caminoConfig(): string {
  return join(homedir(), ".pi", "agent", "extensions", NOMBRE_EXTENSION, "config.json");
}

/** El archivo de la versión anterior, si quedó. */
export function caminoConfigAnterior(): string {
  return join(homedir(), ".pi", "agent", "extensions", NOMBRE_ANTERIOR, "config.json");
}

export function caminoDe(nombre: string): string {
  return join(homedir(), ".pi", "agent", "extensions", nombre, "config.json");
}

/**
 * Migra la config vieja al directorio nuevo la primera vez, y devuelve el aviso para
 * decir una sola vez que se movió (el usuario no tiene que reescribir la key a mano).
 */
export function migrarConfigSiHaceFalta(
  nuevo: string = caminoConfig(),
  viejo: string = caminoConfigAnterior(),
): string | undefined {
  // Guarda: si las dos rutas coinciden no hay nada que migrar y copiar sería un no-op
  // silencioso. Pasó de verdad: la constante apuntaba al directorio nuevo.
  if (nuevo === viejo) return undefined;
  if (existsSync(nuevo)) return undefined;
  if (!existsSync(viejo)) return undefined;
  try {
    mkdirSync(dirname(nuevo), { recursive: true });
    copyFileSync(viejo, nuevo);
    return `migré la configuración de ${dirname(viejo)} a ${nuevo}; la vieja quedó donde estaba por las dudas`;
  } catch (e) {
    return `no pude migrar la configuración vieja (${(e as { code?: string })?.code ?? "error"}); revisá ${nuevo}`;
  }
}

/** Techo de espera del proveedor si la config no dice nada. */
export const TIMEOUT_MS_DEFAULT = 60_000;
const TIMEOUT_PISO_MS = 5_000;
const TIMEOUT_TOPE_MS = 10 * 60_000;

/**
 * Timeout efectivo: la config puede moverlo, con piso y tope para que un valor absurdo no
 * deje la grabación esperando media hora ni corte antes de que el modelo termine.
 */
export function timeoutEfectivo(valor: unknown): number {
  if (typeof valor !== "number" || !Number.isFinite(valor) || valor <= 0) return TIMEOUT_MS_DEFAULT;
  return Math.min(Math.max(Math.round(valor), TIMEOUT_PISO_MS), TIMEOUT_TOPE_MS);
}

export interface ConfigLeida {
  cfg: Record<string, unknown>;
  avisos: string[];
}

export function leerConfigArchivo(camino: string = caminoConfig()): ConfigLeida {
  let crudo: string;
  try {
    crudo = readFileSync(camino, "utf8");
  } catch (e) {
    const codigo = (e as { code?: string })?.code;
    if (codigo === "ENOENT") return { cfg: {}, avisos: [] };
    return { cfg: {}, avisos: [`no pude leer ${camino}; uso los defaults`] };
  }
  if (!crudo.trim()) return { cfg: {}, avisos: [`${camino} está vacío; uso los defaults`] };

  try {
    const json = JSON.parse(crudo);
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return { cfg: {}, avisos: [`${camino} no es un objeto JSON; uso los defaults`] };
    }
    return { cfg: json as Record<string, unknown>, avisos: [] };
  } catch {
    return { cfg: {}, avisos: [`${camino} tiene JSON inválido; uso los defaults`] };
  }
}

/** Fusiona de a una clave de primer nivel: `{ motor }` no toca `openrouterApiKey`. */
export function fusionarConfig(
  base: Record<string, unknown>,
  parche: Record<string, unknown>,
): Record<string, unknown> {
  return { ...base, ...parche };
}

export interface ResultadoGuardado {
  ok: boolean;
  aviso?: string;
}

/**
 * Escribe el parche. Devuelve `ok: false` con un aviso en vez de tirar excepción:
 * el selector tiene que poder decir "no pude guardar" sin romper la sesión.
 */
export function guardarConfig(
  parche: Record<string, unknown>,
  camino: string = caminoConfig(),
): ResultadoGuardado {
  const { cfg, avisos } = leerConfigArchivo(camino);
  if (avisos.length) return { ok: false, aviso: avisos[0] };
  if (!Object.keys(parche).length) return { ok: true };

  const fusionada = fusionarConfig(cfg, parche);
  const temporal = `${camino}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(dirname(camino), { recursive: true });
    writeFileSync(temporal, JSON.stringify(fusionada, null, 2) + "\n");
    renameSync(temporal, camino);
    return { ok: true };
  } catch (e) {
    try {
      rmSync(temporal, { force: true });
    } catch {
      /* el temporal se limpia en el próximo intento */
    }
    return { ok: false, aviso: `no pude guardar ${camino}: ${(e as { code?: string })?.code ?? "error"}` };
  }
}

export interface ArgsConfig {
  parche: Record<string, unknown>;
  /** Texto de uso cuando el pedido no se entiende. */
  error?: string;
}

/**
 * `/voxifer-settings motor whisper-turbo` · `/voxifer-settings idioma es` · sin argumentos
 * abre el selector. Devuelve el parche listo para `guardarConfig`.
 */
export function parsearArgsConfig(args: string): ArgsConfig {
  const partes = args.trim().split(/\s+/).filter(Boolean);
  if (!partes.length) return { parche: {} };

  const [clave, ...resto] = partes;
  const valor = resto.join(" ").trim();

  if (clave === "motor" && valor) return { parche: { motor: valor } };
  if (clave === "idioma" && valor) return { parche: { idioma: valor } };
  if (clave === "glosario") {
    return { parche: { glosario: valor ? valor.split(",").map((t) => t.trim()).filter(Boolean) : [] } };
  }

  return {
    parche: {},
    error: "uso: /voxifer-settings [motor <alias> | idioma <es|pt|auto> | glosario a, b] (sin argumentos: selector)",
  };
}
