# Lector · Prueba de voces

Página de prueba para un lector en voz alta que funcione igual en el computador y
en el iPhone. Genera la voz dentro del propio dispositivo con el modelo abierto
Supertonic, sin enviar el texto a ningún servidor.

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
