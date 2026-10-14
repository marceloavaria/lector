// Limpieza del texto y división en oraciones. Cada oración es la unidad que se
// genera, se resalta y se guarda como posición para retomar.

// Supertonic acepta hasta ~300 caracteres por llamada; dejamos margen.
const MAX_ORACION = 280;
const MIN_ORACION = 12;

const ABREVIATURAS = /(?:^|\s)(?:Sr|Sra|Srta|Sres|Dr|Dra|Lic|Ing|Prof|Arq|Mr|Mrs|Ms|St|Av|Avda|pág|págs|p|pp|núm|n|vol|cap|fig|etc|aprox|cía|Cía|Ltda|Inc|Ltd|Co|vs|e\.g|i\.e|a\.C|d\.C|EE\.UU|ej)\.$/i;

export function limpiarEspacios(t) {
  return t.replace(/­/g, '').replace(/[ \t ]+/g, ' ').trim();
}

// Une las oraciones que Intl.Segmenter corta mal tras una abreviatura o una inicial.
function unirAbreviaturas(partes) {
  const out = [];
  for (const p of partes) {
    const previa = out.at(-1);
    if (previa && (ABREVIATURAS.test(previa) || /(?:^|\s)[A-ZÁÉÍÓÚÑ]\.$/.test(previa) || /\d\.$/.test(previa) && /^\d/.test(p))) {
      out[out.length - 1] = `${previa} ${p}`;
    } else {
      out.push(p);
    }
  }
  return out;
}

// Corta una oración larga en comas, punto y coma o dos puntos; si no alcanza, por palabras.
function partirLarga(oracion) {
  if (oracion.length <= MAX_ORACION) return [oracion];
  const piezas = oracion.split(/(?<=[,;:])\s+/);
  const out = [];
  let actual = '';
  const empujar = (pieza) => {
    if (actual && actual.length + pieza.length + 1 > MAX_ORACION) {
      out.push(actual);
      actual = pieza;
    } else {
      actual = actual ? `${actual} ${pieza}` : pieza;
    }
  };
  for (const pieza of piezas) {
    if (pieza.length > MAX_ORACION) pieza.split(/\s+/).forEach(empujar);
    else empujar(pieza);
  }
  if (actual) out.push(actual);
  return out;
}

const segmentadores = new Map();
function segmentador(idioma) {
  if (!segmentadores.has(idioma)) {
    segmentadores.set(idioma, 'Segmenter' in Intl ? new Intl.Segmenter(idioma, { granularity: 'sentence' }) : null);
  }
  return segmentadores.get(idioma);
}

export function dividirOraciones(parrafo, idioma = 'es') {
  const seg = segmentador(idioma);
  let partes = seg
    ? [...seg.segment(parrafo)].map((s) => s.segment.trim()).filter(Boolean)
    : parrafo.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
  partes = unirAbreviaturas(partes).flatMap(partirLarga);

  // Fragmentos muy cortos ("—Sí.") se juntan con el siguiente para no generar audios mínimos.
  const out = [];
  for (const p of partes) {
    const previa = out.at(-1);
    if (previa && previa.length < MIN_ORACION && previa.length + p.length + 1 <= MAX_ORACION) {
      out[out.length - 1] = `${previa} ${p}`;
    } else {
      out.push(p);
    }
  }
  return out;
}

const PALABRAS = {
  es: ['de', 'la', 'que', 'el', 'en', 'y', 'los', 'se', 'del', 'las', 'un', 'por', 'con', 'no', 'una', 'su', 'para', 'es', 'al', 'lo', 'como', 'más', 'pero', 'sus', 'le'],
  en: ['the', 'of', 'and', 'to', 'in', 'is', 'that', 'it', 'for', 'was', 'on', 'with', 'as', 'he', 'be', 'at', 'by', 'this', 'had', 'not', 'are', 'but', 'from', 'or', 'have'],
};

export function detectarIdioma(texto) {
  const muestra = texto.slice(0, 20000).toLowerCase().match(/[a-záéíóúñü']+/g) || [];
  const cuenta = { es: 0, en: 0 };
  const sets = Object.fromEntries(Object.entries(PALABRAS).map(([k, v]) => [k, new Set(v)]));
  for (const w of muestra) {
    if (sets.es.has(w)) cuenta.es++;
    if (sets.en.has(w)) cuenta.en++;
  }
  return cuenta.en > cuenta.es ? 'en' : 'es';
}

// Convierte bloques {texto, seccion?} en la estructura que guarda la app:
// oraciones (texto plano), parrafos (índice de su primera oración) y secciones
// (título + índice de su primer párrafo).
export function estructurar(bloques, idioma) {
  const oraciones = [];
  const parrafos = [];
  const secciones = [];
  for (const b of bloques) {
    const texto = limpiarEspacios(b.texto);
    if (b.seccion && (!secciones.length || secciones.at(-1).parrafo !== parrafos.length)) {
      secciones.push({ titulo: b.seccion, parrafo: parrafos.length });
    }
    if (!texto) continue;
    const ors = dividirOraciones(texto, idioma);
    if (!ors.length) continue;
    parrafos.push(oraciones.length);
    oraciones.push(...ors);
  }
  if (!secciones.length || secciones[0].parrafo !== 0) secciones.unshift({ titulo: 'Inicio', parrafo: 0 });
  // Secciones vacías (sin párrafos propios) se descartan.
  let limpias = secciones.filter((s, k) => s.parrafo < parrafos.length && (k === secciones.length - 1 || secciones[k + 1].parrafo > s.parrafo));
  if (!limpias.length) limpias = [{ titulo: 'Inicio', parrafo: 0 }];
  return { oraciones, parrafos, secciones: partirSeccionesLargas(limpias, parrafos.length) };
}

// Una sección enorme (un texto pegado sin títulos, un PDF sin índice) se divide en
// partes para que la pantalla no tenga que dibujar miles de párrafos a la vez.
const MAX_PARRAFOS = 150;
function partirSeccionesLargas(secciones, totalParrafos) {
  const out = [];
  secciones.forEach((s, k) => {
    const fin = k + 1 < secciones.length ? secciones[k + 1].parrafo : totalParrafos;
    const partes = Math.ceil((fin - s.parrafo) / MAX_PARRAFOS);
    for (let j = 0; j < partes; j++) {
      out.push({ titulo: partes > 1 ? `${s.titulo} (${j + 1}/${partes})` : s.titulo, parrafo: s.parrafo + j * MAX_PARRAFOS });
    }
  });
  return out;
}
