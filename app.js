import { MUESTRAS, TEXTO_LARGO } from './textos.js?v=3';

const $ = (sel) => document.querySelector(sel);
const coma = (x, d = 1) => x.toFixed(d).replace('.', ',');
const fmtSeg = (s) => {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60);
  return m ? `${m} min ${s % 60} s` : `${s} s`;
};
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let st = null;      // módulo supertonic.js (se importa al cargar la página)
let motor = null;   // instancia de Supertonic ya cargada
let equipo = null;
const resultadosMuestras = [];

// ---------- Errores visibles (en el iPhone no hay consola a mano) ----------

function mostrarError(e) {
  const caja = $('#errores');
  caja.hidden = false;
  const linea = document.createElement('div');
  linea.textContent = `${new Date().toLocaleTimeString('es-CL')} · ${e?.message || e}`;
  caja.append(linea);
  console.error(e);
}
window.addEventListener('error', (ev) => mostrarError(ev.error || ev.message));
window.addEventListener('unhandledrejection', (ev) => mostrarError(ev.reason));

// ---------- Equipo ----------

async function detectarEquipo() {
  const ua = navigator.userAgent;
  const ios = ua.match(/OS (\d+)[._](\d+)(?:[._](\d+))? like Mac OS X/);
  const safari = ua.match(/Version\/([\d.]+)/);
  const otro = ua.match(/(Edg|CriOS|Chrome|Firefox|FxiOS)\/([\d.]+)/);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let gpu = 'no';
  if (navigator.gpu) {
    try { gpu = (await navigator.gpu.requestAdapter()) ? 'sí' : 'no (sin adaptador)'; } catch { gpu = 'no (error)'; }
  }
  equipo = {
    sistema: ios ? `iPhone/iPad, UA iOS ${ios[1]}.${ios[2]}` : (/(Mac OS X|Windows|Android|Linux)/.exec(ua)?.[1] ?? 'desconocido'),
    navegador: otro ? `${otro[1]} ${otro[2]}` : safari ? `Safari ${safari[1]}` : 'desconocido',
    modo: standalone ? 'ícono (app web)' : 'pestaña del navegador',
    webgpu: gpu,
  };
  $('#equipo').innerHTML = '';
  for (const [k, v] of [['Sistema', equipo.sistema], ['Navegador', equipo.navegador], ['Abierta como', equipo.modo], ['WebGPU', equipo.webgpu]]) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${k}</span><strong></strong>`;
    li.querySelector('strong').textContent = v;
    $('#equipo').append(li);
  }
}

function lineaEquipo() {
  return `${equipo.sistema} · ${equipo.navegador} · abierta como ${equipo.modo} · WebGPU ${equipo.webgpu}`;
}

// ---------- Paso 1: descargar el modelo ----------

async function revisarDescarga() {
  if (!st) return;
  const id = $('#modelo').value;
  const listo = await st.estaDescargado(id);
  $('#estado-modelo').textContent = listo
    ? `${st.MODELOS[id].nombre} ya está descargado en este dispositivo. Toca "Preparar voz" para cargarlo.`
    : `${st.MODELOS[id].nombre} pesa ${st.MODELOS[id].mb} MB. Usa Wi-Fi.`;
}

// Si Safari cierra la página por memoria mientras prepara la voz, esta marca queda
// guardada y al volver se propone una opción más liviana.
const MARCA = 'lector:preparando';
const leerMarca = () => { try { return JSON.parse(localStorage.getItem(MARCA)); } catch { return null; } };
const ponerMarca = (v) => { try { v ? localStorage.setItem(MARCA, JSON.stringify(v)) : localStorage.removeItem(MARCA); } catch { /* sin almacenamiento */ } };

function revisarCaidaAnterior() {
  const previa = leerMarca();
  if (!previa) return;
  ponerMarca(null);
  const nombre = st?.MODELOS[previa.modelo]?.nombre || previa.modelo;
  const proc = previa.backend === 'cpu' ? 'solo procesador' : 'automático';
  let consejo;
  if (previa.modelo !== 'v3q') {
    $('#modelo').value = 'v3q';
    consejo = 'Dejé elegida la versión liviana.';
  } else if (previa.backend !== 'cpu') {
    $('#backend').value = 'cpu';
    consejo = 'Dejé elegido "Solo procesador", que usa menos memoria.';
  } else {
    consejo = 'Ya estaba en la opción más liviana: avísame en el chat.';
  }
  const caja = $('#aviso');
  caja.textContent = `La última vez la página se cerró mientras preparaba ${nombre} (${proc}), probablemente por falta de memoria. ${consejo} Vuelve a tocar "Preparar voz".`;
  caja.hidden = false;
}

async function prepararVoz() {
  const btn = $('#btn-descargar');
  btn.disabled = true;
  $('#barra').hidden = false;
  $('#aviso').hidden = true;
  try {
    const id = $('#modelo').value;
    if (prueba?.activa && prueba.tipo === 'supertonic') prueba.terminar('cambiaste de voz');
    if (motor) await motor.liberar();
    motor = null;
    habilitarPasos(false);
    const t0 = Date.now();
    ponerMarca({ modelo: id, backend: $('#backend').value });
    motor = await st.Supertonic.cargar(id, {
      backend: $('#backend').value,
      alAvanzar: ({ fase, bytes, totalBytes, archivo }) => {
        $('#barra').value = Math.min(100, (bytes / totalBytes) * 100);
        $('#estado-modelo').textContent = fase === 'preparando'
          ? `Preparando ${archivo}…`
          : `${fase === 'leyendo' ? 'Leyendo del dispositivo' : 'Descargando'}: ${Math.round(bytes / 1e6)} de ${Math.round(totalBytes / 1e6)} MB`;
      },
    });
    $('#estado-modelo').textContent = 'Calentando el motor…';
    await motor.sintetizar('Hola.', 'es', 'F1', { pasos: 2 });
    ponerMarca(null);
    try { await navigator.storage?.persist?.(); } catch { /* opcional */ }
    const nombre = st.MODELOS[id].nombre;
    const backend = motor.backend === 'webgpu' ? 'WebGPU (tarjeta gráfica)' : 'WASM (procesador)';
    $('#estado-modelo').textContent = `Lista: ${nombre} con ${backend}. Tardó ${fmtSeg((Date.now() - t0) / 1000)}.`;
    $('#barra').value = 100;
    habilitarPasos(true);
  } catch (e) {
    ponerMarca(null);
    mostrarError(e);
    $('#estado-modelo').textContent = 'No se pudo preparar la voz. Revisa el error abajo.';
  } finally {
    btn.disabled = false;
  }
}

function habilitarPasos(si) {
  $('#btn-generar').disabled = !si;
  actualizarBotonPrueba();
}

async function borrarDescargas() {
  if (!confirm('¿Borrar las voces descargadas de este dispositivo? Habrá que descargarlas de nuevo para usarlas.')) return;
  if (prueba?.activa && prueba.tipo === 'supertonic') prueba.terminar('borraste las voces');
  await st.borrarDescargas();
  if (motor) await motor.liberar();
  motor = null;
  habilitarPasos(false);
  $('#barra').hidden = true;
  await revisarDescarga();
}

// ---------- Paso 2: escuchar y comparar ----------

function ritmo() {
  return parseFloat($('#ritmo').value);
}

function concatenar(partes, sampleRate, silencio = 0.3) {
  const hueco = Math.floor(silencio * sampleRate);
  const total = partes.reduce((n, p) => n + p.length, 0) + hueco * Math.max(0, partes.length - 1);
  const out = new Float32Array(total);
  let off = 0;
  partes.forEach((p, i) => {
    out.set(p, off);
    off += p.length + (i < partes.length - 1 ? hueco : 0);
  });
  return out;
}

async function generarMuestra() {
  const btn = $('#btn-generar');
  btn.disabled = true;
  const salida = $('#resultado-muestra');
  salida.textContent = 'Generando…';
  try {
    const lang = $('#idioma').value;
    const voz = $('#voz').value;
    const pasos = parseInt($('#calidad').value, 10);
    const trozos = st.trocear($('#texto-muestra').value);
    const t0 = performance.now();
    const partes = [];
    for (const t of trozos) partes.push((await motor.sintetizar(t, lang, voz, { pasos })).pcm);
    const genSeg = (performance.now() - t0) / 1000;
    const pcm = concatenar(partes, motor.sampleRate);
    const audioSeg = pcm.length / motor.sampleRate;
    const audio = $('#audio-muestra');
    audio.src = URL.createObjectURL(st.wavBlob(pcm, motor.sampleRate));
    audio.playbackRate = ritmo();
    audio.play().catch(() => { /* el usuario puede tocar play */ });
    const veces = audioSeg / genSeg;
    salida.textContent = `Generó ${coma(audioSeg)} s de audio en ${coma(genSeg)} s: ${coma(veces)} veces más rápido que escucharlo.`;
    resultadosMuestras.push({ voz, lang, pasos, audioSeg, genSeg, backend: motor.backend, modelo: motor.modeloId });
  } catch (e) {
    mostrarError(e);
    salida.textContent = 'Falló la generación.';
  } finally {
    btn.disabled = false;
  }
}

// Primero las voces de mejor calidad; las voces "de juguete" de Apple al final.
const JUGUETE = /^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley|Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox)\b/;
function puntaje(v) {
  let p = 0;
  if (/premium|mejorada|enhanced|natural|neural/i.test(v.name)) p += 4;
  if (/siri/i.test(v.name)) p += 2;
  if (/-(CL|MX|US|419|AR|CO)$/i.test(v.lang) || /-(US|GB)$/i.test(v.lang)) p += 1;
  if (JUGUETE.test(v.name)) p -= 5;
  return p;
}

function vocesSistema(lang) {
  return speechSynthesis.getVoices()
    .filter((v) => v.lang.toLowerCase().startsWith(lang))
    .sort((a, b) => puntaje(b) - puntaje(a) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
}

function llenarVocesSistema() {
  const sel = $('#voz-sistema');
  const lang = $('#idioma').value;
  const previa = sel.value;
  sel.innerHTML = '';
  for (const v of vocesSistema(lang)) {
    const op = document.createElement('option');
    op.value = v.voiceURI;
    op.textContent = `${v.name} (${v.lang})${v.localService ? '' : ' · en línea'}`;
    sel.append(op);
  }
  if (!sel.options.length) sel.innerHTML = '<option value="">Sin voces del sistema para este idioma</option>';
  if ([...sel.options].some((o) => o.value === previa)) sel.value = previa;
}

function vozSistemaElegida() {
  return speechSynthesis.getVoices().find((v) => v.voiceURI === $('#voz-sistema').value) || null;
}

function hablarSistema() {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance($('#texto-muestra').value);
  const v = vozSistemaElegida();
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = ritmo();
  speechSynthesis.speak(u);
}

// ---------- Paso 3: prueba con Waze (segundo plano) ----------

const audio = () => $('#reproductor');
let prueba = null;

function silencioUrl(seg = 0.5) {
  const sr = 44100;
  return URL.createObjectURL(st ? st.wavBlob(new Float32Array(Math.floor(sr * seg)), sr) : new Blob());
}

class Prueba {
  constructor(tipo) {
    this.tipo = tipo; // 'supertonic' | 'sistema'
    this.trozos = [];
    const base = st.trocear($('#texto-largo').value);
    for (let r = 0; r < 2; r++) this.trozos.push(...base);
    this.lang = $('#idioma').value;
    this.voz = $('#voz').value;
    this.vozSistema = vozSistemaElegida();
    this.pasos = parseInt($('#calidad').value, 10);
    this.ritmo = ritmo();
    this.bufferSeg = 60;
    this.listos = [];
    this.iGen = 0;
    this.iPlay = -1;
    this.esperando = null;
    this.inicioEspera = 0;
    this.eventos = [];
    this.latidos = [];
    this.periodos = [];
    this.activa = false;
    this.erroresGen = 0;
  }

  t() { return (Date.now() - this.t0) / 1000; }

  log(tipo, datos = {}) {
    this.eventos.push({ t: this.t(), oculta: document.hidden, tipo, ...datos });
    const linea = `${coma(this.t(), 1).padStart(7)} s ${document.hidden ? '[oculta] ' : ''}${tipo} ${Object.entries(datos).map(([k, v]) => `${k}=${v}`).join(' ')}`;
    const pre = $('#log');
    pre.textContent = `${linea}\n${pre.textContent}`.slice(0, 20000);
  }

  // Segundos de audio ya generados que quedan por sonar.
  adelante() {
    let s = 0;
    const a = audio();
    if (this.iPlay >= 0 && this.listos[this.iPlay]) s += Math.max(0, this.listos[this.iPlay].seg - a.currentTime);
    for (let j = this.iPlay + 1; j < this.iGen; j++) s += this.listos[j]?.seg || 0;
    return s;
  }

  // Posición total del audio (segundos de contenido ya sonados).
  posicion() {
    if (this.tipo === 'sistema') return this.iPlay + 1;
    let s = 0;
    for (let j = 0; j < this.iPlay; j++) s += this.listos[j]?.seg || 0;
    return s + (this.iPlay >= 0 ? audio().currentTime : 0);
  }

  iniciar() {
    this.t0 = Date.now();
    this.activa = true;
    $('#log').textContent = '';
    $('#resumen').hidden = true;
    $('#btn-copiar').hidden = true;
    this.log('inicio', { motor: this.tipo === 'supertonic' ? `${motor.modeloId}/${motor.backend}/${this.voz}` : (this.vozSistema?.name || 'sistema'), trozos: this.trozos.length });
    this.latido = setInterval(() => { this.latidos.push(Date.now()); this.pintarEstado(); }, 2000);
    this.alVisibilidad = () => {
      if (!this.activa) return;
      if (document.hidden) {
        this.periodos.push({ inicio: Date.now(), pos0: this.posicion(), gen0: this.iGen });
        this.log('app-oculta', { trozo: this.iPlay });
      } else {
        const p = this.periodos.at(-1);
        if (p && !p.fin) { p.fin = Date.now(); p.pos1 = this.posicion(); p.gen1 = this.iGen; }
        this.log('app-visible', { trozo: this.iPlay });
      }
    };
    document.addEventListener('visibilitychange', this.alVisibilidad);
    this.prepararMediaSession();
    if (this.tipo === 'supertonic') {
      this.conectarAudio();
      this.generar();
    } else {
      this.hablar(0);
    }
  }

  prepararMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const titulo = this.tipo === 'supertonic' ? `${st.MODELOS[motor.modeloId].nombre} · ${this.voz}` : 'Voz del sistema';
    ms.metadata = new MediaMetadata({
      title: 'Prueba de voz',
      artist: 'Lector',
      album: titulo,
      artwork: [{ src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
    });
    const manejar = (accion, fn) => {
      try { ms.setActionHandler(accion, () => { this.log(`control-${accion}`); fn(); }); } catch { /* no soportado */ }
    };
    manejar('play', () => audio().play());
    manejar('pause', () => audio().pause());
    manejar('nexttrack', () => this.tipo === 'supertonic' && this.reproducir(this.iPlay + 1));
    manejar('previoustrack', () => this.tipo === 'supertonic' && this.reproducir(Math.max(0, this.iPlay - 1)));
  }

  conectarAudio() {
    const a = audio();
    this.handlers = {
      ended: () => {
        if (!this.activa || this.iPlay === -1) return; // -1: terminó el silencio de desbloqueo
        this.log('fin-trozo', { i: this.iPlay });
        if (this.iPlay + 1 < this.trozos.length) this.reproducir(this.iPlay + 1);
        else this.terminar('completa');
      },
      pause: () => { if (this.activa && !a.ended) this.log('pausa', { i: this.iPlay }); },
      stalled: () => this.activa && this.log('audio-trabado', { i: this.iPlay }),
      error: () => this.activa && this.log('audio-error', { i: this.iPlay, codigo: a.error?.code }),
    };
    for (const [ev, fn] of Object.entries(this.handlers)) a.addEventListener(ev, fn);
  }

  desconectarAudio() {
    const a = audio();
    for (const [ev, fn] of Object.entries(this.handlers || {})) a.removeEventListener(ev, fn);
  }

  reproducir(i) {
    if (!this.activa || i >= this.trozos.length) return;
    const c = this.listos[i];
    if (!c) {
      this.esperando = i;
      this.inicioEspera = Date.now();
      this.log('espera', { i });
      return;
    }
    if (this.esperando === i && i > 0) this.log('reanuda', { i, espera: coma((Date.now() - this.inicioEspera) / 1000) });
    this.esperando = null;
    this.iPlay = i;
    const a = audio();
    a.src = c.url;
    a.defaultPlaybackRate = this.ritmo;
    a.playbackRate = this.ritmo;
    a.play()
      .then(() => this.log('suena', { i }))
      .catch((e) => this.log(e.name === 'AbortError' ? 'play-reemplazado' : 'play-error', { i, error: e.name }));
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  }

  async generar() {
    while (this.activa && this.iGen < this.trozos.length) {
      if (this.iPlay >= 0 && this.adelante() > this.bufferSeg) { await esperar(1000); continue; }
      const i = this.iGen;
      const ocultaAlInicio = document.hidden;
      const t = Date.now();
      try {
        const r = await motor.sintetizar(this.trozos[i], this.lang, this.voz, { pasos: this.pasos });
        if (!this.activa) return;
        const genSeg = (Date.now() - t) / 1000;
        this.listos[i] = {
          url: URL.createObjectURL(st.wavBlob(r.pcm, motor.sampleRate, 0.25)),
          seg: r.segundos + 0.25,
          genSeg,
          oculta: ocultaAlInicio || document.hidden,
        };
        this.iGen++;
        this.log('generado', { i, seg: coma(r.segundos), tardo: coma(genSeg, 2) });
        if (this.esperando === i || (i === 0 && this.iPlay === -1)) this.reproducir(i);
      } catch (e) {
        this.erroresGen++;
        this.log('gen-error', { i, error: e?.message || String(e) });
        if (this.erroresGen >= 3) return this.terminar('errores de generación');
        await esperar(2000);
      }
    }
  }

  hablar(i) {
    if (!this.activa) return;
    if (i >= this.trozos.length) return this.terminar('completa');
    const u = new SpeechSynthesisUtterance(this.trozos[i]);
    if (this.vozSistema) { u.voice = this.vozSistema; u.lang = this.vozSistema.lang; }
    u.rate = this.ritmo;
    u.onstart = () => this.log('voz-empieza', { i });
    u.onend = () => { this.iPlay = i; this.log('voz-termina', { i }); this.hablar(i + 1); };
    u.onerror = (e) => this.log('voz-error', { i, error: e.error });
    speechSynthesis.speak(u);
  }

  pintarEstado() {
    if (!this.activa) return;
    const total = this.trozos.length;
    if (this.tipo === 'supertonic') {
      const espera = this.esperando !== null && this.iPlay >= 0 ? ' · esperando que se genere el siguiente' : '';
      $('#estado-prueba').textContent = `${fmtSeg(this.t())} · sonando ${this.iPlay + 1} de ${total} · ${fmtSeg(this.adelante())} generados por delante${espera}`;
    } else {
      $('#estado-prueba').textContent = `${fmtSeg(this.t())} · voz del sistema, frase ${this.iPlay + 2} de ${total}`;
    }
  }

  terminar(motivo) {
    if (!this.activa) return;
    const p = this.periodos.at(-1);
    if (p && !p.fin) { p.fin = Date.now(); p.pos1 = this.posicion(); p.gen1 = this.iGen; }
    this.log('fin', { motivo });
    this.activa = false;
    this.motivo = motivo;
    clearInterval(this.latido);
    document.removeEventListener('visibilitychange', this.alVisibilidad);
    if (this.tipo === 'supertonic') {
      this.desconectarAudio();
      audio().pause();
    } else {
      speechSynthesis.cancel();
    }
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    const texto = this.resumen();
    $('#resumen').textContent = texto;
    $('#resumen').hidden = false;
    $('#btn-copiar').hidden = false;
    $('#estado-prueba').textContent = `Prueba terminada (${motivo}).`;
    actualizarBotonPrueba();
  }

  resumen() {
    const L = [];
    const fecha = new Date(this.t0).toLocaleString('es-CL');
    L.push('PRUEBA DE SEGUNDO PLANO · Lector');
    L.push(`Fecha: ${fecha}`);
    L.push(`Equipo: ${lineaEquipo()}`);
    if (this.tipo === 'supertonic') {
      L.push(`Motor: ${st.MODELOS[motor.modeloId].nombre} · ${motor.backend} · voz ${this.voz} · ${this.pasos} pasos · ritmo ${this.ritmo}x`);
    } else {
      L.push(`Motor: voz del sistema (${this.vozSistema ? `${this.vozSistema.name}, ${this.vozSistema.lang}` : 'por defecto'}) · ritmo ${this.ritmo}x`);
    }
    L.push(`Duración: ${fmtSeg(this.t())} · terminó: ${this.motivo}`);

    if (this.tipo === 'supertonic') {
      const gen = this.listos.filter(Boolean);
      const vel = (arr) => {
        const a = arr.reduce((n, c) => n + c.seg, 0);
        const g = arr.reduce((n, c) => n + c.genSeg, 0);
        return g ? `${coma(a / g)}x` : 'sin datos';
      };
      L.push(`Generación: ${gen.length} de ${this.trozos.length} trozos · velocidad ${vel(gen)} tiempo real (visible ${vel(gen.filter((c) => !c.oculta))} · oculta ${vel(gen.filter((c) => c.oculta))})`);
    }

    const ocultaTotal = this.periodos.reduce((n, p) => n + ((p.fin || Date.now()) - p.inicio) / 1000, 0);
    L.push(`App oculta: ${this.periodos.length} ${this.periodos.length === 1 ? 'vez' : 'veces'} · ${fmtSeg(ocultaTotal)} en total`);
    this.periodos.forEach((p, k) => {
      const dur = ((p.fin || Date.now()) - p.inicio) / 1000;
      const lat = this.latidos.filter((x) => x >= p.inicio && x <= (p.fin || Date.now()));
      let maxHueco = 0;
      let prev = p.inicio;
      for (const x of [...lat, p.fin || Date.now()]) { maxHueco = Math.max(maxHueco, (x - prev) / 1000); prev = x; }
      if (this.tipo === 'supertonic') {
        const avanzo = (p.pos1 - p.pos0) / this.ritmo;
        L.push(`  ${k + 1}) ${fmtSeg(dur)} oculta: el audio avanzó ${fmtSeg(avanzo)} (${Math.round((avanzo / Math.max(dur, 1)) * 100)} %) · trozos generados oculta: ${p.gen1 - p.gen0} · máx. ${coma(maxHueco, 0)} s sin latido`);
      } else {
        L.push(`  ${k + 1}) ${fmtSeg(dur)} oculta: frases dichas ${p.pos1 - p.pos0} · máx. ${coma(maxHueco, 0)} s sin latido`);
      }
    });

    const cuenta = (tipo) => this.eventos.filter((e) => e.tipo === tipo).length;
    const esperas = this.eventos.filter((e) => e.tipo === 'reanuda');
    const segEspera = esperas.reduce((n, e) => n + parseFloat(String(e.espera).replace(',', '.')), 0);
    L.push(`Esperas por generación: ${cuenta('espera')} (${coma(segEspera)} s en total, sin contar el arranque)`);
    L.push(`Pausas (incluye las tuyas): ${cuenta('pausa')} · errores de audio: ${cuenta('audio-error') + cuenta('play-error')} · errores de generación: ${cuenta('gen-error')} · errores de voz: ${cuenta('voz-error')}`);
    L.push('');
    L.push('Registro (más reciente arriba, máx. 80 líneas):');
    L.push(...$('#log').textContent.split('\n').slice(0, 80));
    return L.join('\n');
  }
}

function actualizarBotonPrueba() {
  const btn = $('#btn-prueba');
  const tipo = $('#motor-prueba').value;
  if (prueba?.activa) {
    btn.textContent = 'Detener prueba';
    btn.disabled = false;
  } else {
    btn.textContent = 'Empezar prueba';
    btn.disabled = tipo === 'supertonic' && !motor;
  }
}

function alternarPrueba() {
  if (prueba?.activa) {
    prueba.terminar('detenida por ti');
    return;
  }
  const tipo = $('#motor-prueba').value;
  if (tipo === 'supertonic') {
    // iOS solo deja reproducir audio si el primer play() ocurre dentro del toque.
    const a = audio();
    a.src = silencioUrl(0.5);
    a.play().catch(() => { /* se reintenta al tener el primer trozo */ });
  } else {
    speechSynthesis.cancel();
  }
  prueba = new Prueba(tipo);
  prueba.iniciar();
  actualizarBotonPrueba();
}

async function copiarResumen() {
  const texto = $('#resumen').textContent;
  try {
    await navigator.clipboard.writeText(texto);
    $('#btn-copiar').textContent = 'Copiado ✓';
  } catch {
    const r = document.createRange();
    r.selectNodeContents($('#resumen'));
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    $('#btn-copiar').textContent = 'Texto seleccionado: cópialo';
  }
  setTimeout(() => { $('#btn-copiar').textContent = 'Copiar resultados'; }, 3000);
}

// ---------- Arranque ----------

async function iniciar() {
  $('#texto-muestra').value = MUESTRAS.es;
  $('#texto-largo').value = TEXTO_LARGO;
  await detectarEquipo();

  $('#idioma').addEventListener('change', () => {
    const lang = $('#idioma').value;
    const actual = $('#texto-muestra').value.trim();
    if (Object.values(MUESTRAS).includes(actual)) $('#texto-muestra').value = MUESTRAS[lang];
    llenarVocesSistema();
  });
  $('#ritmo').addEventListener('change', () => {
    $('#audio-muestra').playbackRate = ritmo();
    if (prueba?.activa && prueba.tipo === 'supertonic') { prueba.ritmo = ritmo(); audio().playbackRate = prueba.ritmo; }
  });
  $('#modelo').addEventListener('change', revisarDescarga);
  $('#btn-descargar').addEventListener('click', prepararVoz);
  $('#btn-borrar').addEventListener('click', borrarDescargas);
  $('#btn-generar').addEventListener('click', generarMuestra);
  $('#btn-sistema').addEventListener('click', hablarSistema);
  $('#motor-prueba').addEventListener('change', actualizarBotonPrueba);
  $('#btn-prueba').addEventListener('click', alternarPrueba);
  $('#btn-copiar').addEventListener('click', copiarResumen);

  llenarVocesSistema();
  speechSynthesis.addEventListener?.('voiceschanged', llenarVocesSistema);

  try {
    st = await import('./supertonic.js?v=5');
    const sel = $('#voz');
    for (const [codigo, nombre] of st.VOCES) {
      const op = document.createElement('option');
      op.value = codigo;
      op.textContent = nombre;
      sel.append(op);
    }
    $('#btn-descargar').disabled = false;
    revisarCaidaAnterior();
    await revisarDescarga();
  } catch (e) {
    mostrarError(e);
    $('#estado-modelo').textContent = 'No se pudo cargar el motor de voz (¿sin internet?).';
  }
  actualizarBotonPrueba();
}

iniciar();
