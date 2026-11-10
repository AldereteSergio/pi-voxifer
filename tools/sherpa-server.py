#!/usr/bin/env python
"""
sherpa-server.py — envoltorio OpenAI-compatible para sherpa-onnx.

Por qué existe: sherpa-onnx transcribe rápido y bien (Parakeet TDT 0.6B v3: 10% WER,
0,5-0,8 s por audio de 12 s) pero **no habla el protocolo que usa la extensión**. Este
servidor expone `POST /audio/transcriptions` con multipart `file`, o sea el mismo
contrato que Open WebUI y que OpenRouter, así que pi-dictado lo consume con una
`baseUrl` y sin código nuevo.

Uso:
  pip install sherpa-onnx numpy
  python tools/sherpa-server.py --puerto 8123       --modelo parakeet=parakeet:<dir>       --modelo moonshine=moonshine_v2:<dir>

Los modelos se cargan al recibir el primer request de cada uno (carga perezosa), y se
elige por el campo `model` del multipart — igual que hace OpenAI. Sin `model`, va el
primero de la lista.

Y en la config de pi-dictado, una entrada por modelo contra el mismo puerto:
  { "alias": "parakeet", "formato": "transcriptions",
    "baseUrl": "http://127.0.0.1:8123", "modelo": "parakeet" }
  { "alias": "moonshine", "formato": "transcriptions",
    "baseUrl": "http://127.0.0.1:8123", "modelo": "moonshine" }

Sin dependencias de framework: http.server + cgi.FieldStorage (Python 3.11). Es una
herramienta de medición y uso local, no un servicio de producción.
"""

import argparse
import cgi
import io
import json
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx


def cargar_modelo(directorio, tipo):
    if tipo == "whisper":
        # Paquete `sherpa-onnx-whisper-*`: encoder/decoder + tokens. Usa los int8 si están,
        # que son la mitad de peso y en CPU casi no cambian la transcripción.
        import os
        enc_i8 = f"{directorio}/encoder.int8.onnx"
        dec_i8 = f"{directorio}/decoder.int8.onnx"
        if os.path.exists(enc_i8) and os.path.exists(dec_i8):
            enc, dec = enc_i8, dec_i8
        else:
            candidatos = [n for n in os.listdir(directorio) if n.endswith("-encoder.int8.onnx")]
            enc = f"{directorio}/{candidatos[0]}" if candidatos else f"{directorio}/encoder.onnx"
            dec = enc.replace("encoder", "decoder")
        tokens = next(
            f"{directorio}/{n}" for n in os.listdir(directorio) if n.endswith("-tokens.txt") or n == "tokens.txt"
        )
        return sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=enc, decoder=dec, tokens=tokens, language="es", task="transcribe", num_threads=4,
        )
    if tipo == "moonshine_v2":
        return sherpa_onnx.OfflineRecognizer.from_moonshine_v2(
            encoder=f"{directorio}/encoder_model.ort",
            decoder=f"{directorio}/decoder_model_merged.ort",
            tokens=f"{directorio}/tokens.txt",
            num_threads=4,
        )
    if tipo == "canary":
        return sherpa_onnx.OfflineRecognizer.from_nemo_canary(
            encoder=f"{directorio}/encoder.int8.onnx",
            decoder=f"{directorio}/decoder.int8.onnx",
            tokens=f"{directorio}/tokens.txt",
            src_lang="es",
            tgt_lang="es",
            num_threads=4,
            feature_dim=128,
        )
    if tipo == "parakeet":
        return sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=f"{directorio}/encoder.int8.onnx",
            decoder=f"{directorio}/decoder.int8.onnx",
            joiner=f"{directorio}/joiner.int8.onnx",
            tokens=f"{directorio}/tokens.txt",
            num_threads=4,
            decoding_method="greedy_search",
            # Sin esto, NeMo falla con "'vocab_size' does not exist in the metadata".
            model_type="nemo_transducer",
        )
    raise SystemExit(f"tipo de modelo no soportado: {tipo}")


def leer_wav(datos):
    """WAV 16-bit mono → float32 normalizado. Rechaza lo que no sea eso, explícito."""
    with wave.open(io.BytesIO(datos), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1:
            raise ValueError("esperaba WAV 16-bit mono")
        rate = w.getframerate()
        crudo = w.readframes(w.getnframes())
    return np.frombuffer(crudo, dtype=np.int16).astype("float32") / 32768.0, rate


class Handler(BaseHTTPRequestHandler):
    # alias → (directorio, tipo); el recognizer se construye al primer uso.
    modelos = {}
    cargados = {}
    por_defecto = ""

    def _json(self, codigo, cuerpo):
        datos = json.dumps(cuerpo, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(datos)))
        self.end_headers()
        self.wfile.write(datos)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            self._json(200, {"ok": True, "modelos": sorted(self.modelos), "cargados": sorted(self.cargados)})
            return
        self._json(404, {"error": "no encontrado"})

    def do_POST(self):
        if not self.path.startswith("/audio/transcriptions"):
            self._json(404, {"error": "no encontrado"})
            return

        largo = int(self.headers.get("Content-Length") or 0)
        if largo <= 0:
            self._json(400, {"error": "falta el cuerpo multipart"})
            return

        entorno = {"REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers.get("Content-Type", ""),
                   "CONTENT_LENGTH": str(largo)}
        forma = cgi.FieldStorage(fp=self.rfile, headers=self.headers, environ=entorno)
        archivo = forma["file"] if "file" in forma else None
        if archivo is None or not getattr(archivo, "file", None):
            self._json(400, {"error": "falta el campo 'file'"})
            return

        alias = forma.getfirst("model") or self.por_defecto
        if alias not in self.modelos:
            self._json(400, {"error": f"modelo desconocido: {alias}", "disponibles": sorted(self.modelos)})
            return

        try:
            muestras, rate = leer_wav(archivo.file.read())
        except Exception as e:  # noqa: BLE001 — el mensaje va al cliente, no al log
            self._json(400, {"error": f"audio inválido: {e}"})
            return

        try:
            if alias not in Handler.cargados:
                directorio, tipo = Handler.modelos[alias]
                Handler.cargados[alias] = cargar_modelo(directorio, tipo)
            recognizer = Handler.cargados[alias]
        except Exception as e:  # noqa: BLE001
            self._json(500, {"error": f"no pude cargar {alias}: {e}"})
            return

        inicio = time.time()
        flujo = recognizer.create_stream()
        flujo.accept_waveform(rate, muestras)
        recognizer.decode_stream(flujo)
        ms = int((time.time() - inicio) * 1000)

        self._json(200, {
            "text": flujo.result.text.strip(),
            "model": alias,
            "usage": {"seconds": round(len(muestras) / rate, 3), "latency_ms": ms},
        })

    def log_message(self, formato, *args):  # silencio: el request ya devuelve latencia
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--modelo",
        action="append",
        required=True,
        metavar="ALIAS=TIPO:DIRECTORIO",
        help="p. ej. parakeet=parakeet:C:/modelos/parakeet",
    )
    parser.add_argument("--puerto", type=int, default=8123)
    args = parser.parse_args()

    for entrada in args.modelo:
        alias, resto = entrada.split("=", 1)
        tipo, directorio = resto.split(":", 1)
        Handler.modelos[alias.strip()] = (directorio.strip(), tipo.strip())
    Handler.por_defecto = next(iter(Handler.modelos))

    print(f"modelos: {', '.join(sorted(Handler.modelos))} (default: {Handler.por_defecto})", flush=True)
    print(f"escuchando en http://127.0.0.1:{args.puerto} · carga perezosa por modelo", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.puerto), Handler).serve_forever()


if __name__ == "__main__":
    main()
