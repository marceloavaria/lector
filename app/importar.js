// Convierte un PDF, un EPUB o texto en bloques de párrafos con sus secciones.

import { detectarIdioma, estructurar, limpiarEspacios } from './texto.js?v=1';

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build';
const JSZIP = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

export async function huella(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sinExtension(nombre) {
  return nombre.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
}

export async function importarArchivo(archivo, alAvanzar) {
  const nombre = archivo.name || 'documento';
  const ext = nombre.split('.').pop().toLowerCase();
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  let r;
  if (ext === 'pdf' || archivo.type === 'application/pdf') r = await leerPdf(bytes, alAvanzar);
  else if (ext === 'epub' || archivo.type === 'application/epub+zip') r = await leerEpub(bytes, alAvanzar);
  else if (['txt', 'md', 'text'].includes(ext) || archivo.type.startsWith('text/')) r = leerTexto(new TextDecoder().decode(bytes));
  else throw new Error(`No sé leer archivos .${ext}. Usa PDF, EPUB o texto.`);
  return armar(r, { tipo: ext === 'epub' ? 'epub' : ext === 'pdf' ? 'pdf' : 'texto', nombre, id: await huella(bytes) });
}

export async function importarTextoPegado(texto, titulo) {
  const r = leerTexto(texto);
  const id = await huella(new TextEncoder().encode(texto));
  return armar({ ...r, titulo: titulo || r.titulo }, { tipo: 'texto', nombre: titulo || 'Texto pegado', id });
}

function armar(r, { tipo, nombre, id }) {
  const muestra = r.bloques.slice(0, 200).map((b) => b.texto).join(' ');
  if (muestra.replace(/\s/g, '').length < 20) {
    throw new Error(tipo === 'pdf'
      ? 'Este PDF no tiene texto seleccionable (probablemente es una imagen escaneada).'
      : 'No encontré texto en este archivo.');
  }
  const idioma = r.idioma?.startsWith('en') ? 'en' : r.idioma?.startsWith('es') ? 'es' : detectarIdioma(muestra);
  const contenido = estructurar(r.bloques, idioma);
  const doc = {
    id,
    titulo: (r.titulo || sinExtension(nombre)).slice(0, 200),
    autor: r.autor || '',
    tipo,
    idioma,
    creado: Date.now(),
    abierto: 0,
    oracion: 0,
    totalOraciones: contenido.oraciones.length,
    caracteres: contenido.oraciones.reduce((n, o) => n + o.length, 0),
  };
  return { doc, contenido: { id, ...contenido } };
}

// ---------- Texto plano ----------

function leerTexto(texto) {
  const normal = texto.replace(/\r\n?/g, '\n');
  const conBlancos = /\n\s*\n/.test(normal);
  const parrafos = (conBlancos ? normal.split(/\n\s*\n+/) : normal.split('\n'))
    .map((p) => p.replace(/\n/g, ' ').trim())
    .filter(Boolean);
  const primera = parrafos[0] || '';
  const titulo = primera.length <= 90 ? primera.replace(/^#+\s*/, '') : `${primera.slice(0, 60)}…`;
  return { titulo, bloques: parrafos.map((p) => ({ texto: p.replace(/^#+\s*/, '') })) };
}

// ---------- PDF ----------

let pdfjsCargado = null;
async function pdfjs() {
  if (!pdfjsCargado) {
    pdfjsCargado = import(`${PDFJS}/pdf.min.mjs`).then((m) => {
      m.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.mjs`;
      return m;
    });
  }
  return pdfjsCargado;
}

// Agrupa los fragmentos de texto de una página en líneas con su posición.
function lineasDePagina(items) {
  const lineas = [];
  let actual = null;
  for (const it of items) {
    if (!('str' in it)) continue;
    const y = it.transform[5];
    const x = it.transform[4];
    const h = Math.abs(it.transform[3]) || it.height || 10;
    if (actual && Math.abs(y - actual.y) < h * 0.5) {
      const hueco = x - (actual.xFin ?? x);
      actual.texto += (hueco > h * 0.15 && !actual.texto.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '') + it.str;
      actual.xFin = x + (it.width || 0);
    } else if (it.str.trim() || actual) {
      if (actual && actual.texto.trim()) lineas.push(actual);
      actual = { texto: it.str, y, x, h, xFin: x + (it.width || 0) };
    }
    if (it.hasEOL && actual) {
      if (actual.texto.trim()) lineas.push(actual);
      actual = null;
    }
  }
  if (actual && actual.texto.trim()) lineas.push(actual);
  return lineas.map((l) => ({ ...l, texto: limpiarEspacios(l.texto) })).filter((l) => l.texto);
}

const mediana = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const firma = (t) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

async function leerPdf(bytes, alAvanzar) {
  const lib = await pdfjs();
  const tarea = lib.getDocument({ data: bytes, isEvalSupported: false });
  const pdf = await tarea.promise;
  let titulo = '';
  let autor = '';
  let idioma = '';
  try {
    const meta = await pdf.getMetadata();
    titulo = (meta.info?.Title || '').trim();
    autor = (meta.info?.Author || '').trim();
    idioma = (meta.info?.Language || '').trim().toLowerCase();
  } catch { /* sin metadatos */ }

  const paginas = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    paginas.push(lineasDePagina(tc.items));
    page.cleanup();
    alAvanzar?.(p / pdf.numPages);
  }

  // Encabezados y pies que se repiten en muchas páginas (y los números de página) se omiten.
  const repetidas = new Map();
  for (const lineas of paginas) {
    for (const l of [...lineas.slice(0, 2), ...lineas.slice(-2)]) {
      const f = firma(l.texto);
      repetidas.set(f, (repetidas.get(f) || 0) + 1);
    }
  }
  const umbral = Math.max(3, paginas.length * 0.3);
  const esRuido = (l, k, total) => {
    if (/^\s*docusign envelope id\b/i.test(l.texto)) return true; // el sello de DocuSign de cada página
    const borde = k < 2 || k >= total - 2;
    if (borde && (repetidas.get(firma(l.texto)) || 0) >= umbral) return true;
    return borde && /^[\divxlcIVXLC\s.\-–|/]+$/.test(l.texto) && l.texto.length <= 12;
  };

  // Párrafos: un salto vertical mayor que el normal, o una sangría tras punto final.
  const bloques = [];
  let parrafo = '';
  let paginaParrafo = 1;
  const cerrar = () => {
    if (parrafo.trim()) bloques.push({ texto: parrafo, pagina: paginaParrafo });
    parrafo = '';
  };
  paginas.forEach((lineasPag, idx) => {
    const lineas = lineasPag.filter((l, k) => !esRuido(l, k, lineasPag.length));
    const saltos = [];
    for (let k = 1; k < lineas.length; k++) {
      const d = lineas[k - 1].y - lineas[k].y;
      if (d > 0) saltos.push(d);
    }
    const interlinea = mediana(saltos) || 14;
    const margen = mediana(lineas.map((l) => l.x));
    const finTipico = mediana(lineas.map((l) => l.xFin));
    lineas.forEach((l, k) => {
      const previa = k > 0 ? lineas[k - 1] : null;
      let nuevo = false;
      if (previa) {
        const d = previa.y - l.y;
        const terminaFrase = /[.!?:»”"')]$/.test(previa.texto);
        if (d > interlinea * 1.45 || d < 0) nuevo = true;
        else if (terminaFrase && l.x > margen + l.h * 0.8) nuevo = true;
        else if (terminaFrase && previa.xFin < finTipico - l.h * 3) nuevo = true;
      } else if (parrafo) {
        // Primera línea de la página: sigue el párrafo anterior si no terminó en punto.
        nuevo = /[.!?:»”"')]$/.test(parrafo.trim()) && !/^[a-záéíóúñ]/.test(l.texto);
      }
      if (nuevo) cerrar();
      if (!parrafo) paginaParrafo = idx + 1;
      if (parrafo.endsWith('-') && /^[a-záéíóúñü]/.test(l.texto)) parrafo = parrafo.slice(0, -1) + l.texto;
      else parrafo = parrafo ? `${parrafo} ${l.texto}` : l.texto;
    });
  });
  cerrar();

  // Secciones: el índice del PDF si existe; si no, grupos de 10 páginas.
  const titulosPorPagina = new Map();
  let indice = [];
  try { indice = (await pdf.getOutline()) || []; } catch { /* sin índice */ }
  for (const item of indice) {
    try {
      let dest = item.dest;
      if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest) || dest[0] == null) continue;
      const ref = dest[0];
      const pagina = typeof ref === 'number' ? ref + 1 : (await pdf.getPageIndex(ref)) + 1;
      const t = limpiarEspacios(item.title || '');
      if (t && !titulosPorPagina.has(pagina)) titulosPorPagina.set(pagina, t.slice(0, 120));
    } catch { /* entrada del índice rota: se ignora */ }
  }
  if (titulosPorPagina.size < 2) {
    titulosPorPagina.clear();
    for (let p = 1; p <= pdf.numPages; p += 10) {
      titulosPorPagina.set(p, `Páginas ${p}–${Math.min(p + 9, pdf.numPages)}`);
    }
  }
  const paginasConTitulo = [...titulosPorPagina.keys()].sort((a, b) => a - b);
  let s = 0;
  for (const b of bloques) {
    while (s < paginasConTitulo.length && paginasConTitulo[s] <= b.pagina) {
      b.seccion = titulosPorPagina.get(paginasConTitulo[s]);
      s++;
    }
  }
  await tarea.destroy();
  return { titulo, autor, idioma, bloques };
}

// ---------- EPUB ----------

const BLOQUES = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'DT', 'DD', 'FIGCAPTION', 'TD', 'TH']);
const IGNORAR = new Set(['SCRIPT', 'STYLE', 'NAV', 'HEAD', 'SVG', 'MATH', 'RT', 'RP']);

function rutaRelativa(base, href) {
  const limpia = decodeURIComponent(href.split('#')[0]);
  const partes = base.split('/').slice(0, -1);
  for (const seg of limpia.split('/')) {
    if (seg === '..') partes.pop();
    else if (seg && seg !== '.') partes.push(seg);
  }
  return partes.join('/');
}

function parsearXml(texto, tipo = 'application/xhtml+xml') {
  let doc = new DOMParser().parseFromString(texto, tipo);
  if (doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(texto, 'text/html');
  return doc;
}

const porNombre = (raiz, nombre) => [...raiz.getElementsByTagName('*')].filter((e) => e.localName === nombre);

// Extrae los párrafos de un capítulo: cada bloque de texto (p, títulos, ítems) es un
// párrafo; un div sin bloques adentro también cuenta.
function textosDeCapitulo(doc) {
  const out = [];
  const esBloque = (tag) => BLOQUES.has(tag) || tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE';
  const visitar = (el) => {
    const tag = el.tagName.toUpperCase();
    if (IGNORAR.has(tag)) return;
    // Un bloque con otros bloques adentro (un blockquote con varios párrafos) se recorre.
    const tieneBloques = [...el.children].some((c) => esBloque(c.tagName.toUpperCase()));
    if (esBloque(tag) && !tieneBloques) {
      const t = limpiarEspacios(el.textContent || '');
      if (t) out.push({ texto: t, titulo: /^H[1-6]$/.test(tag) });
      return;
    }
    for (const c of el.children) visitar(c);
  };
  const body = doc.body || porNombre(doc, 'body')[0] || doc.documentElement;
  if (body) visitar(body);
  return out;
}

async function leerEpub(bytes, alAvanzar) {
  const JSZip = (await import(JSZIP)).default;
  const zip = await JSZip.loadAsync(bytes);
  const leer = async (ruta) => {
    const f = zip.file(ruta);
    if (!f) throw new Error(`Falta ${ruta} dentro del EPUB.`);
    return f.async('text');
  };
  if (zip.file('META-INF/encryption.xml')) {
    // Las fuentes ofuscadas son normales; el texto cifrado (DRM) no se puede leer.
    const enc = await leer('META-INF/encryption.xml');
    if (/URI="[^"]+\.x?html?"/i.test(enc)) throw new Error('Este EPUB tiene protección (DRM) y no se puede leer. Usa un EPUB sin DRM.');
  }

  const container = parsearXml(await leer('META-INF/container.xml'), 'application/xml');
  const opfRuta = porNombre(container, 'rootfile')[0]?.getAttribute('full-path');
  if (!opfRuta) throw new Error('El EPUB no tiene índice (OPF).');
  const opf = parsearXml(await leer(opfRuta), 'application/xml');
  const meta = (n) => limpiarEspacios(porNombre(opf, n)[0]?.textContent || '');
  const titulo = meta('title');
  const autor = meta('creator');
  const idioma = meta('language').toLowerCase();

  const manifiesto = new Map();
  for (const it of porNombre(opf, 'item')) {
    manifiesto.set(it.getAttribute('id'), {
      ruta: rutaRelativa(opfRuta, it.getAttribute('href') || ''),
      tipo: it.getAttribute('media-type') || '',
      props: it.getAttribute('properties') || '',
    });
  }
  const spine = porNombre(opf, 'itemref')
    .filter((r) => r.getAttribute('linear') !== 'no')
    .map((r) => manifiesto.get(r.getAttribute('idref')))
    .filter((m) => m && /html/.test(m.tipo));

  // Títulos de capítulos desde el índice (EPUB 3 nav o EPUB 2 toc.ncx).
  const titulos = new Map();
  try {
    const nav = [...manifiesto.values()].find((m) => m.props.split(/\s+/).includes('nav'));
    if (nav) {
      const doc = parsearXml(await leer(nav.ruta));
      const toc = porNombre(doc, 'nav').find((n) => (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '').includes('toc')) || porNombre(doc, 'nav')[0];
      for (const a of toc ? porNombre(toc, 'a') : []) {
        const ruta = rutaRelativa(nav.ruta, a.getAttribute('href') || '');
        if (!titulos.has(ruta)) titulos.set(ruta, limpiarEspacios(a.textContent || ''));
      }
    } else {
      const ncx = [...manifiesto.values()].find((m) => m.tipo === 'application/x-dtbncx+xml');
      if (ncx) {
        const doc = parsearXml(await leer(ncx.ruta), 'application/xml');
        for (const np of porNombre(doc, 'navPoint')) {
          const src = porNombre(np, 'content')[0]?.getAttribute('src') || '';
          const ruta = rutaRelativa(ncx.ruta, src);
          const t = limpiarEspacios(porNombre(np, 'text')[0]?.textContent || '');
          if (t && !titulos.has(ruta)) titulos.set(ruta, t);
        }
      }
    }
  } catch { /* sin índice: se usan los títulos del texto */ }

  const bloques = [];
  for (let k = 0; k < spine.length; k++) {
    alAvanzar?.((k + 1) / spine.length);
    let doc;
    try { doc = parsearXml(await leer(spine[k].ruta)); } catch { continue; }
    const textos = textosDeCapitulo(doc);
    if (!textos.length) continue;
    const tituloCap = titulos.get(spine[k].ruta) || textos.find((t) => t.titulo)?.texto || `Parte ${k + 1}`;
    textos.forEach((t, i) => bloques.push({ texto: t.texto, seccion: i === 0 ? tituloCap.slice(0, 120) : undefined }));
  }
  return { titulo, autor, idioma, bloques };
}
