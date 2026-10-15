import { listarDocs, leerDoc, leerContenido, guardarDocumento, actualizarDoc, borrarDocumento } from './db.js?v=1';
import { importarArchivo, importarTextoPegado } from './importar.js?v=1';
import { Reproductor } from './lectura.js?v=2';
import { ajustesVoz, guardarAjustesVoz, cargarMotor, estaDescargado, borrarVoces, caidaAnterior, modulo } from './voz.js?v=1';
import {
  sincronizar, configuracion, guardarConfiguracion, desconectar, probarConexion, ultimaSync,
  registrarBorrado, quitarBorrado, REPO_POR_DEFECTO, URL_CREAR_CLAVE,
} from './sync.js?v=1';

const $ = (s) => document.querySelector(s);
const VELOCIDADES = [0.8, 1, 1.15, 1.25, 1.5, 1.75, 2, 2.5, 3];
const CARACTERES_POR_SEGUNDO = 15; // ritmo aproximado de la voz a 1x, para estimar lo que falta
const NOTAS_MODELO = {
  v2: 'Probado en tu iPhone: genera unas 16 veces más rápido que escucharlo.',
  v3q: 'Según sus autores lee con menos errores. Comprimido para que quepa en el iPhone; aún no lo probamos allá.',
  v3: 'La mejor calidad, pero no cabe en la memoria de Safari en el iPhone: úsalo solo en el computador.',
};
const MB_MODELO = { v2: 263, v3q: 145, v3: 398 };
const MUESTRA_VOZ = {
  es: 'Hola. Esta es la voz con la que vas a escuchar tus libros. ¿Te gusta cómo suena?',
  en: "Hi. This is the voice you'll hear your books in. Do you like how it sounds?",
};

const reproductor = new Reproductor($('#audio'));
let ajustes = null;
let docAbierto = null;
let contenido = null;
let mapa = null;
let seccionPintada = -1;
let ultimoScrollUsuario = 0;

// ---------- utilidades ----------

const fmtVel = (v) => `${String(v).replace('.', ',')}x`;
function fmtDuracion(seg) {
  const min = Math.round(seg / 60);
  if (min < 1) return 'menos de 1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
const porcentaje = (doc) => (doc.totalOraciones ? Math.round(((doc.oracion || 0) / Math.max(1, doc.totalOraciones - 1)) * 100) : 0);
const restante = (doc) => (doc.caracteres * (1 - porcentaje(doc) / 100)) / (CARACTERES_POR_SEGUNDO * (ajustes?.velocidad || 1));

function mostrarError(donde, e) {
  const caja = $(donde);
  caja.textContent = e?.message || String(e);
  caja.hidden = false;
  console.error(e);
}

function mostrarVista(cual) {
  $('#vista-biblioteca').hidden = cual !== 'biblioteca';
  $('#vista-lector').hidden = cual !== 'lector';
  window.scrollTo(0, 0);
}

function mostrarCargando(texto, avance = 0) {
  $('#cargando-texto').textContent = texto;
  $('#cargando-barra').value = avance * 100;
  $('#cargando').hidden = false;
}

// ---------- biblioteca ----------

async function pintarBiblioteca() {
  $('#error-biblioteca').hidden = true;
  const docs = await listarDocs();
  const lista = $('#lista');
  lista.replaceChildren();
  $('#vacia').hidden = docs.length > 0;
  $('#titulo-lista').hidden = docs.length === 0;

  // El último que escuchaste, en este u otro dispositivo (llega por la sincronización).
  const ultimaVez = (d) => Math.max(d.progresoT || 0, d.abierto || 0);
  const reciente = docs
    .filter((d) => ultimaVez(d) && (d.oracion || 0) < d.totalOraciones - 1)
    .sort((a, b) => ultimaVez(b) - ultimaVez(a))[0];
  $('#continuar').hidden = !reciente;
  if (reciente) {
    $('#continuar-titulo').textContent = reciente.titulo;
    $('#continuar-detalle').textContent = `${porcentaje(reciente)} % · quedan ≈ ${fmtDuracion(restante(reciente))}`;
    $('#continuar').onclick = () => abrirDoc(reciente.id, { reproducir: true });
  }

  for (const d of docs) {
    const li = document.createElement('li');
    const abrir = document.createElement('button');
    abrir.className = 'doc-abrir';
    const titulo = document.createElement('div');
    titulo.className = 'doc-titulo';
    titulo.textContent = d.titulo;
    const meta = document.createElement('div');
    meta.className = 'doc-meta';
    const terminado = (d.oracion || 0) >= d.totalOraciones - 1 && d.abierto;
    meta.textContent = [d.autor, d.tipo.toUpperCase(), d.idioma.toUpperCase(), terminado ? 'terminado' : `${porcentaje(d)} %`].filter(Boolean).join(' · ');
    const barra = document.createElement('div');
    barra.className = 'progreso';
    const relleno = document.createElement('div');
    relleno.style.width = `${terminado ? 100 : porcentaje(d)}%`;
    barra.append(relleno);
    abrir.append(titulo, meta, barra);
    abrir.onclick = () => abrirDoc(d.id);
    const borrar = document.createElement('button');
    borrar.className = 'icono';
    borrar.setAttribute('aria-label', `Borrar ${d.titulo}`);
    borrar.textContent = 'Borrar';
    borrar.onclick = async () => {
      if (!confirm(`¿Borrar "${d.titulo}" de la biblioteca? Se pierde también dónde quedaste.`)) return;
      if (docAbierto?.id === d.id) { reproductor.cerrar(); docAbierto = null; }
      await borrarDocumento(d.id);
      await registrarBorrado(d.id);
      pedirSync(1500);
      pintarBiblioteca();
    };
    li.append(abrir, borrar);
    lista.append(li);
  }
  await revisarVoz();
}

async function revisarVoz() {
  const descargado = await estaDescargado(ajustes.modelo).catch(() => false);
  $('#aviso-voz').hidden = descargado;
  if (!descargado) {
    $('#aviso-voz-texto').textContent = `Para escuchar, primero descarga la voz. Es una sola vez: ${MB_MODELO[ajustes.modelo]} MB, mejor con Wi-Fi. Después funciona sin internet.`;
  }
  return descargado;
}

// ---------- agregar documentos ----------

async function guardarYAbrir({ doc, contenido: cont }, archivo) {
  const existente = await leerDoc(doc.id);
  if (!existente) {
    await guardarDocumento(doc, cont, archivo);
    await quitarBorrado(doc.id);
    pedirSync(1500);
  }
  $('#cargando').hidden = true;
  await abrirDoc(doc.id);
}

async function importar(archivo) {
  mostrarCargando(`Leyendo "${archivo.name}"…`);
  try {
    const r = await importarArchivo(archivo, (avance) => mostrarCargando(`Leyendo "${archivo.name}"…`, avance));
    await guardarYAbrir(r, archivo);
  } catch (e) {
    $('#cargando').hidden = true;
    mostrarVista('biblioteca');
    mostrarError('#error-biblioteca', e);
  }
}

async function guardarPegado() {
  const texto = $('#pegar-texto').value.trim();
  if (!texto) return;
  $('#dlg-pegar').close();
  mostrarCargando('Preparando el texto…');
  try {
    const r = await importarTextoPegado(texto, $('#pegar-titulo').value.trim());
    $('#pegar-texto').value = '';
    $('#pegar-titulo').value = '';
    await guardarYAbrir(r, null);
  } catch (e) {
    $('#cargando').hidden = true;
    mostrarError('#error-biblioteca', e);
  }
}

// ---------- lector ----------

function construirMapa(c) {
  const n = c.oraciones.length;
  const parrafoDe = new Int32Array(n);
  for (let p = 0; p < c.parrafos.length; p++) {
    const fin = p + 1 < c.parrafos.length ? c.parrafos[p + 1] : n;
    for (let i = c.parrafos[p]; i < fin; i++) parrafoDe[i] = p;
  }
  const seccionDeParrafo = (p) => {
    let lo = 0;
    let hi = c.secciones.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (c.secciones[mid].parrafo <= p) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return { parrafoDe, seccionDeOracion: (i) => seccionDeParrafo(parrafoDe[i]) };
}

async function abrirDoc(id, { reproducir = false } = {}) {
  // En el mismo toque: deja el audio habilitado para el play() que viene después.
  if (reproducir && !(docAbierto?.id === id && reproductor.sonando)) reproductor.desbloquear();
  if (docAbierto?.id === id && contenido) {
    mostrarVista('lector');
    if (reproducir && !reproductor.sonando) reproductor.play();
    centrarActual(true);
    return;
  }
  // Si la app recién abrió, espera (poco) la sincronización para partir donde quedaste
  // en el otro dispositivo y no desde una posición vieja.
  if (syncInicial) await Promise.race([syncInicial, new Promise((r) => setTimeout(r, 4000))]);
  const [doc, cont] = await Promise.all([leerDoc(id), leerContenido(id)]);
  if (!doc || !cont) {
    mostrarError('#error-biblioteca', new Error('No encontré ese documento.'));
    return;
  }
  docAbierto = { ...doc, abierto: Date.now() };
  contenido = cont;
  mapa = construirMapa(cont);
  actualizarDoc(id, { abierto: docAbierto.abierto }).catch(() => {});
  $('#error-lector').hidden = true;
  $('#lector-titulo').textContent = doc.titulo;
  $('#btn-idioma').textContent = doc.idioma.toUpperCase();
  $('#btn-velocidad').textContent = fmtVel(ajustes.velocidad);
  const sel = $('#secciones');
  sel.replaceChildren(...cont.secciones.map((s, k) => new Option(s.titulo, String(k))));
  sel.hidden = cont.secciones.length < 2;
  seccionPintada = -1;
  mostrarVista('lector');
  reproductor.seccionActual = () => cont.secciones[mapa.seccionDeOracion(reproductor.actual)]?.titulo || '';
  reproductor.abrir(docAbierto, cont, ajustes);
  reproductor.cambiarVelocidad(ajustes.velocidad);
  ultimoScrollUsuario = 0;
  centrarActual(true);
  if (reproducir) reproductor.play();
}

function pintarSeccion(s) {
  const c = contenido;
  const sec = c.secciones[s];
  const pFin = s + 1 < c.secciones.length ? c.secciones[s + 1].parrafo : c.parrafos.length;
  const frag = document.createDocumentFragment();
  if (c.secciones.length > 1) {
    const h = document.createElement('h3');
    h.className = 'seccion';
    h.textContent = sec.titulo;
    frag.append(h);
  }
  for (let p = sec.parrafo; p < pFin; p++) {
    const el = document.createElement('p');
    const fin = p + 1 < c.parrafos.length ? c.parrafos[p + 1] : c.oraciones.length;
    for (let i = c.parrafos[p]; i < fin; i++) {
      const span = document.createElement('span');
      span.className = 'o';
      span.dataset.i = i;
      span.textContent = c.oraciones[i];
      el.append(span, ' ');
    }
    frag.append(el);
  }
  const nav = document.createElement('div');
  nav.className = 'navegar-seccion';
  const boton = (texto, destino) => {
    const b = document.createElement('button');
    b.className = 'boton suave';
    b.textContent = texto;
    b.onclick = () => irASeccion(destino);
    return b;
  };
  if (s > 0) nav.append(boton('‹ Sección anterior', s - 1));
  if (s + 1 < c.secciones.length) nav.append(boton('Sección siguiente ›', s + 1));
  frag.append(nav);
  const texto = $('#texto');
  texto.lang = docAbierto.idioma;
  texto.replaceChildren(frag);
  seccionPintada = s;
  $('#secciones').value = String(s);
}

function irASeccion(s) {
  ultimoScrollUsuario = 0;
  reproductor.irA(contenido.parrafos[contenido.secciones[s].parrafo]);
}

function elementoActual() {
  return $(`#texto .o[data-i="${reproductor.actual}"]`);
}

function estaVisible(el) {
  const r = el.getBoundingClientRect();
  const alto = window.innerHeight - 170;
  return r.bottom > 60 && r.top < alto;
}

function centrarActual(inmediato = false) {
  const el = elementoActual();
  if (!el) return;
  el.scrollIntoView({ block: 'center', behavior: inmediato ? 'auto' : 'smooth' });
  $('#btn-seguir').hidden = true;
}

function pintarOracion(i) {
  if (!contenido) return;
  const s = mapa.seccionDeOracion(i);
  const nuevaSeccion = s !== seccionPintada;
  if (nuevaSeccion) pintarSeccion(s);
  $('#texto .o.actual')?.classList.remove('actual');
  const el = elementoActual();
  el?.classList.add('actual');
  if (el) {
    if (nuevaSeccion || Date.now() - ultimoScrollUsuario > 8000) centrarActual(nuevaSeccion);
    else $('#btn-seguir').hidden = estaVisible(el);
  }
  docAbierto.oracion = i;
  $('#rep-seccion').textContent = contenido.secciones[s]?.titulo || '';
  $('#rep-progreso').textContent = `${porcentaje(docAbierto)} % · ≈ ${fmtDuracion(restante(docAbierto))}`;
}

function pintarEstado(estado) {
  const reproduciendo = ['sonando', 'generando', 'cargando-voz'].includes(estado);
  // Los íconos son SVG: `hidden` como propiedad no existe en SVG, hay que usar el atributo.
  $('#icono-play').toggleAttribute('hidden', reproduciendo);
  $('#icono-pausa').toggleAttribute('hidden', !reproduciendo);
  $('#btn-play').setAttribute('aria-label', reproduciendo ? 'Pausar' : 'Reproducir');
  const textos = {
    'cargando-voz': 'Preparando la voz…',
    generando: 'Generando la voz…',
    fin: 'Terminaste este documento.',
  };
  $('#rep-estado').textContent = textos[estado] || '';
}

// ---------- ajustes de voz ----------

async function abrirAjustes() {
  const st = await modulo();
  const selVoz = $('#aj-voz');
  if (!selVoz.options.length) selVoz.replaceChildren(...st.VOCES.map(([c, n]) => new Option(n, c)));
  $('#aj-modelo').value = ajustes.modelo;
  $('#aj-voz').value = ajustes.voz;
  $('#aj-pasos').value = String(ajustes.pasos);
  $('#aj-backend').value = ajustes.backend;
  $('#aj-barra').hidden = true;
  await pintarNotaModelo();
  $('#dlg-voz').showModal();
}

async function pintarNotaModelo() {
  const descargado = await estaDescargado(ajustes.modelo).catch(() => false);
  $('#aj-nota-modelo').textContent = `${NOTAS_MODELO[ajustes.modelo]} ${descargado ? 'Ya está descargado en este dispositivo.' : `Falta descargarlo (${MB_MODELO[ajustes.modelo]} MB).`}`;
  $('#btn-preparar-voz').textContent = descargado ? 'Preparar ahora' : `Descargar (${MB_MODELO[ajustes.modelo]} MB)`;
}

async function cambiarAjuste() {
  ajustes = await guardarAjustesVoz({
    modelo: $('#aj-modelo').value,
    voz: $('#aj-voz').value,
    pasos: parseInt($('#aj-pasos').value, 10),
    backend: $('#aj-backend').value,
  });
  reproductor.cambiarAjustes(ajustes);
  await pintarNotaModelo();
  revisarVoz();
}

function progresoVoz({ fase, bytes, totalBytes, archivo }) {
  $('#aj-barra').hidden = false;
  $('#aj-barra').value = Math.min(100, (bytes / totalBytes) * 100);
  $('#aj-estado').textContent = fase === 'preparando'
    ? `Preparando ${archivo}…`
    : `${fase === 'leyendo' ? 'Cargando' : 'Descargando'}: ${Math.round(bytes / 1e6)} de ${Math.round(totalBytes / 1e6)} MB`;
}

async function prepararVoz() {
  const btn = $('#btn-preparar-voz');
  btn.disabled = true;
  try {
    const t0 = Date.now();
    await cargarMotor(ajustes, progresoVoz);
    $('#aj-barra').value = 100;
    $('#aj-estado').textContent = `Voz lista (tardó ${Math.round((Date.now() - t0) / 1000)} s).`;
    await pintarNotaModelo();
    revisarVoz();
  } catch (e) {
    $('#aj-estado').textContent = `No se pudo preparar la voz: ${e.message || e}`;
  } finally {
    btn.disabled = false;
  }
}

const audioMuestra = new Audio();
async function probarVoz() {
  // Se habilita en el mismo toque; el audio real llega después de generarlo.
  audioMuestra.src = reproductor.silencio;
  audioMuestra.play().catch(() => {});
  reproductor.pausar();
  const btn = $('#btn-probar-voz');
  btn.disabled = true;
  try {
    const motor = await cargarMotor(ajustes, progresoVoz);
    $('#aj-estado').textContent = 'Generando la muestra…';
    const idioma = docAbierto?.idioma || 'es';
    const st = await modulo();
    const r = await motor.sintetizar(MUESTRA_VOZ[idioma], idioma, ajustes.voz, { pasos: ajustes.pasos });
    audioMuestra.src = URL.createObjectURL(st.wavBlob(r.pcm, motor.sampleRate));
    audioMuestra.playbackRate = ajustes.velocidad;
    await audioMuestra.play();
    $('#aj-estado').textContent = '';
    await pintarNotaModelo();
    revisarVoz();
  } catch (e) {
    $('#aj-estado').textContent = `No se pudo probar la voz: ${e.message || e}`;
  } finally {
    btn.disabled = false;
  }
}

// ---------- sincronización ----------

let syncInicial = null;
let temporizadorSync = null;
let venceSync = 0;
let errorSync = null;

function resumenSync(r) {
  if (!r) return '';
  const n = (k, uno, varios) => `${k} ${k === 1 ? uno : varios}`;
  const partes = [];
  if (r.subidos) partes.push(`subí ${n(r.subidos, 'documento', 'documentos')}`);
  if (r.bajados) partes.push(`bajé ${n(r.bajados, 'documento', 'documentos')}`);
  if (r.posiciones) partes.push(`actualicé ${n(r.posiciones, 'posición', 'posiciones')}`);
  if (r.borrados) partes.push(`borré ${n(r.borrados, 'documento', 'documentos')}`);
  if (!partes.length) return 'Todo estaba al día.';
  const texto = partes.length > 1 ? `${partes.slice(0, -1).join(', ')} y ${partes.at(-1)}` : partes[0];
  return `${texto[0].toUpperCase()}${texto.slice(1)}.`;
}

function haceCuanto(ts) {
  const seg = (Date.now() - ts) / 1000;
  if (seg < 60) return 'recién';
  if (seg < 3600) return `hace ${Math.round(seg / 60)} min`;
  if (seg < 86400) return `hace ${Math.round(seg / 3600)} h`;
  return `hace ${Math.round(seg / 86400)} días`;
}

async function pintarEstadoSync(sincronizando = false) {
  const el = $('#estado-sync');
  const cfg = await configuracion();
  el.classList.toggle('error-sync', !!errorSync);
  if (!cfg?.token) el.textContent = 'Sincronizar entre dispositivos ›';
  else if (sincronizando) el.textContent = 'Sincronizando…';
  else if (errorSync) el.textContent = `No se pudo sincronizar: ${errorSync} ›`;
  else {
    const ts = await ultimaSync();
    el.textContent = ts ? `Sincronizado ${haceCuanto(ts)}` : 'Sincronización activada';
  }
}

// Agenda una sincronización dentro de `ms`. Si ya hay una antes, se respeta esa:
// así una lectura continua sincroniza cada minuto y no espera a que pares.
function pedirSync(ms) {
  const vence = Date.now() + ms;
  if (temporizadorSync && venceSync <= vence) return;
  clearTimeout(temporizadorSync);
  venceSync = vence;
  temporizadorSync = setTimeout(() => { temporizadorSync = null; correrSync(); }, ms);
}

async function correrSync() {
  if (!(await configuracion())?.token) return null;
  pintarEstadoSync(true);
  try {
    if (reproductor.doc) await reproductor.guardarYa();
    const r = await sincronizar();
    errorSync = null;
    if (r && (r.bajados || r.borrados || r.posiciones)) await aplicarCambiosRemotos();
    return r;
  } catch (e) {
    errorSync = e.message || String(e);
    return null;
  } finally {
    pintarEstadoSync();
  }
}

// Lo que llegó de otro dispositivo se refleja en pantalla.
async function aplicarCambiosRemotos() {
  if (docAbierto) {
    const doc = await leerDoc(docAbierto.id);
    if (!doc) {
      reproductor.cerrar();
      docAbierto = null;
      mostrarVista('biblioteca');
    } else if ((doc.progresoT || 0) > (reproductor.cambioPosicion || 0) && !reproductor.sonando) {
      docAbierto.oracion = doc.oracion;
      reproductor.posicionarDesdeSync(doc.oracion, doc.progresoT);
    }
  }
  if (!$('#vista-biblioteca').hidden) await pintarBiblioteca();
}

async function abrirSync() {
  const cfg = await configuracion();
  const repo = cfg?.repo || REPO_POR_DEFECTO;
  $('#sync-repo-nombre').textContent = repo;
  $('#sync-repo').value = repo;
  $('#sync-token').value = '';
  $('#link-clave').href = URL_CREAR_CLAVE;
  const conectado = !!cfg?.token;
  $('#sync-pasos').hidden = conectado;
  $('#btn-sync-desconectar').hidden = !conectado;
  $('#btn-sync-ahora').hidden = !conectado;
  $('#btn-sync-conectar').textContent = conectado ? 'Cambiar clave' : 'Conectar';
  $('#sync-estado').textContent = conectado
    ? `Conectado. ${errorSync ? `Último error: ${errorSync}` : `Última sincronización: ${haceCuanto(await ultimaSync())}.`}`
    : '';
  $('#dlg-sync').showModal();
}

async function conectarSync() {
  if (!$('#sync-pasos').hidden) {
    const token = $('#sync-token').value.trim();
    const repo = ($('#sync-repo').value.trim() || REPO_POR_DEFECTO).replace(/^https:\/\/github\.com\//, '');
    if (!token) {
      $('#sync-estado').textContent = 'Pega la clave de GitHub primero.';
      return;
    }
    const btn = $('#btn-sync-conectar');
    btn.disabled = true;
    $('#sync-estado').textContent = 'Revisando la clave…';
    try {
      // window.__apiGithub solo existe en pruebas locales con un GitHub simulado.
      const cfg = { token, repo, ...(window.__apiGithub ? { apiBase: window.__apiGithub } : {}) };
      await probarConexion(cfg);
      await guardarConfiguracion(cfg);
      $('#sync-token').value = '';
      $('#sync-estado').textContent = 'Clave correcta. Sincronizando…';
      const r = await correrSync();
      $('#sync-estado').textContent = errorSync
        ? `Conectado, pero falló la primera sincronización: ${errorSync}`
        : `Listo. ${resumenSync(r)}`;
      $('#sync-pasos').hidden = true;
      $('#btn-sync-desconectar').hidden = false;
      $('#btn-sync-ahora').hidden = false;
      btn.textContent = 'Cambiar clave';
    } catch (e) {
      $('#sync-estado').textContent = e.message || String(e);
    } finally {
      btn.disabled = false;
    }
  } else {
    // "Cambiar clave": se vuelven a mostrar los pasos.
    $('#sync-pasos').hidden = false;
    $('#btn-sync-conectar').textContent = 'Conectar';
    $('#sync-estado').textContent = '';
  }
}

// ---------- arranque ----------

function conectar() {
  $('#btn-agregar').onclick = () => $('#dlg-agregar').showModal();
  $('#btn-agregar-vacia').onclick = () => $('#dlg-agregar').showModal();
  $('#btn-elegir-archivo').onclick = () => { $('#dlg-agregar').close(); $('#archivo').click(); };
  $('#btn-pegar').onclick = () => { $('#dlg-agregar').close(); $('#dlg-pegar').showModal(); };
  $('#btn-guardar-pegado').onclick = guardarPegado;
  $('#archivo').onchange = (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importar(f);
  };
  for (const b of document.querySelectorAll('[data-cerrar]')) b.onclick = () => b.closest('dialog').close();

  $('#btn-volver').onclick = async () => {
    await reproductor.guardarYa();
    mostrarVista('biblioteca');
    pintarBiblioteca();
  };
  $('#btn-play').onclick = () => reproductor.alternar();
  $('#btn-anterior').onclick = () => { ultimoScrollUsuario = 0; reproductor.anterior(); };
  $('#btn-siguiente').onclick = () => { ultimoScrollUsuario = 0; reproductor.siguiente(); };
  $('#btn-velocidad').onclick = async () => {
    const k = VELOCIDADES.indexOf(ajustes.velocidad);
    const v = VELOCIDADES[(k + 1) % VELOCIDADES.length];
    ajustes = await guardarAjustesVoz({ velocidad: v });
    reproductor.cambiarVelocidad(v);
    $('#btn-velocidad').textContent = fmtVel(v);
    if (docAbierto) pintarOracion(reproductor.actual);
  };
  $('#btn-idioma').onclick = async () => {
    if (!docAbierto) return;
    const idioma = docAbierto.idioma === 'es' ? 'en' : 'es';
    docAbierto.idioma = idioma;
    await actualizarDoc(docAbierto.id, { idioma, metaT: Date.now() });
    pedirSync(1500);
    $('#btn-idioma').textContent = idioma.toUpperCase();
    $('#texto').lang = idioma;
    reproductor.cambiarAjustes(ajustes, idioma);
  };
  $('#secciones').onchange = (e) => irASeccion(parseInt(e.target.value, 10));
  $('#texto').addEventListener('click', (e) => {
    const o = e.target.closest('.o');
    if (!o) return;
    ultimoScrollUsuario = 0;
    reproductor.irA(parseInt(o.dataset.i, 10));
    if (!reproductor.sonando) reproductor.play();
  });
  const marcarScroll = () => {
    if ($('#vista-lector').hidden) return;
    ultimoScrollUsuario = Date.now();
    const el = elementoActual();
    $('#btn-seguir').hidden = !el || estaVisible(el);
  };
  window.addEventListener('touchmove', marcarScroll, { passive: true });
  window.addEventListener('wheel', marcarScroll, { passive: true });
  $('#btn-seguir').onclick = () => { ultimoScrollUsuario = 0; centrarActual(); };

  $('#estado-sync').onclick = abrirSync;
  $('#btn-sync-conectar').onclick = conectarSync;
  $('#btn-sync-ahora').onclick = async () => {
    $('#sync-estado').textContent = 'Sincronizando…';
    const r = await correrSync();
    $('#sync-estado').textContent = errorSync
      ? `Error: ${errorSync}`
      : `Listo. ${resumenSync(r)}`;
  };
  $('#btn-sync-desconectar').onclick = async () => {
    if (!confirm('¿Desconectar este dispositivo? Tus documentos quedan aquí y en GitHub, pero dejan de sincronizarse.')) return;
    await desconectar();
    errorSync = null;
    $('#dlg-sync').close();
    pintarEstadoSync();
  };
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) pedirSync(400); // sube la posición antes de que el teléfono duerma la app
    else if (Date.now() - (await ultimaSync()) > 60000) pedirSync(0);
  });

  $('#btn-ajustes').onclick = abrirAjustes;
  $('#btn-ajustes-biblioteca').onclick = abrirAjustes;
  $('#btn-descargar-voz').onclick = async () => { await abrirAjustes(); prepararVoz(); };
  for (const id of ['#aj-modelo', '#aj-voz', '#aj-pasos', '#aj-backend']) $(id).onchange = cambiarAjuste;
  $('#btn-preparar-voz').onclick = prepararVoz;
  $('#btn-probar-voz').onclick = probarVoz;
  $('#btn-borrar-voces').onclick = async () => {
    if (!confirm('¿Borrar las voces descargadas? Habrá que descargarlas de nuevo para escuchar.')) return;
    reproductor.pausar();
    await borrarVoces();
    await pintarNotaModelo();
    revisarVoz();
  };

  reproductor.addEventListener('oracion', (e) => {
    pintarOracion(e.detail);
    pedirSync(60000);
  });
  reproductor.addEventListener('estado', (e) => {
    pintarEstado(e.detail);
    if (e.detail === 'pausa' || e.detail === 'fin') pedirSync(2000);
  });
  reproductor.addEventListener('voz', (e) => {
    const { fase, bytes, totalBytes } = e.detail;
    $('#rep-estado').textContent = fase === 'descargando'
      ? `Descargando la voz: ${Math.round(bytes / 1e6)} de ${Math.round(totalBytes / 1e6)} MB`
      : 'Preparando la voz…';
  });
  reproductor.addEventListener('error', (e) => mostrarError('#error-lector', e.detail));
}

async function iniciar() {
  conectar();
  ajustes = await ajustesVoz();

  const caida = caidaAnterior();
  if (caida) {
    const cambios = caida.modelo === 'v3' ? { modelo: 'v2' } : caida.backend !== 'cpu' ? { backend: 'cpu' } : {};
    ajustes = await guardarAjustesVoz(cambios);
    mostrarError('#error-biblioteca', new Error(
      `La última vez la app se cerró mientras preparaba la voz, probablemente por falta de memoria. ${cambios.modelo ? 'Cambié al modelo Supertonic 2.' : cambios.backend ? 'Cambié a "Solo procesador", que usa menos memoria.' : 'Avísame en el chat.'}`,
    ));
  }

  await pintarBiblioteca();
  pintarEstadoSync();
  syncInicial = correrSync().finally(() => { syncInicial = null; });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

  // Con la voz ya descargada, se carga en segundo plano para que "Seguir escuchando" parta al tiro.
  if (await estaDescargado(ajustes.modelo).catch(() => false)) {
    setTimeout(() => cargarMotor(ajustes).catch(() => {}), 1500);
  }
}

window.__lector = { importar, abrirDoc, reproductor };
iniciar();
