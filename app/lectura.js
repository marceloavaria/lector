// Reproductor: genera la voz oración por oración un poco por delante de lo que suena,
// encadena los audios en un solo elemento <audio> (así sigue sonando con otra app en
// pantalla) y avisa qué oración está sonando para resaltarla y guardarla.

import { cargarMotor, modulo, motorListo, reiniciarMotor } from './voz.js?v=3';
import { actualizarDoc } from './db.js?v=1';
import { anotar } from './registro.js?v=1';

const BUFFER_SEG = 90;     // segundos de audio generados por delante
const MAX_ADELANTE = 60;   // oraciones generadas por delante, como tope
const PAUSA_ORACION = 0.18;
const PAUSA_PARRAFO = 0.55;
const SALTO_SEG = 15;            // botones 15− y 15+
const CARACTERES_POR_SEG = 14;   // ritmo de la voz a 1x, para estimar oraciones aún no generadas

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Fallos de la tarjeta gráfica a mitad de una generación (en el iPhone pasa al volver de
// otra app o por memoria). Se distinguen de errores del texto o de la descarga.
const esFalloGpu = (e) => /OrtRun|MapAsync|map async|webgpu|wgpu|device lost|GPUDevice/i.test(e?.message || String(e));

// Medio segundo de silencio en WAV, para desbloquear el audio en el mismo toque.
function silencioUrl() {
  const n = 22050;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 44100, true); v.setUint32(28, 88200, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export class Reproductor extends EventTarget {
  constructor(audio) {
    super();
    this.audio = audio;
    this.doc = null;
    this.contenido = null;
    this.ajustes = null;
    this.actual = 0;          // oración que suena (o sonará al dar play)
    this.enAudio = -1;        // oración cargada en el <audio>; -1 = ninguna o silencio
    this.sonando = false;     // lo que quiere el usuario
    this.generando = false;
    this.epoca = 0;           // cambia cuando cambia la voz: invalida lo generado
    this.listos = new Map();  // oración -> { url, seg }
    this.velocidad = 1;
    this.finParrafo = new Set();
    this.temporizador = null;
    this.silencio = silencioUrl();
    this.ignorarPausaHasta = 0;
    this.respaldoCpu = false;   // la gráfica falló: se genera con el procesador hasta volver a la app
    this.espera = null;         // { tipo: 'arranque' | 'corte' | 'salto' | 'ajuste', t } mientras no hay audio
    this.metrica = { n: 0, audio: 0, gen: 0, backend: '' };

    audio.addEventListener('ended', () => this.#alTerminar());
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
      if (!this.sonando && this.enAudio >= 0) {
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
    this.#vaciar();
    this.doc = doc;
    this.contenido = contenido;
    this.ajustes = ajustes;
    this.velocidad = ajustes.velocidad || 1;
    this.actual = Math.max(0, Math.min(doc.oracion || 0, this.total - 1));
    this.cambioPosicion = doc.progresoT || 0;
    this.enAudio = -1;
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
    this.#vaciar();
    this.doc = null;
    this.contenido = null;
  }

  // Para cuando hay que esperar algo (abrir el documento) antes de dar play: se llama
  // en el mismo toque y deja el audio habilitado para el play() que viene después.
  desbloquear() {
    if (this.sonando) return;
    this.#cambiarFuente(this.silencio, -1);
    this.audio.play().catch(() => { /* basta con el intento dentro del toque */ });
  }

  // Debe llamarse dentro de un toque y sin esperas antes del primer play():
  // iOS solo deja reproducir audio si ocurre en el mismo instante del toque.
  play() {
    if (!this.doc) return;
    if (this.actual >= this.total - 1 && this.enAudio === this.actual && this.audio.ended) this.actual = 0;
    this.sonando = true;
    anotar('play', { motivo: 'tú', oracion: this.actual });
    if (this.enAudio === this.actual && this.audio.src && !this.audio.ended) {
      this.audio.play().catch((e) => this.#fallo(e));
      this.#estado('sonando');
      this.#llenar();
      return;
    }
    // Desbloquea el audio con un silencio mientras se genera la primera oración.
    this.espera = { tipo: 'arranque', t: Date.now() };
    this.#cambiarFuente(this.silencio, -1);
    this.audio.play().catch(() => { /* se reintenta con la primera oración */ });
    if (this.listos.has(this.actual)) this.#reproducir(this.actual);
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
    this.enAudio = -1;
    this.#emitir('oracion', this.actual);
  }

  irA(i) {
    if (!this.doc) return;
    i = Math.max(0, Math.min(i, this.total - 1));
    this.actual = i;
    this.cambioPosicion = Date.now();
    this.#podar();
    if (this.sonando) {
      if (this.listos.has(i)) this.#reproducir(i);
      else {
        this.espera = { tipo: 'salto', t: Date.now() };
        this.#silenciarPausa();
        this.audio.pause();
        this.enAudio = -1;
        this.#estado('generando');
        this.#emitir('oracion', i);
        this.#llenar();
      }
    } else {
      this.enAudio = -1;
      this.#emitir('oracion', i);
    }
    this.#guardarPronto();
  }

  siguiente() { this.irA(this.actual + 1); }

  // Saltos de 15 segundos de audio, como en los podcasts. Si el punto cae dentro de la oración
  // que suena, se mueve ahí mismo; si no, se va al comienzo de la oración donde cae (así no
  // se retoma a mitad de frase).
  retroceder(seg = SALTO_SEG) {
    if (!this.doc) return;
    const enCurso = this.enAudio === this.actual ? this.audio.currentTime : 0;
    if (enCurso >= seg) {
      this.audio.currentTime = enCurso - seg;
      return;
    }
    let falta = seg - enCurso;
    let i = this.actual;
    while (i > 0 && falta > 0) {
      i--;
      falta -= this.#duracion(i);
    }
    this.irA(i);
  }

  avanzar(seg = SALTO_SEG) {
    if (!this.doc) return;
    const enCurso = this.enAudio === this.actual ? this.audio.currentTime : 0;
    const quedan = Math.max(0, this.#duracion(this.actual) - enCurso);
    if (this.enAudio === this.actual && quedan > seg + 0.5) {
      this.audio.currentTime = enCurso + seg;
      return;
    }
    let falta = seg - quedan;
    let i = this.actual + 1;
    while (i < this.total - 1 && falta > this.#duracion(i)) {
      falta -= this.#duracion(i);
      i++;
    }
    this.irA(Math.min(i, this.total - 1));
  }

  anterior() {
    if (this.sonando && this.enAudio === this.actual && this.audio.currentTime > 2) {
      this.audio.currentTime = 0;
      return;
    }
    this.irA(this.actual - 1);
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
    this.#vaciar();
    if (this.sonando) {
      this.espera = { tipo: 'ajuste', t: Date.now() };
      this.#silenciarPausa();
      this.audio.pause();
      this.enAudio = -1;
      this.#estado(this.#motorListo() ? 'generando' : 'cargando-voz');
      this.#llenar();
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

  #cambiarFuente(url, indice) {
    this.#silenciarPausa();
    const anterior = this.audio.src;
    this.enAudio = indice;
    this.audio.src = url;
    // El audio que se reemplaza se suelta si ya no está en la cola.
    if (anterior && anterior !== this.silencio && ![...this.listos.values()].some((c) => c.url === anterior)) {
      URL.revokeObjectURL(anterior);
    }
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
    this.#estado('cargando-voz');
  }

  #fallo(e) {
    if (e?.name === 'AbortError') return;
    anotar('error', { msg: String(e?.message || e).slice(0, 160) }, { urgente: true });
    this.sonando = false;
    this.espera = null;
    this.#estado('pausa');
    this.#emitir('error', e);
  }

  #reproducir(i) {
    const c = this.listos.get(i);
    this.actual = i;
    this.cambioPosicion = Date.now();
    this.#emitir('oracion', i);
    this.#guardarPronto();
    if (!c) {
      this.enAudio = -1;
      this.#estado('generando');
      this.#llenar();
      return;
    }
    if (this.espera) {
      const seg = Math.round((Date.now() - this.espera.t) / 100) / 10;
      anotar(this.espera.tipo === 'corte' ? 'corte-fin' : this.espera.tipo, { oracion: i, seg }, { urgente: this.espera.tipo === 'corte' });
      this.espera = null;
    }
    this.#cambiarFuente(c.url, i);
    this.audio.defaultPlaybackRate = this.velocidad;
    this.audio.playbackRate = this.velocidad;
    this.audio.play().catch((e) => this.#fallo(e));
    this.#estado('sonando');
    this.#mediaSession();
    this.#podar();
    this.#llenar();
  }

  #alTerminar() {
    if (!this.sonando) return;
    if (this.enAudio === -1) {
      // Terminó el silencio de desbloqueo: suena la oración actual apenas esté lista.
      if (this.listos.has(this.actual)) this.#reproducir(this.actual);
      return;
    }
    if (this.actual + 1 >= this.total) {
      this.sonando = false;
      anotar('fin-documento', { oracion: this.actual });
      this.#estado('fin');
      this.guardarYa();
      return;
    }
    if (!this.listos.has(this.actual + 1)) {
      // Un corte: terminó una oración y la siguiente aún no está generada.
      this.espera = { tipo: 'corte', t: Date.now() };
      anotar('corte-inicio', { oracion: this.actual + 1, backend: this.respaldoCpu ? 'wasm' : this.metrica.backend || '' }, { urgente: true });
    }
    this.#reproducir(this.actual + 1);
  }

  // Duración de una oración: la real si ya está generada; si no, estimada por su largo.
  #duracion(i) {
    const c = this.listos.get(i);
    if (c) return c.seg;
    const largo = this.contenido?.oraciones[i]?.length || 0;
    return largo / CARACTERES_POR_SEG + (this.finParrafo.has(i) ? PAUSA_PARRAFO : PAUSA_ORACION);
  }

  #segundosAdelante() {
    let s = 0;
    const c = this.listos.get(this.actual);
    if (c) s += this.enAudio === this.actual ? Math.max(0, c.seg - this.audio.currentTime) : c.seg;
    for (let i = this.actual + 1; i < this.actual + MAX_ADELANTE + 1 && this.listos.has(i); i++) s += this.listos.get(i).seg;
    return s;
  }

  #siguienteSinGenerar() {
    for (let i = this.actual; i < Math.min(this.total, this.actual + MAX_ADELANTE + 1); i++) {
      if (!this.listos.has(i)) return i;
    }
    return null;
  }

  async #llenar() {
    if (this.generando) return; // el ciclo que ya corre toma la nueva posición
    this.generando = true;
    try {
      while (this.sonando && this.doc) {
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
          if (!listo) anotar('motor-cargado', { backend: motor.backend, seg: Math.round((Date.now() - t0) / 100) / 10 });
        } catch (e) {
          // Recargar el motor también prueba la gráfica: si sigue caída, cuenta como otro fallo.
          if (backend !== 'cpu' && esFalloGpu(e)) {
            this.#falloGpu(e, 'al cargar');
            await esperar(500);
            continue;
          }
          this.#fallo(e);
          return;
        }
        const st = await modulo();
        let r;
        const tGen = Date.now();
        try {
          r = await motor.sintetizar(this.contenido.oraciones[i], this.doc.idioma, voz, { pasos });
        } catch (e) {
          if (epoca !== this.epoca || !this.doc) continue;
          if (!esFalloGpu(e) || motor.backend !== 'webgpu') { this.#fallo(e); return; }
          this.#falloGpu(e, 'al generar');
          await reiniciarMotor();
          continue;
        }
        if (motor.backend === 'webgpu') this.fallosGpu = 0; // el respaldo es para fallos seguidos
        if (epoca !== this.epoca || !this.doc) continue;
        this.metrica.n++;
        this.metrica.audio += r.segundos;
        this.metrica.gen += (Date.now() - tGen) / 1000;
        this.metrica.backend = motor.backend;
        const pausa = this.finParrafo.has(i) ? PAUSA_PARRAFO : PAUSA_ORACION;
        this.listos.set(i, { url: URL.createObjectURL(st.wavBlob(r.pcm, motor.sampleRate, pausa)), seg: r.segundos + pausa });
        if (i === this.actual && this.enAudio !== i && this.sonando) this.#reproducir(i);
      }
    } catch (e) {
      this.#fallo(e);
    } finally {
      this.generando = false;
    }
  }

  // Suelta los audios que ya quedaron atrás o muy lejos de la posición actual.
  #podar() {
    for (const [i, c] of this.listos) {
      if (i < this.actual - 2 || i > this.actual + MAX_ADELANTE + 5) {
        if (i !== this.enAudio) URL.revokeObjectURL(c.url);
        this.listos.delete(i);
      }
    }
  }

  #vaciar() {
    for (const [i, c] of this.listos) if (i !== this.enAudio) URL.revokeObjectURL(c.url);
    this.listos.clear();
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
