<img src="assets/voxifer-banner.webp" alt="VOXIFER — dictado por voz para pi" width="100%">

# pi-voxifer

Dictado por voz para [pi](https://github.com/badlogic/pi-mono): hablás, se transcribe y el texto cae en
el editor. **No se envía**: vos decidís si lo mandás, lo editás o lo borrás.

```
Micrófono → decibri (PCM 16 kHz + VAD) → motor → transcripción → ctx.ui.pasteToEditor()
```

## Cómo funciona

Hay dos clases de motor y se eligen en `/voxifer-settings`:

- **Local, adentro de pi.** Corre con `sherpa-onnx-node`, sin servidor, sin Python y sin que el audio
  salga de tu máquina. El modelo se descarga la primera vez y se carga en el primer dictado; a los 30
  minutos sin usar se libera.
- **Remoto, compatible con OpenAI.** Cualquier endpoint que hable `/audio/transcriptions` o
  `/chat/completions` con audio sirve: se describe con `formato`, `baseUrl`, `modelo` y de dónde sale
  la key. Sumar un proveedor es editar la config, no el código.

Medido con audio real dictado a propósito (seis audios, un eje cada uno: nombres propios, jerga
técnica, voseo, números, frases largas y autocorrección):

| motor | dónde | WER | latencia por audio de 12 s |
| --- | --- | --- | --- |
| `parakeet` | local | **10%** | 0,65 s |
| `qwen3-asr-0.6b` | remoto | 11% | 2-4 s |
| `whisper-small` | local | 13% | ~8 s |
| `whisper-base` | local | 28% | 1,4 s |

El default es **`parakeet`**. Pesa 652 MB de descarga; si preferís algo más liviano, `whisper-base`
son 198 MB y 28% de error.

## Instalación

```bash
git clone https://github.com/AldereteSergio/pi-voxifer.git
cd pi-voxifer
npm install
pi install .
```

Requiere Node 20 o más. Las dependencias nativas (`decibri` para el micrófono y `sherpa-onnx-node`
para el motor local) traen binarios para Windows x64, Linux x64/arm64 y macOS arm64 — no compila nada.

En Windows, si `npm install` falla por el binding, la extensión igual arranca: el motor local no
aparece, se avisa y el dictado sigue con los remotos.

## Uso

```text
f9                    dicta sin escribir el comando (ctrl+alt+z también)
/voxifer              graba; Enter corta y transcribe, Esc cancela
/voxifer-settings     modelo · atajos · credencial · idioma · dataset · largo de grabación
```

Con `f9` aparece una ventana en el área del editor: una línea de estado, la onda que se mueve con tu
voz y una ayuda. Al cortar, el texto se pega en el editor y nada más.

## Configuración

Vive en `~/.pi/agent/extensions/pi-voxifer/config.json` y se toca desde `/voxifer-settings` o a mano:

```json
{
  "motor": "parakeet",
  "idioma": "es",
  "apiKeys": { "PI_DICTADO_API_KEY": "sk-…" },
  "maxGrabacionMs": 60000,
  "guardarAudios": false,
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
}
```

`baseUrl` va **sin** `/audio/transcriptions` al final: la ruta la arma la extensión según el `formato`.
La credencial de los motores del catálogo sale de `PI_DICTADO_API_KEY`, una sola variable para
cualquier proveedor.

### Dataset para finetuning

`guardarAudios: true` guarda cada dictado en `~/.pi/agent/extensions/pi-voxifer/dataset/`: el WAV y un
`.json` con la transcripción automática y `"revisado": false`. El audio no se puede regenerar; el texto
automático es un punto de partida que conviene corregir antes de usarlo como verdad.

## Documentación

- [`docs/instalacion.md`](docs/instalacion.md) — instalación a fondo, configuración, dataset,
  micrófonos en Windows y Linux, y qué hacer cuando algo falla.

## Desarrollo

```bash
npm test          # tests sin red ni micrófono
npm run typecheck
npm run smoke                 # contra el proveedor real del motor por defecto
npm run smoke -- --motor=…    # contra el motor que elijas
```

`tools/sherpa-server.py` es un envoltorio opcional que expone cualquier modelo de `sherpa-onnx` por
HTTP compatible con OpenAI; sirve para medir motores sin instalarlos en la extensión.

## Licencia

MIT.
