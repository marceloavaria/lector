// Reproductor: genera la voz oración por oración un poco por delante de lo que suena,
// encadena los audios en un solo elemento <audio> (así sigue sonando con otra app en
// pantalla) y avisa qué oración está sonando para resaltarla y guardarla.

import { cargarMotor, modulo, motorListo } from './voz.js?v=1';
import { actualizarDoc } from './db.js?v=1';

const BUFFER_SEG = 90;     // segundos de audio generados por delante
const MAX_ADELANTE = 60;   // oraciones generadas por delante, como tope
const PAUSA_ORACION = 0.18;
const PAUSA_PARRAFO = 0.55;

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

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

    audio.addEventListener('ended', () => this.#alTerminar());
    audio.addEventListener('pause', () => {
      // Pausa del sistema (llamada, otra app, controles de la pantalla bloqueada).
      // Las pausas que provoca el propio reproductor al cambiar de audio se ignoran.
      if (audio.ended || !this.sonando || performance.now() < this.ignorarPausaHasta) return;
      this.sonando = false;
      this.#estado('pausa');
      this.guardarYa();
    });
    audio.addEventListener('play', () => {
      if (!this.sonando && this.enAudio >= 0) {
        this.sonando = true;
        this.#estado('sonando');
        this.#llenar();
      }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.guardarYa(); });
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
    this.#mediaSession();
    this.#emitir('oracion', this.actual);
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
    if (this.enAudio === this.actual && this.audio.src && !this.audio.ended) {
      this.audio.play().catch((e) => this.#fallo(e));
      this.#estado('sonando');
      this.#llenar();
      return;
    }
    // Desbloquea el audio con un silencio mientras se genera la primera oración.
    this.#cambiarFuente(this.silencio, -1);
    this.audio.play().catch(() => { /* se reintenta con la primera oración */ });
    if (this.listos.has(this.actual)) this.#reproducir(this.actual);
    else this.#estado(this.#motorListo() ? 'generando' : 'cargando-voz');
    this.#llenar();
  }

  pausar() {
    if (!this.sonando) return;
    this.sonando = false;
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

  #motorListo() {
    return !!(this.ajustes && motorListo(this.ajustes.modelo, this.ajustes.backend));
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

  #fallo(e) {
    if (e?.name === 'AbortError') return;
    this.sonando = false;
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
      this.#estado('fin');
      this.guardarYa();
      return;
    }
    this.#reproducir(this.actual + 1);
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
        const { modelo, backend, voz, pasos } = this.ajustes;
        let motor;
        try {
          motor = await cargarMotor({ modelo, backend }, (p) => this.#emitir('voz', p));
        } catch (e) {
          this.#fallo(e);
          return;
        }
        this.listoParaGenerar = `${modelo}/${backend}`;
        const st = await modulo();
        const r = await motor.sintetizar(this.contenido.oraciones[i], this.doc.idioma, voz, { pasos });
        if (epoca !== this.epoca || !this.doc) continue;
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
    poner('previoustrack', () => this.anterior());
    poner('nexttrack', () => this.siguiente());
    poner('seekbackward', () => this.anterior());
    poner('seekforward', () => this.siguiente());
  }
}
