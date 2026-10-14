// Motor de voz Supertonic que corre dentro del navegador (WebGPU o WASM).
// Adaptado del ejemplo web oficial de Supertonic (licencia MIT, Supertone Inc.):
// https://github.com/supertone-inc/supertonic/tree/main/web
// Los pesos del modelo se descargan desde Hugging Face y tienen licencia OpenRAIL-M.

import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.webgpu.min.mjs';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;

export const MODELOS = {
  v3: {
    nombre: 'Supertonic 3',
    repo: 'supertone-oss-archive/supertonic-3',
    rev: 'aafc6e32416a594460b32413efc49d7fe4ce6d46',
    mb: 398,
  },
  v2: {
    nombre: 'Supertonic 2',
    repo: 'supertone-oss-archive/supertonic-2',
    rev: '7edbcd0bba8cd579100a353a9e0b2b49cad7c875',
    mb: 263,
  },
};

export const VOCES = [
  ['F1', 'Mujer 1'], ['F2', 'Mujer 2'], ['F3', 'Mujer 3'], ['F4', 'Mujer 4'], ['F5', 'Mujer 5'],
  ['M1', 'Hombre 1'], ['M2', 'Hombre 2'], ['M3', 'Hombre 3'], ['M4', 'Hombre 4'], ['M5', 'Hombre 5'],
];

const ARCHIVOS_ONNX = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];
const CACHE = 'lector-modelos-v1';

function urlArchivo(modelo, ruta) {
  return `https://huggingface.co/${modelo.repo}/resolve/${modelo.rev}/${ruta}`;
}

// Descarga con avance y la guarda en el teléfono (Cache Storage) para no repetirla.
// El archivo se escribe al caché en streaming para no tener dos copias en memoria.
async function descargar(url, alAvanzar) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* sin caché (http o modo privado) */ }

  if (cache) {
    const guardado = await cache.match(url);
    if (guardado) {
      const buf = await guardado.arrayBuffer();
      alAvanzar?.(buf.byteLength, true);
      return buf;
    }
  }

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} al descargar ${url.split('/').pop()}`);

  const contador = new TransformStream({
    transform(trozo, ctrl) { alAvanzar?.(trozo.byteLength, false); ctrl.enqueue(trozo); },
  });
  const contado = new Response(resp.body.pipeThrough(contador), {
    headers: { 'content-type': resp.headers.get('content-type') || 'application/octet-stream' },
  });

  if (cache) {
    try {
      await cache.put(url, contado);
      return await (await cache.match(url)).arrayBuffer();
    } catch (e) {
      console.warn('No se pudo guardar en caché; se vuelve a descargar sin guardar', e);
      return await (await fetch(url)).arrayBuffer();
    }
  }
  return await contado.arrayBuffer();
}

export async function estaDescargado(modeloId) {
  try {
    const cache = await caches.open(CACHE);
    const modelo = MODELOS[modeloId];
    for (const nombre of ARCHIVOS_ONNX) {
      if (!(await cache.match(urlArchivo(modelo, `onnx/${nombre}.onnx`)))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function borrarDescargas() {
  try { return await caches.delete(CACHE); } catch { return false; }
}

function gauss() {
  const u1 = Math.max(1e-4, Math.random());
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const IDIOMAS = ['en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es', 'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi', 'na'];

// Misma normalización que el ejemplo oficial: el modelo fue entrenado con ella.
function preprocesar(texto, lang) {
  if (!IDIOMAS.includes(lang)) throw new Error(`Idioma no soportado: ${lang}`);
  let t = texto.normalize('NFKD');
  t = t.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]+/gu, '');
  const reemplazos = {
    '–': '-', '‑': '-', '—': '-', '_': ' ',
    '“': '"', '”': '"', '‘': "'", '’': "'", '´': "'", '`': "'",
    '[': ' ', ']': ' ', '|': ' ', '/': ' ', '#': ' ', '→': ' ', '←': ' ',
  };
  for (const [k, v] of Object.entries(reemplazos)) t = t.replaceAll(k, v);
  t = t.replace(/[♥☆♡©\\]/g, '');
  for (const [k, v] of Object.entries({ '@': ' at ', 'e.g.,': 'for example, ', 'i.e.,': 'that is, ' })) {
    t = t.replaceAll(k, v);
  }
  t = t.replace(/ ,/g, ',').replace(/ \./g, '.').replace(/ !/g, '!').replace(/ \?/g, '?')
    .replace(/ ;/g, ';').replace(/ :/g, ':').replace(/ '/g, "'");
  while (t.includes('""')) t = t.replace('""', '"');
  while (t.includes("''")) t = t.replace("''", "'");
  t = t.replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(t)) t += '.';
  return `<${lang}>${t}</${lang}>`;
}

// Una oración demasiado larga (típica de PDFs mal puntuados) se corta por palabras.
function partirLarga(oracion, max) {
  if (oracion.length <= max) return [oracion];
  const partes = [];
  let actual = '';
  for (const pieza of oracion.split(/\s+/)) {
    if (actual && actual.length + pieza.length + 1 > max) {
      partes.push(actual);
      actual = pieza;
    } else {
      actual = actual ? `${actual} ${pieza}` : pieza;
    }
  }
  if (actual) partes.push(actual);
  return partes;
}

// Corta el texto en trozos de hasta `max` caracteres respetando oraciones y párrafos.
export function trocear(texto, max = 300) {
  const trozos = [];
  const parrafos = texto.trim().split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  const corte = /(?<!\b(?:Mr|Mrs|Ms|Dr|Dra|Prof|Sr|Sra|Srta|Jr|Lic|Ing|etc|vs|Inc|Ltd|Co|Corp|St|Ave|Av|Blvd|pág|núm|aprox)\.)(?<!\b[A-Z]\.)(?<=[.!?])\s+/;
  for (const parrafo of parrafos) {
    let actual = '';
    for (const oracion of parrafo.split(corte).flatMap((o) => partirLarga(o, max))) {
      if (actual && actual.length + oracion.length + 1 > max) {
        trozos.push(actual);
        actual = oracion;
      } else {
        actual = actual ? `${actual} ${oracion}` : oracion;
      }
    }
    if (actual) trozos.push(actual);
  }
  return trozos;
}

export class Supertonic {
  static async cargar(modeloId, { backend = 'auto', alAvanzar } = {}) {
    const modelo = MODELOS[modeloId];
    const totalBytes = modelo.mb * 1e6;
    let bytes = 0;
    const avance = (n, desdeCache) => {
      bytes += n;
      alAvanzar?.({ fase: desdeCache ? 'leyendo' : 'descargando', bytes, totalBytes });
    };

    const cfg = JSON.parse(new TextDecoder().decode(await descargar(urlArchivo(modelo, 'onnx/tts.json'))));
    const indexer = JSON.parse(new TextDecoder().decode(await descargar(urlArchivo(modelo, 'onnx/unicode_indexer.json'))));

    const intentar = async (proveedor) => {
      const sesiones = {};
      for (const nombre of ARCHIVOS_ONNX) {
        const buf = await descargar(urlArchivo(modelo, `onnx/${nombre}.onnx`), avance);
        alAvanzar?.({ fase: 'preparando', bytes, totalBytes, archivo: nombre });
        sesiones[nombre] = await ort.InferenceSession.create(new Uint8Array(buf), {
          executionProviders: [proveedor],
          graphOptimizationLevel: 'all',
        });
      }
      return sesiones;
    };

    let sesiones;
    let usado = backend === 'cpu' ? 'wasm' : 'webgpu';
    if (usado === 'webgpu' && !navigator.gpu) usado = 'wasm';
    try {
      sesiones = await intentar(usado);
    } catch (e) {
      if (usado !== 'webgpu') throw e;
      console.warn('WebGPU falló, se usa WASM', e);
      bytes = 0;
      usado = 'wasm';
      sesiones = await intentar('wasm');
    }

    return new Supertonic(modeloId, cfg, indexer, sesiones, usado);
  }

  constructor(modeloId, cfg, indexer, sesiones, backend) {
    this.modeloId = modeloId;
    this.cfg = cfg;
    this.indexer = indexer;
    this.s = sesiones;
    this.backend = backend;
    this.sampleRate = cfg.ae.sample_rate;
    this.estilos = new Map();
  }

  async estilo(codigo) {
    if (this.estilos.has(codigo)) return this.estilos.get(codigo);
    const modelo = MODELOS[this.modeloId];
    const json = JSON.parse(new TextDecoder().decode(await descargar(urlArchivo(modelo, `voice_styles/${codigo}.json`))));
    const tensor = (x) => new ort.Tensor('float32', Float32Array.from(x.data.flat(Infinity)), x.dims);
    const estilo = { ttl: tensor(json.style_ttl), dp: tensor(json.style_dp) };
    this.estilos.set(codigo, estilo);
    return estilo;
  }

  // Sintetiza un trozo corto (hasta ~300 caracteres). Devuelve PCM mono en Float32.
  async sintetizar(texto, lang, codigoVoz, { pasos = 8, velocidad = 1.05 } = {}) {
    const estilo = await this.estilo(codigoVoz);
    const proc = preprocesar(texto, lang);
    const T = proc.length;
    const ids = new BigInt64Array(T);
    for (let j = 0; j < T; j++) {
      const cp = proc.codePointAt(j);
      ids[j] = BigInt(cp < this.indexer.length ? this.indexer[cp] : -1);
    }
    const textIds = new ort.Tensor('int64', ids, [1, T]);
    const textMask = new ort.Tensor('float32', new Float32Array(T).fill(1), [1, 1, T]);

    const dp = await this.s.duration_predictor.run({ text_ids: textIds, style_dp: estilo.dp, text_mask: textMask });
    const duracion = dp.duration.data[0] / velocidad;
    const te = await this.s.text_encoder.run({ text_ids: textIds, style_ttl: estilo.ttl, text_mask: textMask });

    const trozoMuestras = this.cfg.ae.base_chunk_size * this.cfg.ttl.chunk_compress_factor;
    const largoWav = Math.floor(duracion * this.sampleRate);
    const L = Math.floor((largoWav + trozoMuestras - 1) / trozoMuestras);
    const D = this.cfg.ttl.latent_dim * this.cfg.ttl.chunk_compress_factor;

    let xt = new Float32Array(D * L);
    for (let i = 0; i < xt.length; i++) xt[i] = gauss();
    const latentMask = new ort.Tensor('float32', new Float32Array(L).fill(1), [1, 1, L]);
    const total = new ort.Tensor('float32', new Float32Array([pasos]), [1]);

    for (let paso = 0; paso < pasos; paso++) {
      const out = await this.s.vector_estimator.run({
        noisy_latent: new ort.Tensor('float32', xt, [1, D, L]),
        text_emb: te.text_emb,
        style_ttl: estilo.ttl,
        latent_mask: latentMask,
        text_mask: textMask,
        current_step: new ort.Tensor('float32', new Float32Array([paso]), [1]),
        total_step: total,
      });
      xt = out.denoised_latent.data;
    }

    const voc = await this.s.vocoder.run({ latent: new ort.Tensor('float32', xt, [1, D, L]) });
    const wav = voc.wav_tts.data;
    const pcm = wav.slice(0, Math.min(largoWav, wav.length));
    return { pcm, segundos: pcm.length / this.sampleRate };
  }
}

// WAV PCM 16 bits mono, con un silencio opcional al final.
export function wavBlob(pcm, sampleRate, silencioFinal = 0) {
  const extra = Math.floor(silencioFinal * sampleRate);
  const n = pcm.length + extra;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  const datos = new Int16Array(buf, 44, n);
  for (let i = 0; i < pcm.length; i++) {
    const x = Math.max(-1, Math.min(1, pcm[i]));
    datos[i] = Math.floor(x * 32767);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
