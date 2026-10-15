// Reproductor: genera la voz oración por oración un poco por delante de lo que suena y la
// junta en bloques continuos de ~1 minuto (así no hay un cambio de archivo entre oraciones,
// solo uno por bloque, en un fin de párrafo). Suena en un solo elemento <audio>, así sigue
// con otra app en pantalla, y avisa qué oración está sonando para resaltarla y guardarla.

import { cargarMotor, motorListo, reiniciarMotor } from './voz.js?v=5';
import { actualizarDoc } from './db.js?v=1';
import { anotar } from './registro.js?v=2';

const BUFFER_SEG = 150;          // segundos de audio generados por delante
const MAX_ADELANTE = 100;        // oraciones generadas por delante, como tope
const HISTORIA = 20;             // oraciones ya escuchadas que se guardan para retroceder rápido
const BLOQUE_MIN_SEG = 60;       // un bloque termina en el primer fin de párrafo después de esto…
const BLOQUE_MAX_SEG = 150;      // …o en el primer fin de oración después de esto
const PAUSA_FIN_BLOQUE = 0.1;    // el cambio de un bloque al siguiente ya agrega su propia pausa
// La voz trae ~0,6 s de silencio al comienzo y al final de cada oración: se recorta y se
// pone una pausa propia, natural y pareja.
const UMBRAL_VOZ = 0.01;         // ~ -40 dB: por debajo es silencio
const MARGEN_ANTES = 0.05;
const MARGEN_DESPUES = 0.1;
const PAUSA_ORACION = 0.2;
const PAUSA_PARRAFO = 0.55;
const PAUSA_CORTE = 0.04;        // una oración larga partida en una coma o entre palabras
const SALTO_SEG = 15;            // botones 15− y 15+
const CARACTERES_POR_SEG = 15;   // ritmo de la voz a 1x, para estimar oraciones aún no generadas

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Fallos de la tarjeta gráfica a mitad de una generación (en el iPhone pasa al volver de
// otra app o por memoria). Se distinguen de errores del texto o de la descarga.
const esFalloGpu = (e) => /OrtRun|MapAsync|map async|webgpu|wgpu|device lost|GPUDevice/i.test(e?.message || String(e));

// WAV PCM 16 bits mono.
function wav(int16, sampleRate) {
  const buf = new ArrayBuffer(44 + int16.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + int16.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, int16.length * 2, true);
  new Int16Array(buf, 44).set(int16);
  return new Blob([buf], { type: 'audio/wav' });
}

// Medio segundo de silencio, para desbloquear el audio en el mismo toque.
const silencioUrl = () => URL.createObjectURL(wav(new Int16Array(22050), 44100));

// Quita el silencio del comienzo y del final (buscando en ventanas de 10 ms) y pasa a 16 bits.
function recortar(pcm, sr) {
  const ventana = Math.max(1, Math.floor(sr * 0.01));
  const hayVoz = (desde) => {
    for (let j = desde; j < Math.min(pcm.length, desde + ventana); j++) if (Math.abs(pcm[j]) > UMBRAL_VOZ) return true;
    return false;
  };
  let a = 0;
  while (a < pcm.length && !hayVoz(a)) a += ventana;
  let b = pcm.length - ventana;
  while (b > a && !hayVoz(b)) b -= ventana;
  const ini = a >= pcm.length ? 0 : Math.max(0, a - Math.floor(MARGEN_ANTES * sr));
  const fin = a >= pcm.length ? pcm.length : Math.min(pcm.length, b + ventana + Math.floor(MARGEN_DESPUES * sr));
  const out = new Int16Array(fin - ini);
  for (let j = ini; j < fin; j++) out[j - ini] = Math.max(-1, Math.min(1, pcm[j])) * 32767;
  return out;
}

export class Reproductor extends EventTarget {
  constructor(audio) {
    super();
    this.audio = audio;
    this.doc = null;
    this.contenido = null;
    this.ajustes = null;
    this.actual = 0;            // oración que suena (o sonará al dar play)
    this.bloque = null;         // bloque cargado en el <audio>: { ini, fin, url, offsets, dur }
    this.sonando = false;       // lo que quiere el usuario
    this.generando = false;
    this.epoca = 0;             // cambia cuando cambia la voz: invalida lo generado
    this.listos = new Map();    // oración -> { pcm: Int16Array, pausa, seg }
    this.sr = 44100;
    this.velocidad = 1;
    this.finParrafo = new Set();
    this.temporizador = null;
    this.silencio = silencioUrl();
    this.ignorarPausaHasta = 0;
    this.respaldoCpu = false;   // la gráfica falló: se genera con el procesador hasta volver a la app
    this.reintentos = new Set(); // bloques que ya se rehicieron una vez por no poder sonar
    this.espera = null;         // { tipo: 'arranque' | 'corte' | 'salto' | 'ajuste' | 'reintento', t }
    this.metrica = { n: 0, audio: 0, gen: 0, backend: '' };

    audio.addEventListener('ended', () => this.#alTerminar());
    audio.addEventListener('timeupdate', () => this.#seguirPosicion());
    audio.addEventListener('seeked', () => this.#seguirPosicion());
    audio.addEventListener('pause', () => {
      // Pausa del sistema (llamada, otra app, controles de la pantalla bloqueada).
      // Las pausas que provoca el propio reproductor al cambiar de audio se ignoran.
      if (audio.ended || !this.sonando || performance.now() < this.ignorarPausaHasta) return;
      this.sonando = false;
      anotar('pausa', { motivo: 'sistema', oracion: this.actual }, { urgente: true });
      this.#estado('pausa');
      this.guardarYa();
    });
    audio.addEventListener('play', () => {
      if (!this.sonando && this.bloque) {
        this.sonando = true;
        anotar('play', { motivo: 'sistema', oracion: this.actual });
        this.#estado('sonando');
        this.#llenar();
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.guardarYa(); });

    // Cada minuto, una línea en el registro: cuánto se generó, con qué y cuánto queda por delante.
    setInterval(() => {
      const m = this.metrica;
      if (!this.sonando && !m.n) return;
      anotar('minuto', {
        sonando: this.sonando ? 1 : 0,
        oracion: this.actual,
        generadas: m.n,
        audio: Math.round(m.audio * 10) / 10,
        gen: Math.round(m.gen * 10) / 10,
        backend: m.backend || (this.respaldoCpu ? 'wasm' : ''),
        adelante: Math.round(this.#segundosAdelante()),
      });
      this.metrica = { n: 0, audio: 0, gen: 0, backend: '' };
    }, 60000);
  }

  get total() { return this.contenido?.oraciones.length || 0; }

  abrir(doc, contenido, ajustes) {
    this.pausar();
    this.#soltarBloque();
    this.listos.clear();
    this.doc = doc;
    this.contenido = contenido;
    this.ajustes = ajustes;
    this.velocidad = ajustes.velocidad || 1;
    this.actual = Math.max(0, Math.min(doc.oracion || 0, this.total - 1));
    this.cambioPosicion = doc.progresoT || 0;
    this.reintentos = new Set();
    this.finParrafo = new Set(contenido.parrafos.slice(1).map((p) => p - 1));
    this.finParrafo.add(this.total - 1);
    this.fallosGpu = 0;
    this.#mediaSession();
    this.#emitir('oracion', this.actual);
  }

  // La app volvió a la pantalla: si se estaba usando el procesador de respaldo, se vuelve a
  // la tarjeta gráfica (los fallos suelen pasar con la app en segundo plano).
  volverAGrafica() {
    if (!this.respaldoCpu) return;
    this.respaldoCpu = false;
    this.fallosGpu = 0;
    anotar('vuelve-gpu', {}, { urgente: true });
  }

  cerrar() {
    this.pausar();
    this.#soltarBloque();
    this.listos.clear();
    this.doc = null;
    this.contenido = null;
  }

  // Para cuando hay que esperar algo (abrir el documento) antes de dar play: se llama
  // en el mismo toque y deja el audio habilitado para el play() que viene después.
  desbloquear() {
    if (this.sonando) return;
    this.#cambiarFuente(this.silencio, null);
    this.audio.play().catch(() => { /* basta con el intento dentro del toque */ });
  }

  // Debe llamarse dentro de un toque y sin esperas antes del primer play():
  // iOS solo deja reproducir audio si ocurre en el mismo instante del toque.
  play() {
    if (!this.doc) return;
    if (this.bloque && this.bloque.fin >= this.total - 1 && this.audio.ended) {
      this.#soltarBloque();
      this.actual = 0;
    }
    this.sonando = true;
    anotar('play', { motivo: 'tú', oracion: this.actual });
    if (this.#bloqueCubre(this.actual) && !this.audio.ended) {
      this.audio.play().catch((e) => this.#falloAlSonar(e));
      this.#estado('sonando');
      this.#llenar();
      return;
    }
    // Desbloquea el audio con un silencio mientras se genera la primera oración.
    this.espera = { tipo: 'arranque', t: Date.now() };
    this.#cambiarFuente(this.silencio, null);
    this.audio.play().catch(() => { /* se reintenta con el primer bloque */ });
    if (this.listos.has(this.actual)) this.#sonarDesde(this.actual);
    else this.#estado(this.#motorListo() ? 'generando' : 'cargando-voz');
    this.#llenar();
  }

  pausar() {
    if (!this.sonando) return;
    this.sonando = false;
    this.espera = null;
    anotar('pausa', { motivo: 'tú', oracion: this.actual });
    this.#silenciarPausa();
    this.audio.pause();
    this.#estado('pausa');
    this.guardarYa();
  }

  alternar() {
    return this.sonando ? this.pausar() : this.play();
  }

  // Otro dispositivo avanzó más (llegó por la sincronización). Solo si aquí no está sonando.
  posicionarDesdeSync(i, cuando) {
    if (!this.doc || this.sonando) return;
    this.actual = Math.max(0, Math.min(i, this.total - 1));
    this.cambioPosicion = cuando;
    if (!this.#bloqueCubre(this.actual)) this.#soltarBloque();
    else this.audio.currentTime = this.#offset(this.actual);
    this.#emitir('oracion', this.actual);
  }

  // Ir a una oración (tocarla en el texto, cambiar de sección, saltos largos).
  irA(i, desplazamiento = 0) {
    if (!this.doc) return;
    i = Math.max(0, Math.min(i, this.total - 1));
    this.actual = i;
    this.cambioPosicion = Date.now();
    if (this.#bloqueCubre(i)) {
      // Dentro del bloque que ya suena: se mueve al instante, sin regenerar nada.
      this.audio.currentTime = this.#offset(i) + desplazamiento;
      this.#emitir('oracion', i);
      if (this.sonando && this.audio.paused) this.audio.play().catch((e) => this.#falloAlSonar(e));
    } else if (this.sonando) {
      if (this.listos.has(i)) this.#sonarDesde(i);
      else {
        this.espera = { tipo: 'salto', t: Date.now() };
        this.#silenciarPausa();
        this.audio.pause();
        this.#soltarBloque();
        this.#estado('generando');
        this.#emitir('oracion', i);
        this.#llenar();
      }
    } else {
      this.#soltarBloque();
      this.#emitir('oracion', i);
    }
    this.#podar();
    this.#guardarPronto();
  }

  siguiente() { this.irA(this.actual + 1); }

  anterior() {
    if (this.#bloqueCubre(this.actual) && this.audio.currentTime - this.#offset(this.actual) > 2) this.irA(this.actual);
    else this.irA(this.actual - 1);
  }

  // Saltos de 15 segundos, como en los podcasts. Dentro del bloque cargado es exacto e
  // instantáneo; fuera de él va al comienzo de la oración donde cae (sin cortar una frase).
  retroceder(seg = SALTO_SEG) {
    if (!this.doc) return;
    const b = this.bloque;
    if (b && this.#bloqueCubre(this.actual)) {
      const t = this.audio.currentTime - seg;
      if (t >= 0) {
        this.audio.currentTime = t;
        this.#seguirPosicion();
        return;
      }
      this.#retrocederDesde(b.ini, -t);
      return;
    }
    this.#retrocederDesde(this.actual, seg);
  }

  avanzar(seg = SALTO_SEG) {
    if (!this.doc) return;
    const b = this.bloque;
    if (b && this.#bloqueCubre(this.actual)) {
      const t = this.audio.currentTime + seg;
      if (t < b.dur - 0.3) {
        this.audio.currentTime = t;
        this.#seguirPosicion();
        return;
      }
      this.#avanzarDesde(b.fin + 1, t - b.dur);
      return;
    }
    this.#avanzarDesde(this.actual + 1, seg - this.#duracion(this.actual));
  }

  cambiarVelocidad(v) {
    this.velocidad = v;
    this.audio.defaultPlaybackRate = v;
    this.audio.playbackRate = v;
  }

  // Cambió la voz, la calidad o el idioma: lo generado ya no sirve.
  cambiarAjustes(ajustes, idioma) {
    this.ajustes = ajustes;
    if (idioma && this.doc) this.doc = { ...this.doc, idioma };
    this.cambiarVelocidad(ajustes.velocidad || this.velocidad);
    this.epoca++;
    this.listos.clear();
    if (this.sonando) {
      this.espera = { tipo: 'ajuste', t: Date.now() };
      this.#silenciarPausa();
      this.audio.pause();
      this.#soltarBloque();
      this.#estado(this.#motorListo() ? 'generando' : 'cargando-voz');
      this.#llenar();
    } else {
      this.#soltarBloque();
    }
  }

  guardarYa() {
    clearTimeout(this.temporizador);
    this.temporizador = null;
    if (!this.doc) return Promise.resolve();
    // progresoT es cuándo cambió la posición (no cuándo se guardó): así la sincronización
    // no pisa con una posición vieja la que avanzó otro dispositivo.
    return actualizarDoc(this.doc.id, { oracion: this.actual, abierto: Date.now(), progresoT: this.cambioPosicion || 0 }).catch(() => {});
  }

  // ---------- interno ----------

  // Con el procesador de respaldo se baja a calidad media para que alcance a generar a tiempo.
  #backendEfectivo() {
    return this.respaldoCpu ? 'cpu' : this.ajustes.backend;
  }

  #pasosEfectivos() {
    return this.respaldoCpu ? Math.min(this.ajustes.pasos, 5) : this.ajustes.pasos;
  }

  #motorListo() {
    return !!(this.ajustes && motorListo(this.ajustes.modelo, this.#backendEfectivo()));
  }

  #silenciarPausa() {
    this.ignorarPausaHasta = performance.now() + 500;
  }

  #bloqueCubre(i) {
    const b = this.bloque;
    return !!b && this.audio.src === b.url && i >= b.ini && i <= b.fin;
  }

  #offset(i) {
    return this.bloque.offsets[i - this.bloque.ini];
  }

  #cambiarFuente(url, bloque) {
    this.#silenciarPausa();
    const anterior = this.bloque;
    this.bloque = bloque;
    this.audio.src = url;
    if (anterior && anterior.url !== url) URL.revokeObjectURL(anterior.url);
  }

  #soltarBloque() {
    if (!this.bloque) return;
    const url = this.bloque.url;
    this.bloque = null;
    if (this.audio.src === url) {
      this.#silenciarPausa();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    URL.revokeObjectURL(url);
  }

  #guardarPronto() {
    if (!this.temporizador) this.temporizador = setTimeout(() => this.guardarYa(), 1500);
  }

  #emitir(tipo, detalle) {
    this.dispatchEvent(new CustomEvent(tipo, { detail: detalle }));
  }

  #estado(e) {
    this.estadoActual = e;
    this.#emitir('estado', e);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = e === 'pausa' || e === 'fin' ? 'paused' : 'playing';
    }
  }

  // Primer fallo seguido de la gráfica: se recarga el motor. Segundo: se usa el procesador
  // como respaldo hasta que la app vuelva a la pantalla (ver volverAGrafica).
  #falloGpu(e, cuando) {
    this.fallosGpu++;
    console.warn('Falló la tarjeta gráfica', cuando, e);
    anotar('fallo-gpu', { n: this.fallosGpu, cuando, msg: String(e?.message || e).slice(0, 120) }, { urgente: true });
    if (this.fallosGpu >= 2 && !this.respaldoCpu) {
      this.respaldoCpu = true;
      anotar('respaldo-cpu', { pasos: this.#pasosEfectivos() }, { urgente: true });
      this.#emitir('aviso', 'La tarjeta gráfica falló. Sigo con el procesador hasta que vuelvas a la app.');
    }
    if (!this.bloque) this.#estado('cargando-voz');
  }

  // `donde`: en qué parte falló (cargar, generar, sonar, ciclo), para el registro del viaje.
  #fallo(e, donde = '') {
    if (e?.name === 'AbortError') return;
    anotar('error', { donde, nombre: e?.name || '', msg: String(e?.message || e).slice(0, 160) }, { urgente: true });
    this.sonando = false;
    this.espera = null;
    this.#estado('pausa');
    this.#emitir('error', e);
  }

  // Un bloque que no se pudo reproducir ("The operation is not supported"): se rehace una
  // vez desde la oración actual en vez de detener la lectura.
  #falloAlSonar(e) {
    if (e?.name === 'AbortError') return;
    const clave = this.bloque?.ini ?? this.actual;
    if (e?.name !== 'NotSupportedError' || this.reintentos.has(clave)) {
      this.#fallo(e, 'sonar');
      return;
    }
    this.reintentos.add(clave);
    anotar('audio-reintento', { oracion: this.actual, msg: String(e?.message || e).slice(0, 80) }, { urgente: true });
    this.#soltarBloque();
    if (!this.sonando) return;
    this.espera = { tipo: 'reintento', t: Date.now() };
    if (this.listos.has(this.actual)) this.#sonarDesde(this.actual);
    else {
      this.#estado('generando');
      this.#llenar();
    }
  }

  // Junta en un solo audio las oraciones ya generadas desde `ini`, hasta un fin de párrafo
  // pasados BLOQUE_MIN_SEG (o un fin de oración pasados BLOQUE_MAX_SEG).
  #armarBloque(ini) {
    const partes = [];
    const offsets = [];
    let t = 0;
    let i = ini;
    while (i < this.total && this.listos.has(i)) {
      const c = this.listos.get(i);
      offsets.push(t);
      partes.push(c);
      t += c.seg;
      const cierra = this.finParrafo.has(i);
      i++;
      if ((t >= BLOQUE_MIN_SEG && cierra) || t >= BLOQUE_MAX_SEG) break;
    }
    if (!partes.length) return null;
    const pausas = partes.map((c, k) => (k === partes.length - 1 ? Math.min(c.pausa, PAUSA_FIN_BLOQUE) : c.pausa));
    const total = partes.reduce((n, c, k) => n + c.pcm.length + Math.round(pausas[k] * this.sr), 0);
    const datos = new Int16Array(total); // los ceros son las pausas
    let off = 0;
    partes.forEach((c, k) => {
      datos.set(c.pcm, off);
      off += c.pcm.length + Math.round(pausas[k] * this.sr);
    });
    const dur = t - partes.at(-1).pausa + pausas.at(-1);
    return { ini, fin: i - 1, url: URL.createObjectURL(wav(datos, this.sr)), offsets, dur };
  }

  // Empieza a sonar un bloque nuevo desde la oración `i` (que ya está generada).
  #sonarDesde(i) {
    const b = this.#armarBloque(i);
    if (!b) return;
    this.actual = i;
    this.cambioPosicion = Date.now();
    this.#emitir('oracion', i);
    this.#guardarPronto();
    if (this.espera) {
      const seg = Math.round((Date.now() - this.espera.t) / 100) / 10;
      anotar(this.espera.tipo === 'corte' ? 'corte-fin' : this.espera.tipo, { oracion: i, seg }, { urgente: this.espera.tipo === 'corte' });
      this.espera = null;
    }
    anotar('bloque', { desde: b.ini, hasta: b.fin, seg: Math.round(b.dur) });
    this.#cambiarFuente(b.url, b);
    this.audio.defaultPlaybackRate = this.velocidad;
    this.audio.playbackRate = this.velocidad;
    this.audio.play().catch((e) => this.#falloAlSonar(e));
    this.#estado('sonando');
    this.#mediaSession();
    this.#podar();
    this.#llenar();
  }

  // Qué oración está sonando según el segundo exacto del bloque.
  #seguirPosicion() {
    const b = this.bloque;
    if (!b || this.audio.src !== b.url) return;
    const t = this.audio.currentTime;
    let k = b.offsets.length - 1;
    while (k > 0 && b.offsets[k] > t + 0.05) k--;
    const i = b.ini + k;
    if (i === this.actual) return;
    this.actual = i;
    this.cambioPosicion = Date.now();
    this.#emitir('oracion', i);
    this.#guardarPronto();
    this.#mediaSession();
    this.#podar();
  }

  #alTerminar() {
    if (!this.sonando) return;
    const b = this.bloque;
    if (!b) {
      // Terminó el silencio de desbloqueo: suena apenas esté lista la oración actual.
      if (this.listos.has(this.actual)) this.#sonarDesde(this.actual);
      return;
    }
    const sig = b.fin + 1;
    if (sig >= this.total) {
      this.sonando = false;
      this.actual = b.fin;
      anotar('fin-documento', { oracion: b.fin });
      this.#estado('fin');
      this.guardarYa();
      return;
    }
    if (this.listos.has(sig)) {
      this.#sonarDesde(sig);
      return;
    }
    // Un corte: terminó el bloque y la oración siguiente aún no está generada.
    this.espera = { tipo: 'corte', t: Date.now() };
    anotar('corte-inicio', { oracion: sig, backend: this.respaldoCpu ? 'wasm' : this.metrica.backend || '' }, { urgente: true });
    this.#soltarBloque();
    this.actual = sig;
    this.#emitir('oracion', sig);
    this.#estado('generando');
    this.#llenar();
  }

  #retrocederDesde(i, falta) {
    while (i > 0 && falta > 0) {
      i--;
      falta -= this.#duracion(i);
    }
    this.irA(i);
  }

  #avanzarDesde(i, falta) {
    while (i < this.total - 1 && falta > this.#duracion(i)) {
      falta -= this.#duracion(i);
      i++;
    }
    this.irA(Math.min(i, this.total - 1));
  }

  // Duración de una oración: la real si ya está generada; si no, estimada por su largo.
  #duracion(i) {
    const c = this.listos.get(i);
    if (c) return c.seg;
    const largo = this.contenido?.oraciones[i]?.length || 0;
    return largo / CARACTERES_POR_SEG + this.#pausa(i);
  }

  #pausa(i) {
    if (this.finParrafo.has(i)) return PAUSA_PARRAFO;
    return /[.!?…:;]["'»”’)\]]*$/.test(this.contenido.oraciones[i] || '') ? PAUSA_ORACION : PAUSA_CORTE;
  }

  #segundosAdelante() {
    let s = 0;
    let desde = this.actual;
    if (this.#bloqueCubre(this.actual)) {
      s += Math.max(0, this.bloque.dur - this.audio.currentTime);
      desde = this.bloque.fin + 1;
    }
    for (let i = desde; i < desde + MAX_ADELANTE && this.listos.has(i); i++) s += this.listos.get(i).seg;
    return s;
  }

  #siguienteSinGenerar() {
    const desde = this.#bloqueCubre(this.actual) ? this.bloque.fin + 1 : this.actual;
    for (let i = desde; i < Math.min(this.total, this.actual + MAX_ADELANTE + 1); i++) {
      if (!this.listos.has(i)) return i;
    }
    return null;
  }

  async #llenar() {
    if (this.generando) return; // el ciclo que ya corre toma la nueva posición
    this.generando = true;
    try {
      while (this.sonando && this.doc) {
        this.#seguirPosicion(); // con la app oculta, timeupdate puede no llegar
        const i = this.#siguienteSinGenerar();
        if (i == null || (i > this.actual && this.#segundosAdelante() > BUFFER_SEG)) {
          await esperar(700);
          continue;
        }
        const epoca = this.epoca;
        const { modelo, voz } = this.ajustes;
        const backend = this.#backendEfectivo();
        const pasos = this.#pasosEfectivos();
        let motor;
        try {
          const t0 = Date.now();
          const listo = motorListo(modelo, backend);
          motor = await cargarMotor({ modelo, backend }, (p) => this.#emitir('voz', p));
          if (!listo) {
            anotar('motor-cargado', {
              backend: motor.backend,
              seg: Math.round((Date.now() - t0) / 100) / 10,
              ...(motor.motivoWasm ? { sinGrafica: motor.motivoWasm.slice(0, 100) } : {}),
            });
          }
        } catch (e) {
          // Recargar el motor también prueba la gráfica: si sigue caída, cuenta como otro fallo.
          if (backend !== 'cpu' && esFalloGpu(e)) {
            this.#falloGpu(e, 'al cargar');
            await esperar(500);
            continue;
          }
          this.#fallo(e, 'cargar');
          return;
        }
        let r;
        const tGen = Date.now();
        try {
          r = await motor.sintetizar(this.contenido.oraciones[i], this.doc.idioma, voz, { pasos });
        } catch (e) {
          if (epoca !== this.epoca || !this.doc) continue;
          // Se soltó el motor para cargar otro (cambio de voz, respaldo): se usa el nuevo.
          if (e?.name === 'MotorLiberado') continue;
          if (!esFalloGpu(e) || motor.backend !== 'webgpu') { this.#fallo(e, 'generar'); return; }
          this.#falloGpu(e, 'al generar');
          await reiniciarMotor();
          continue;
        }
        if (motor.backend === 'webgpu') this.fallosGpu = 0; // el respaldo es para fallos seguidos
        if (epoca !== this.epoca || !this.doc) continue;
        this.sr = motor.sampleRate;
        const pcm = recortar(r.pcm, this.sr);
        const pausa = this.#pausa(i);
        this.listos.set(i, { pcm, pausa, seg: pcm.length / this.sr + pausa });
        this.metrica.n++;
        this.metrica.audio += pcm.length / this.sr;
        this.metrica.gen += (Date.now() - tGen) / 1000;
        this.metrica.backend = motor.backend;
        // Si se estaba esperando esta oración (al partir, tras un salto o un corte), suena ya.
        if (this.sonando && i === this.actual && !this.#bloqueCubre(i)) this.#sonarDesde(i);
      }
    } catch (e) {
      this.#fallo(e, 'ciclo');
    } finally {
      this.generando = false;
    }
  }

  // Suelta el audio de oraciones muy atrás o muy adelante de la posición actual.
  #podar() {
    for (const i of this.listos.keys()) {
      if (i < this.actual - HISTORIA || i > this.actual + MAX_ADELANTE + 5) this.listos.delete(i);
    }
  }

  #mediaSession() {
    if (!('mediaSession' in navigator) || !this.doc) return;
    const ms = navigator.mediaSession;
    const seccion = this.seccionActual?.() || '';
    // Solo cuando cambia la sección: rehacerlo en cada oración hace parpadear la pantalla bloqueada.
    const clave = `${this.doc.id}|${seccion}`;
    if (clave !== this.metaActual) {
      this.metaActual = clave;
      ms.metadata = new MediaMetadata({
        title: this.doc.titulo,
        artist: this.doc.autor || 'Lector',
        album: seccion,
        artwork: [{ src: '../icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
    }
    if (this.manejadores) return;
    this.manejadores = true;
    const poner = (accion, fn) => { try { ms.setActionHandler(accion, fn); } catch { /* no soportado */ } };
    poner('play', () => this.play());
    poner('pause', () => this.pausar());
    // Sin "pista anterior/siguiente": así la pantalla bloqueada muestra los botones de
    // retroceder y adelantar 15 s, como en los podcasts.
    poner('previoustrack', null);
    poner('nexttrack', null);
    poner('seekbackward', (d) => this.retroceder(d?.seekOffset || SALTO_SEG));
    poner('seekforward', (d) => this.avanzar(d?.seekOffset || SALTO_SEG));
  }
}
