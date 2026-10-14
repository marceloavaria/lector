# Lector

Lector en voz alta que funciona igual en el computador y en el iPhone. Genera la
voz dentro del propio dispositivo con el modelo abierto Supertonic, sin enviar el
texto a ningún servidor.

- **App** (`app/`): importa PDF, EPUB y texto pegado; biblioteca guardada en el
  dispositivo; lectura con la oración resaltada; retoma donde quedaste; funciona
  sin conexión una vez abierta.
- **Prueba de voces** (raíz): compara voces y mide si el audio sigue con otra app
  en pantalla.

## Prueba de voces

Mide tres cosas:

1. Qué voz suena mejor en español e inglés.
2. A qué velocidad la genera cada dispositivo.
3. Si el audio sigue sonando con otra app en pantalla (Waze) o con el teléfono
   bloqueado, y si la generación avanza mientras tanto.

## Cómo correrla localmente

```bash
python3 -m http.server 8765 --directory .
```

Luego abre http://localhost:8765.

## Créditos y licencias

- Motor de voz adaptado del ejemplo web de
  [Supertonic](https://github.com/supertone-inc/supertonic) (código MIT,
  Supertone Inc.).
- Los pesos del modelo se descargan desde
  [Hugging Face](https://huggingface.co/supertone-oss-archive) y tienen licencia
  OpenRAIL-M. No se redistribuyen en este repositorio.
- Inferencia con [ONNX Runtime Web](https://github.com/microsoft/onnxruntime)
  (MIT), cargado desde jsDelivr.
- Versión int8 de Supertonic 3 publicada por
  [csukuangfj2](https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11)
  (sherpa-onnx).
- PDF con [pdf.js](https://github.com/mozilla/pdf.js) (Apache 2.0) y EPUB con
  [JSZip](https://github.com/Stuk/jszip) (MIT), ambos desde jsDelivr.
