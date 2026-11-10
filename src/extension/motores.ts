/**
 * motores.ts — un motor se describe por la forma de su API, no por su marca.
 *
 * `formato` es el único campo que cambia el código:
 *
 *  - `local`: el modelo corre adentro del proceso de pi (`sherpa-onnx-node`). Sin red, sin
 *    costo y sin servidor; `modelo` es el nombre del paquete a descargar la primera vez.
 *  - `transcriptions`: multipart a `/audio/transcriptions`. No acepta instrucciones: la
 *    literalidad es propiedad del modelo y el idioma va por parámetro.
 *  - `chat-completions`: JSON con bloque `input_audio` a `/chat/completions`. Acepta
 *    prompt y contexto (rioplatense, programador), y a cambio inventa texto cuando el
 *    audio es difícil.
 *
 * Todo lo demás —`baseUrl`, `modelo`, origen de la key, headers extra— es data. Sumar un
 * motor es agregar una entrada de config.
 *
 * Los WER de cada nota están medidos con los audios de Andréy (`work/001/H1.5/` y
 * `work/002/H2.1/`), con transcripción humana escrita por él.
 */

export type Formato = "transcriptions" | "chat-completions" | "local";

/** De dónde sale la credencial: de una variable de entorno o escrita en la config. */
export type OrigenKey =
  | { desde: "entorno"; nombre: string }
  | { desde: "config"; valor: string }
  | { desde: "ninguna" };

export interface Motor {
  alias: string;
  formato: Formato;
  baseUrl: string;
  modelo: string;
  key: OrigenKey;
  nota: string;
  /** Headers extra para este motor. `null` borra uno heredado. */
  headers?: Record<string, string | null>;
}

/** Motores retirados: si una config vieja los pide, se avisa y se sigue con el default. */
export const MOTORES_RETIRADOS: Record<string, string> = {
  mimo: "mimo-v2.6-flash se retiró: medía 63% de WER y era el único motor pago por defecto",
  "opencode-go": "el proveedor OpenCode Go se retiró junto con mimo; usá un ASR compatible",
};

const OPENROUTER = "https://openrouter.ai/api/v1";

/**
 * Catálogo del código. **Regla: entra un motor con su WER medido o no entra.**
 * Los tres existen por un dato distinto (`mai` mejor peor caso, `nemotron` mejor en
 * dictado preparado, `whisper-turbo` el más barato), no por marca. Un cuarto "por si
 * acaso" es cómo el catálogo se pudre: es la misma regla que retiró a mimo (63% WER).
 */
export const MOTORES: readonly Motor[] = [
  {
    alias: "mai",
    formato: "transcriptions",
    baseUrl: OPENROUTER,
    modelo: "microsoft/mai-transcribe-2",
    key: { desde: "entorno", nombre: "PI_DICTADO_API_KEY" },
    nota: "default remoto: mejor peor caso (25% WER en audio espontáneo), el más rápido, ~$0,10/h",
  },
  {
    alias: "nemotron",
    formato: "transcriptions",
    baseUrl: OPENROUTER,
    modelo: "nvidia/nemotron-3.5-transcribe",
    key: { desde: "entorno", nombre: "PI_DICTADO_API_KEY" },
    nota: "el mejor en dictado preparado (5% WER promedio), ~$0,35/h",
  },
  {
    alias: "whisper-turbo",
    formato: "transcriptions",
    baseUrl: OPENROUTER,
    modelo: "openai/whisper-large-v3-turbo",
    key: { desde: "entorno", nombre: "PI_DICTADO_API_KEY" },
    nota: "el más barato de los buenos (~$0,02/h), pero 45% en nombres propios",
  },
];

export const MOTOR_DEFAULT = "mai";

/**
 * Nombre de la variable que usan los motores del catálogo.
 *
 * Una sola para todos: quien dicta contra un solo proveedor no tiene que saber que
 * adentro hay OpenRouter. También se aceptan `OPENROUTER_API_KEY` y la vieja
 * `openrouterApiKey` del config, para no romper configuraciones anteriores.
 */
export const VAR_KEY_UNICA = "PI_DICTADO_API_KEY";

/** Idiomas que se pasan al ASR. `auto` deja que el modelo decida (riesgo: traduce). */
export const IDIOMA_DEFAULT = "es";

/** Tope de motores propios: una lista enorme no se puede elegir desde un selector. */
export const MAX_MOTORES_EXTRA = 20;

export interface MotorResuelto {
  motor: Motor;
  aviso?: string;
}

export interface MotoresExtra {
  motores: Motor[];
  avisos: string[];
}

export function resolverMotor(pedido?: unknown, extra: readonly Motor[] = []): MotorResuelto {
  const disponibles = motoresDisponibles(extra);
  const texto = typeof pedido === "string" ? pedido.trim() : "";
  const porDefecto = disponibles.find((m) => m.alias === MOTOR_DEFAULT) ?? disponibles[0]!;

  if (!texto) return { motor: porDefecto };

  const retirado = MOTORES_RETIRADOS[texto.toLowerCase()];
  if (retirado) return { motor: porDefecto, aviso: retirado };

  // Solo alias exacto o id de modelo exacto. El match por prefijo se sacó: con motores
  // propios en la lista, "m" resolvía a "mai" sin decir nada y la colisión era cuestión
  // de tiempo.
  const encontrado =
    disponibles.find((m) => m.alias === texto.toLowerCase()) ?? disponibles.find((m) => m.modelo === texto);

  if (encontrado) return { motor: encontrado };
  return {
    motor: porDefecto,
    aviso: `motor "${texto}" desconocido; uso ${MOTOR_DEFAULT}. Opciones: ${disponibles.map((m) => m.alias).join(", ")}`,
  };
}

/** Lista efectiva: los del código, con los de la config pisando por alias. */
/** ¿El endpoint es de esta máquina? `localhost`, `127.0.0.1` o `[::1]`. */
export function esHostLocal(baseUrl: string): boolean {
  const host = hostDe(baseUrl);
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function hostDe(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

/**
 * Cabeceras del request: `Authorization` si hay key, y los `headers` del motor encima.
 * `{{session}}` se expande al id de la sesión de pi; `null` borra un header heredado.
 * Con una sola variable es data; si algún día hace falta una segunda, esto pasa a ser un
 * parser y corresponde moverlo a código.
 */
export function cabecerasDeMotor(
  motor: Motor,
  apiKey: string,
  sessionId = "",
): Record<string, string> {
  const base: Record<string, string> = {};
  if (apiKey) base.authorization = `Bearer ${apiKey}`;
  for (const [clave, valor] of Object.entries(motor.headers ?? {})) {
    if (valor === null) {
      for (const existente of Object.keys(base)) {
        if (existente.toLowerCase() === clave.toLowerCase()) delete base[existente];
      }
      continue;
    }
    base[clave] = valor.replaceAll("{{session}}", sessionId);
  }
  return base;
}

export function motoresDisponibles(extra: readonly Motor[] = []): Motor[] {
  const propios = new Map(extra.map((m) => [m.alias, m]));
  const base = MOTORES.map((m) => propios.get(m.alias) ?? m);
  const nuevos = extra.filter((m) => !MOTORES.some((delCodigo) => delCodigo.alias === m.alias));
  return [...base, ...nuevos];
}

/**
 * Motores propios desde la config (`motores: [...]`). Validación estricta con aviso: un
 * motor mal escrito solo se descubre cuando el dictado falla, así que se avisa al cargar.
 */
export function normalizarMotoresExtra(crudo: unknown): MotoresExtra {
  if (crudo === undefined || crudo === null) return { motores: [], avisos: [] };
  if (!Array.isArray(crudo)) return { motores: [], avisos: ["motores debe ser una lista; ignoro la entrada"] };

  const avisos: string[] = [];
  const motores: Motor[] = [];
  const vistos = new Set<string>();

  for (const [indice, entrada] of crudo.entries()) {
    const donde = `motores[${indice}]`;
    if (!entrada || typeof entrada !== "object") {
      avisos.push(`${donde} no es un objeto; ignoro la entrada`);
      continue;
    }
    const obj = entrada as Record<string, unknown>;
    const alias = typeof obj.alias === "string" ? obj.alias.trim().toLowerCase() : "";

    if (!/^[a-z0-9][a-z0-9-]*$/.test(alias)) {
      avisos.push(`${donde} tiene alias inválido (${JSON.stringify(obj.alias)}); uso letras, números y guiones`);
      continue;
    }
    if (obj.formato !== "transcriptions" && obj.formato !== "chat-completions") {
      // `local` no se configura desde acá: los modelos locales y su descarga son del
      // código, porque requieren el binding y un paquete con nombre exacto.
      avisos.push(`${donde} (${alias}): formato debe ser "transcriptions" o "chat-completions" (para local, elegí uno de los modelos que trae la extensión)`);
      continue;
    }
    const baseUrl = typeof obj.baseUrl === "string" ? obj.baseUrl.trim().replace(/\/+$/, "") : "";
    if (!/^https?:\/\//.test(baseUrl)) {
      avisos.push(`${donde} (${alias}): baseUrl tiene que empezar con http:// o https://`);
      continue;
    }
    const modelo = typeof obj.modelo === "string" ? obj.modelo.trim() : "";
    if (!modelo) {
      avisos.push(`${donde} (${alias}): falta modelo`);
      continue;
    }
    const key = normalizarKey(obj.key, alias, avisos, donde);
    if (key === null) continue;
    // Sin key alcanza para un endpoint local; para un host remoto es un 401 garantizado,
    // y un 401 sin explicación manda a buscar el problema al archivo que no es.
    if (key.desde === "ninguna" && !esHostLocal(baseUrl)) {
      avisos.push(
        `${donde} (${alias}): apunta a ${hostDe(baseUrl)} sin credencial; va a fallar con 401. Declarale "key" o usá un endpoint local`,
      );
    }

    if (vistos.has(alias)) {
      avisos.push(`${donde}: alias "${alias}" repetido; uso el primero`);
      continue;
    }
    vistos.add(alias);

    const headers = normalizarHeaders(obj.headers, donde, alias, avisos);
    motores.push({
      alias,
      formato: obj.formato,
      baseUrl,
      modelo,
      key,
      headers,
      nota: typeof obj.nota === "string" && obj.nota.trim() ? obj.nota.trim() : "definido en la config",
    });
  }

  if (motores.length > MAX_MOTORES_EXTRA) {
    avisos.push(`motores: uso los primeros ${MAX_MOTORES_EXTRA} de ${motores.length}`);
  }
  return { motores: motores.slice(0, MAX_MOTORES_EXTRA), avisos };
}

function normalizarKey(crudo: unknown, alias: string, avisos: string[], donde: string): OrigenKey | null {
  if (crudo === undefined || crudo === null) return { desde: "ninguna" };
  if (typeof crudo !== "object") {
    avisos.push(`${donde} (${alias}): key debe ser un objeto { desde: "entorno"|"config", ... }`);
    return null;
  }
  const obj = crudo as Record<string, unknown>;
  if (obj.desde === "entorno") {
    const nombre = typeof obj.nombre === "string" ? obj.nombre.trim() : "";
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(nombre)) {
      avisos.push(`${donde} (${alias}): key.nombre inválido (${JSON.stringify(obj.nombre)})`);
      return null;
    }
    return { desde: "entorno", nombre };
  }
  if (obj.desde === "config") {
    const valor = typeof obj.valor === "string" ? obj.valor.trim() : "";
    if (!valor) {
      avisos.push(`${donde} (${alias}): key.desde "config" sin valor`);
      return null;
    }
    return { desde: "config", valor };
  }
  avisos.push(`${donde} (${alias}): key.desde debe ser "entorno" o "config"`);
  return null;
}

function normalizarHeaders(
  crudo: unknown,
  donde: string,
  alias: string,
  avisos: string[],
): Record<string, string | null> | undefined {
  if (crudo === undefined || crudo === null) return undefined;
  if (typeof crudo !== "object" || Array.isArray(crudo)) {
    avisos.push(`${donde} (${alias}): headers debe ser un objeto`);
    return undefined;
  }
  const salida: Record<string, string | null> = {};
  for (const [clave, valor] of Object.entries(crudo as Record<string, unknown>)) {
    if (valor === null) salida[clave] = null;
    else if (typeof valor === "string") salida[clave] = valor;
    else avisos.push(`${donde} (${alias}): header "${clave}" ignorado (no es texto ni null)`);
  }
  return Object.keys(salida).length ? salida : undefined;
}

/**
 * Normaliza el idioma para el ASR: dos o tres letras ISO-639-1, o `auto`.
 * Cualquier otra cosa cae al default avisando: un idioma mal escrito hace que el modelo
 * transcriba en otro idioma y el usuario no sabría por qué.
 */
export function normalizarIdioma(pedido?: unknown): { idioma: string; aviso?: string } {
  if (pedido !== undefined && pedido !== null && typeof pedido !== "string") {
    return { idioma: IDIOMA_DEFAULT, aviso: `idioma inválido (${JSON.stringify(pedido)}); uso ${IDIOMA_DEFAULT}` };
  }
  const texto = typeof pedido === "string" ? pedido.trim().toLowerCase() : "";
  if (!texto) return { idioma: IDIOMA_DEFAULT };
  if (texto === "auto") return { idioma: "auto" };
  if (/^[a-z]{2,3}$/.test(texto)) return { idioma: texto };
  return {
    idioma: IDIOMA_DEFAULT,
    aviso: `idioma "${String(pedido)}" inválido (usá dos o tres letras, o "auto"); uso ${IDIOMA_DEFAULT}`,
  };
}
