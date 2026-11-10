# Instalación y configuración

`pi-voxifer` es un paquete de pi: se instala, no se copia. Abajo está el porqué de cada paso, y las
dos cosas que se rompen si uno se las salta.

## 1. Dependencias del repo

```bash
cd F:/Programacion/pi-voxifer
npm install
```

Esto baja `decibri` y su addon nativo (`@decibri/decibri-win32-x64-msvc` en Windows, hay equivalentes
para macOS y Linux). No hace falta compilador: son binarios precompilados. Si el `npm install` trae
muchos paquetes —una copia entera de pi entre ellos— es que falta
`peerDependenciesMeta.optional: true` en `package.json`; ver "Lo que se rompe".

## 2. Instalar el paquete en pi

```bash
pi install .
```

Eso escribe la declaración en **`~/.pi/agent/settings.json`** (instalación personal), y a partir de ahí
la extensión carga en cualquier sesión de pi, en cualquier carpeta.

### Por qué no se usa `.pi/settings.json`

Es la primera trampa. Un `.pi/settings.json` con `packages: [".."]` parece el enganche natural —vive en
el repo, viaja con el proyecto— y no sirve por dos razones:

1. **Es *trust-gated*.** Pi sólo lee configuraciones locales después de que el proyecto fue aprobado, y
   en sesiones sin interfaz (subagentes, `pi -p`) no hay prompt de aprobación: la extensión simplemente
   no se carga, sin error visible. Un `/voxifer` que "no existe" en un subagente es esto.
2. **`.pi/` está en `.gitignore`.** Un clone limpio no lo ve. El enganche tiene que estar en el repo
   (este documento) o en los settings personales (el `pi install .`), no en un archivo ignorado.

Para desinstalar: `pi remove .`.

## 3. Uso

```text
f9                   dicta sin escribir el comando (mismo flujo)
/dictar              graba, Enter corta y transcribe, Esc cancela
/dictar --guardar-audio   además deja el WAV en %TEMP%/pi-voxifer
/dictar --calibrar   graba 5 s y muestra los números del VAD (no llama al proveedor)
/voxifer-settings       abre el selector de motor (o: /voxifer-settings motor muse)
```

Con `/voxifer`: aparece una ventana con `● grabando 3,4 s` y una barra de nivel. **Enter** corta y
transcribe; **Esc** cancela. A los 60 s de grabación corta sola. El texto **no se envía**: se pega en el
editor, y vos decidís si lo mandás, lo editás o lo borrás.

Si el micrófono no te escucha, la ventana lo dice a los 1,2 s (`todavía no te escuché`). Y si no hubo
voz suficiente, no se llama al proveedor y no se pega nada: el editor queda como estaba.

## 4. Configuración

Archivo: **`~/.pi/agent/extensions/pi-voxifer/config.json`** (se crea a mano; si no existe, todo va con
defaults).

```json
{
  "device": "Microphone",
  "motor": "mai",
  "idioma": "es",
  "apiKeys": { "OPENROUTER_API_KEY": "sk-or-v1-…" },
  "vad": { "threshold": 0.5, "minSpeechMs": 400, "chunkMs": 100 },
  "motores": [
    {
      "alias": "mi-asr",
      "formato": "transcriptions",
      "baseUrl": "https://proveedor.test/v1",
      "modelo": "proveedor/modelo",
      "key": { "desde": "entorno", "nombre": "MI_ASR_KEY" }
    }
  ]
}
```

| Campo | Para qué | Default |
| --- | --- | --- |
| `device` | índice (`0`), parte del nombre (`"Microphone"`) o `{ "id": "wasapi:{...}" }` | dispositivo por defecto del sistema |
| `motor` | alias del motor activo (los del código o los tuyos) | `mai` |
| `idioma` | dos o tres letras (`es`, `pt`) o `auto`; **sin esto los ASR a veces traducen** | `es` |
| `apiKeys` | credenciales por nombre de variable, para no depender del entorno | — |
| `motores` | motores propios de red: `{ alias, formato, baseUrl, modelo, key, headers? }` (ver abajo) | los del código |
| `vad.threshold` | `vadScore` (0-1) mínimo para contar un chunk como voz | `0.5` |
| `vad.minSpeechMs` | cuánto tiene que sostenerse la voz para no confundir una tos con un dictado | `400` |
| `vad.chunkMs` | duración de cada chunk que entrega el micrófono | `100` |
| `glosario` | nombres y términos que se escriben exactamente así (lista o texto separado por comas) | vacío |
| `atajo` | tecla para dictar sin escribir el comando; se lee al cargar la extensión | `f9` |
| `atajoAlternativo` | segunda tecla, por si el sistema se come la primera | `ctrl+alt+z` |

Un valor inválido **no se corrige en silencio**: cae al default y avisa al ejecutar `/voxifer`. Un umbral
mal escrito que "anda igual" es un bug que aparece meses después.

### El atajo de teclado

`f9` dicta sin escribir `/voxifer`: mismo flujo, misma ventana, misma guardia de "ya estoy grabando". Se
registran **dos** teclas: `f9` y `ctrl+alt+z` (alternativa), porque en la máquina de Andréy `ctrl+space`
no dispara —el IME de Windows se lo come— y `ctrl+shift+d` **cierra el terminal**. `f9` está verificado
ahí; `ctrl+alt+z` queda para quien tenga el IME en otra configuración.

Ninguna capa de arriba puede detectar que el sistema se comió una tecla: `pi.registerShortcut` no valida
ni avisa si el nombre no coincide con lo que llega. Para eso está el diagnóstico:

```text
/dictar-atajo            # qué teclas quedaron registradas
/voxifer-settings → Ver y cambiar atajos   # apretá una tecla y pi dice qué vio; la guarda como atajo
```

Si una combinación no hace nada, `capturar` es la respuesta: si el overlay muestra los bytes de la tecla,
llegó; si no aparece nada, se la comió el sistema antes de pi. También se puede elegir a mano en la
config y recargar la sesión:

```json
{ "atajo": "f9", "atajoAlternativo": "ctrl+alt+z" }
```

El atajo se registra al cargar la extensión, así que un cambio necesita `/reload` o sesión nueva.

### Micrófonos en Linux y WSL

`decibri` usa ALSA a través de cpal, y cpal enumera **todos los alias de ALSA** de cada placa. Los
nombres útiles para dictar son `default`, `pulse`, `pipewire`, `alsa_input.*` (PipeWire) o
`sysdefault:CARD=…`; el resto (`front:`, `hw:`, `plughw:`, `iec958:`…) son perfiles de hardware.

Para encontrarlos: `arecord -l` (paquete `alsa-utils`) muestra las placas de captura, y
`pactl list short sources` las fuentes si hay PipeWire o PulseAudio. Se pone la parte distintiva en
`PI_VOXIFER_DEVICE`, por ejemplo `"pulse"` o `"alsa_input"`.

**WSL no tiene micrófono propio.** Si el sistema no tiene audio, la enumeración no devuelve una lista
vacía: ALSA tira `Cannot find card '0'` y `Unknown PCM default`. La extensión lo detecta y lo dice con
ese nombre, en vez de contestar "la grabación falló". Para dictar desde WSL hace falta WSLg (Windows 11)
o un servidor PulseAudio en Windows; si no, conviene usar pi instalado en Windows.

### La credencial

Los motores del catálogo usan **una sola variable** para todos los proveedores:

```bash
export PI_DICTADO_API_KEY=sk-…
```

Es la misma para OpenRouter, para OpenAI o para el proveedor que sea —la clave la define el
`baseUrl` del motor, no el nombre de la variable—. También se puede poner en el config:

```json
{ "apiKeys": { "PI_DICTADO_API_KEY": "sk-…" } }
```

Siguen funcionando, por compatibilidad, `OPENROUTER_API_KEY` en el entorno y el viejo
`"openrouterApiKey"` del config. Un motor propio puede declarar su propia variable si necesita una
credencial distinta (`"key": { "desde": "entorno", "nombre": "MI_PROVEEDOR_KEY" }`).

### Cambiar de motor sin editar el JSON

```text
/voxifer-settings                       # selector: te muestra los motores con su costo y su peor caso
/voxifer-settings motor whisper-turbo    # directo, sin selector
/voxifer-settings idioma pt
/voxifer-settings glosario Vika, Viktor, pi
```

El selector **solo escribe la clave que cambia**: la key, el dispositivo, el VAD y el glosario quedan
como estaban. La escritura es atómica (archivo temporal + rename), así que un corte de luz a mitad no
deja la config vacía.

### Motores: locales y remotos

Un motor es una descripción de **la forma de su API**, no una marca. Hay dos formatos de red y uno local:

| Formato | Cómo transcribe | Acepta prompt |
| --- | --- | --- |
| `local` (`parakeet`, `whisper-small`, `whisper-base`) | adentro del proceso de pi, con `sherpa-onnx-node` | **no** |
| `transcriptions` (`mai`, `nemotron`, `whisper-turbo`) | `/audio/transcriptions`, sin instrucciones | **no** |
| `chat-completions` | `/chat/completions`, con prompt y contexto | sí |

**El default es `whisper-base`**: 28% de WER, 1,2 s por audio de doce segundos y **198 MB** de descarga
la primera vez. No es el más preciso, es el más barato de entrada: quien nunca configuró nada no puede
recibir 652 MB de sorpresa en el primer dictado. `parakeet` es la elección explícita para quien dicta en
serio — **10% de WER y 0,65 s**, a cambio de 652 MB.

Los modelos se sirven desde los releases de `sherpa-onnx` y quedan en `~/.pi/models/<alias>/`. Después
de la primera descarga, la carga es de ~0,7-2,4 s según el modelo, y **a los 30 minutos sin dictar el
modelo se libera**. Ojo con lo que eso significa: deja de estar cargado y de consumir CPU, pero **la RAM
puede no volver al sistema** hasta que el proceso la recicle. Si dictás después de ese lapso, el modelo
se vuelve a cargar y ese dictado tarda un poco más.

Los motores locales no se configuran: vienen con la extensión. Si el binding nativo no tiene binario
para tu plataforma, el motor local simplemente no aparece, se avisa qué plataforma falta y el dictado
sigue con los remotos.

### Motores: dos tipos, dos caminos

El selector de `/voxifer-settings` muestra la lista corta y cuál está activo (`*`), y marca con `+` los
motores que definiste en tu config. Son dos tipos distintos y conviene saberlo antes de elegir:

| Tipo | Cómo transcribe | Acepta prompt | Medido (5 audios reales) |
| --- | --- | --- | --- |
| `asr` (`mai`, `whisper-turbo`, `muse`, `qwen`) | `/audio/transcriptions`, sin instrucciones | **no** | 20%-36% WER |
| `llm-audio` (`mimo`) | `/chat/completions`, con prompt y contexto | sí | **63% WER** |

Además se pueden **definir motores propios** y elegirlos igual que los del código. Un motor es una
descripción de la forma de su API, no una marca:

| Campo | Qué es |
| --- | --- |
| `formato` | `transcriptions` (multipart a `/audio/transcriptions`) o `chat-completions` (JSON con audio, acepta prompt) |
| `baseUrl` | la raíz del endpoint, sin `/audio/transcriptions` ni `/chat/completions` |
| `modelo` | el id que espera el proveedor |
| `key` | `{ "desde": "entorno", "nombre": "MI_KEY" }` o `{ "desde": "config", "valor": "…" }`; sin key para endpoints locales |
| `headers` | opcional; `"{{session}}"` se expande al id de la sesión de pi, y `null` borra un header heredado |

Un motor propio con el mismo alias pisa al del código; uno mal escrito (formato desconocido, `baseUrl`
sin `http`, alias con espacios, modelo vacío, `key` inválida) **se rechaza avisando** al ejecutar
`/voxifer` y no entra a la lista. Volver atrás es cambiar el alias en `motor` — o `/voxifer-settings`.

`mimo` y el proveedor OpenCode Go **se retiraron**: medían 63% de WER. Si una config los pide, la
extensión avisa y usa el default.

El default es `mai` (`microsoft/mai-transcribe-2`): el mejor peor caso de la medición (25%), el más
rápido (1,2 s) y ~$0,10/hora. `whisper-turbo` es la opción barata (~$0,02/h) con un peor caso flojísimo
en nombres propios; `muse` es el más preciso y el más caro; `mimo` queda como vuelta atrás al camino con
prompt.

**Lo que se gana y lo que se pierde con un ASR:** se gana ~40 puntos de WER. Se pierde el prompt: un ASR
no recibe instrucciones, así que la literalidad deja de ser algo que controlamos por instrucción y pasa
a ser una propiedad del modelo que solo se puede medir (por eso están los audios de referencia en
`work/001/H1.5/`). El glosario tampoco se le puede pasar: aplicarlo requiere un reemplazo posterior, que
**no está implementado** y tiene una limitación conocida — si decís "pibe" de verdad, un reemplazo de
"pi" lo rompería.

Con cualquier motor, el audio **se recorta en los bordes** antes de mandarse: los motores de la familia
Whisper rellenan el silencio inicial con "¡Gracias!", y el recorte lo evita además de ahorrar unos
centavos. El VAD sigue decidiendo si hubo voz; el recorte solo limpia el borde.

### El glosario, y por qué no es magia

El modelo falla en palabras sueltas por **decodificación fonética**: "decibeles" vuelve como "devibeles"
y "visuales" como "ivaules". Eso no se arregla con instrucciones, porque no es desobediencia: es que
oyó mal. Pero los nombres propios son otro caso: si el audio suena a "Vika" y el modelo no tiene ese
nombre en ningún lado, escribe "vica" y no hay forma de que acierte.

Para eso está el glosario: una línea que se agrega al prompt **sólo si hay términos**, con un techo de
40 términos y 400 caracteres para no inflar la llamada (~30 tokens con cuatro nombres). Con la lista
vacía el prompt es exactamente el de v0.1.0, así que encenderlo o apagarlo es una variable que se puede
medir, no un cambio silencioso.

Qué poner: nombres que dictás seguido y que el modelo no puede adivinar —`Vika`, `Viktor`, `pi`,
`OpenCode`, `Gaeskel`, el nombre de tu proyecto—. Qué NO poner: palabras comunes ni términos que ya
salieron bien; cada agregado que no corrige nada es prompt que se paga en cada dictado.

La medición de si el glosario mejora las cosas está en el issue #5: mismo audio, con y sin lista,
contando aciertos en esos nombres.

### Variables de entorno

| Variable | Para qué |
| --- | --- |
| `PI_VOXIFER_DEVICE` | pisa `device` de la config (útil para probar dos micrófonos sin editar el JSON) |
| `OPENCODE_API_KEY` | credencial de respaldo si `pi` no tiene la de `opencode-go` |

La credencial normal no se configura acá: se toma de `ctx.modelRegistry.getProviderAuth("opencode-go")`,
o sea la misma que ya usa pi para hablar con ese proveedor. Si cambiás de plan o de proveedor en pi, la
extensión se entera sola.

## 5. Calibrar el umbral con tu voz y tu micrófono

El umbral `0.5` está medido contra dos extremos (voz por archivo: `vadScore` 1,000; micrófono en
silencio: 0,021) pero **falta el cuadrante que importa: tu voz entrando por tu micrófono**. Por eso:

```text
/dictar --calibrar
```

Graba 5 s —no llama al proveedor, no pega nada— y devuelve algo así:

```text
calibración: 5.0 s capturados, pico 18432/32767, vadScore máx 0.998,
48 chunks sobre 0.5 (hacen falta 4). Con estos números el dictado funcionaría.
```

Cómo leerlo, y esto es lo que más se consulta:

- **pico** (nivel de entrada, 0-32767): el reporte lo diagnostica solo.
  - **menos de 300**: casi no llega señal. Micrófono mudo, tapado o es otro dispositivo.
  - **entre 300 y 2.500**: nivel bajo. Subí el volumen en Windows › Sonido › Entrada. Medido con
    Andréy: **524** en voz normal, o sea −36 dBFS — el VAD lo escuchaba perfecto y el nivel era
    malísimo, que es exactamente el caso donde uno busca el problema en el umbral y está en el volumen.
  - **2.500 o más**: nivel correcto.
- **vadScore máx**: si está por debajo de `threshold`, subí el volumen o bajá el umbral.
- **chunks sobre el umbral**: si el dictado dice "no escuché voz" pero el pico es alto, bajá
  `vad.threshold` a 0,3 y probá de nuevo.

El veredicto final solo dice "el dictado funciona" cuando **las dos cosas** están bien: VAD que te
escucha y nivel de entrada suficiente. Un "funcionaría" con pico 524 sería un reporte que miente.

El número que salga de la calibración real de Andréy queda escrito **en este archivo**, en la sección
"Medición de referencia", y se repite la calibración si cambia el micrófono, el lugar o el volumen del
sistema. Es el cierre del issue #4.

### Medición de referencia

Micrófono de Andréy, 08-nov-2026, voz normal a distancia habitual:

| Medición | Valor |
| --- | --- |
| Duración capturada | 4,7 s |
| Pico de entrada | **524**/32767 (−36 dBFS) |
| `vadScore` máximo | 1,000 |
| Chunks sobre el umbral 0,5 | 16 (hacen falta 4) |
| Veredicto del reporte | VAD correcto, **nivel de entrada bajo** |

O sea: el umbral 0,5 no es el problema de este micrófono; el volumen de entrada sí.

**Después de subir la ganancia del micrófono**, misma voz, misma distancia:

| Medición | Valor | Lectura |
| --- | --- | --- |
| Intento con exceso de ganancia | 32.767/32767 | **saturación**: el convertidor topó. Peor que bajo: distorsiona y el modelo reconoce peor |
| Ajuste final | **6.531**/32767 | zona sana; `vadScore` 1,000 y 43 de 48 chunks sobre el umbral |
| Veredicto del reporte | "Con estos números el dictado funciona" | el único caso en que el reporte es optimista |

Los tres números juntos son la lección de la sección: bajo se arregla subiendo, saturado se arregla
bajando, y el reporte distingue los dos desde que separa VAD de nivel de entrada. Queda pendiente
—para el cierre del issue #4— la calidad del texto transcripto con esta señal, que se evalúa pegando la
frase dicha y la transcripción devuelta.

## 6. Tests

```bash
npm test          # 105 tests, sin red y sin micrófono
npm run typecheck # tsc --noEmit, strict
npm run smoke     # contra el proveedor real del motor por defecto (~$0,0003, 2-10 s)
npm run smoke -- --motor=mimo   # el mismo smoke contra el camino con prompt
```

El smoke es el único que detecta que el proveedor dejó de transcribir de verdad, y la señal depende del
tipo de motor: en el camino con prompt manda dos veces la misma petición (sin y con audio) y exige que
los `prompt_tokens` crezcan al menos 40; en el camino ASR exige que la transcripción contenga una palabra
conocida del fixture y que el proveedor informe `usage.seconds` > 0. Se corre a mano antes de
un release y cada vez que se toque el motor. Necesita credencial (`OPENCODE_API_KEY` o
`~/.pi/agent/auth.json`); si no la encuentra, sale con código 2.

## Lo que se rompe (y cómo se ve)

| Síntoma | Causa | Solución |
| --- | --- | --- |
| `/voxifer` no existe | el paquete no está instalado en los settings **personales** | `pi install .` desde el repo |
| `/voxifer` no existe **solo** en subagentes o en `-p` | enganche por `.pi/settings.json`, que es trust-gated | instalar personal, ver arriba |
| `npm install` baja cientos de paquetes | falta `peerDependenciesMeta.optional: true` | no listar pi en `dependencies` |
| "no encontré micrófono" | `inputDevices()` no devolvió ninguno | revisar la entrada de audio del sistema |
| **"no hay dispositivo de audio en WSL"** | WSL no tiene micrófono propio; ALSA tira `cannot find card '0'` / `Unknown PCM default` | usar WSLg (Windows 11) o un PulseAudio de Windows; si no, dictar desde pi en Windows |
| **"no encontré ningún dispositivo de audio" en Linux** | no hay placa o no hay servidor de sonido visible | `arecord -l` o `pactl list short sources`, y `PI_VOXIFER_DEVICE` con la parte distintiva (`pulse`, `alsa_input`) |
| "el micrófono configurado no existe" | `device` no coincide | el mensaje lista los disponibles |
| "no encontré credencial de opencode-go" | la credencial de pi no está, o el host cambió la forma de `AuthResult` | re-loguear en pi; `echo $OPENCODE_API_KEY` como respaldo |
| **transcribe mal, corta palabras o se pierde frases** | **nivel de entrada bajo** (el problema más común) | `/dictar --calibrar`: si el pico es menor a 2.500, subí el volumen del micrófono |
| "no escuché voz" con voz alta | umbral demasiado alto para ese micrófono | `/dictar --calibrar` y ajustar `vad.threshold` |
| "el proveedor tardó demasiado (60 s)" | latencia del proveedor (medida: 1,3 a 27 s) | repetir; si es constante, plan B: OpenRouter |
| "el proveedor respondió con error (401 …)" | credencial vencida o sin saldo en el proveedor del motor | re-loguear en pi (mimo) o revisar `openrouterApiKey` (ASR) |
| **la transcripción vuelve en inglés** | el ASR no recibió `idioma`, o está en `auto` | poné `"idioma": "es"` en la config |
| aparece un "¡Gracias!" o "Thank you" al principio | silencio inicial (el recorte ya lo evita; si pasa, el audio arranca con ruido) | revisar nivel de entrada, `/dictar --calibrar` |
| "el proveedor respondió con error (400 MissingSessionID …)" | el header `x-opencode-session` no llegó | bug nuestro: revisar el request, no la config |
| "la transcripción vino vacía" | el modelo no devolvió texto en ningún campo | repetir; si insiste, correr `npm run smoke` |

### Otro proveedor, misma puerta (ejemplo: DeepInfra)

Cualquier endpoint compatible con OpenAI sirve agregándolo como motor propio. Verificado el 2026-11-10
con `Qwen/Qwen3-ASR-0.6B` en DeepInfra: **11% de WER** en el corpus dictado, 2-4 s por audio de 12 s.

```json
"motores": [
  {
    "alias": "deepinfra-qwen",
    "formato": "transcriptions",
    "baseUrl": "https://api.deepinfra.com/v1/openai",
    "modelo": "Qwen/Qwen3-ASR-0.6B",
    "key": { "desde": "config", "valor": "sk-di-…" },
    "nota": "DeepInfra: Qwen3-ASR 0.6B, 11% WER"
  }
]
```

La key escrita en `key.valor` (o en `apiKeys`) queda **en texto plano** dentro de
`config.json`, que es un archivo común del usuario: sirve para una máquina propia, no para
una compartida. La alternativa es `{ "desde": "entorno", "nombre": "MI_VAR" }` y exportar la
variable en la shell.

`baseUrl` va **sin** `/audio/transcriptions` al final: la extensión agrega la ruta según el `formato`.
El campo `key` acepta `{ "desde": "config", "valor": "…" }` o `{ "desde": "entorno", "nombre": "MI_KEY" }`.
