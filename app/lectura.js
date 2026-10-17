// Reproductor: genera la voz oración por oración un poco por delante de lo que suena y la
// junta en bloques continuos de ~1 minuto (así no hay un cambio de archivo entre oraciones,
// solo uno por bloque, en un fin de párrafo). Suena en elementos <audio>, así sigue con otra
// app en pantalla, y avisa qué oración está sonando para resaltarla y guardarla.
//
// Con la pantalla bloqueada, iOS duerme la app en cuanto deja de sonar algo. Por eso nunca se
// deja un momento sin audio: el bloque siguiente se precarga en un segundo <audio> y se pasa a
// él sin espera, y mientras se espera la voz (al partir, tras un salto o un corte) suena un
// silencio en bucle. Antes, al cambiar de bloque, el iPhone a veces se dormía y quedaba callado
// (registro del 15-10: 3 silencios de 2 a 5 minutos en 20 minutos con la pantalla bloqueada).

import { cargarMotor, motorListo, reiniciarMotor } from './voz.js?v=6';
import { actualizarDoc } from './db.js?v=1';
import { anotar } from './registro.js?v=4';
import { paraVoz, detectarFormato } from './numeros.js?v=1';

const BUFFER_SEG = 150;          // segundos de audio generados por delante
const MAX_ADELANTE = 100;        // oraciones generadas por delante, como tope
const HISTORIA = 20;             // oraciones ya escuchadas que se guardan para retroceder rápido
const BLOQUE_MIN_SEG = 60;       // un bloque termina en el primer fin de párrafo después de esto…
const BLOQUE_MAX_SEG = 150;      // …o en el primer fin de oración después de esto
const PAUSA_FIN_BLOQUE = 0.1;    // con un solo <audio>, el cambio de bloque ya agrega su propia pausa
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
const PRECARGA_SEG = 15;         // el bloque siguiente se precarga cuando al actual le quedan 15 s
const LATIDO_MS = 2000;          // revisión periódica: app dormida o audio que no avanza
const DORMIDA_SEG = 10;          // un latido que llega con más de 10 s de atraso: la app estuvo dormida
const TRABADO_SEG = 6;           // el audio debería sonar pero no avanza hace 6 s
// Calidad automática: si el equipo genera más lento de lo que suena y ya casi no queda audio
// por delante, la calidad baja un nivel (Alta → Media → Rápida), solo por esta sesión.
// En el iPhone se genera a 2–3,6x, así que ahí no se activa; en un PC lento (0,3x) sí.
const NIVELES_CALIDAD = [8, 5, 3];
const RITMO_AUDIO_SEG = 30;      // se mide con 30 s de audio generado…
const RITMO_GEN_SEG = 45;        // …o con 45 s generando (en un equipo muy lento, para no esperar tanto)
const RITMO_MARGEN = 1.15;       // hay que generar al menos un 15% más rápido de lo que suena
const HOLGURA_SEG = 30;          // y solo se baja si quedan menos de 30 s de escucha por delante

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
    this.audio = audio;         // el <audio> que suena (o sonará); se turna con `otro`
    this.otro = new Audio();    // precarga el bloque siguiente
    this.otro.preload = 'auto';
    this.desbloqueados = new WeakSet(); // <audio> que ya sonaron una vez (iOS pide un toque la primera vez)
    this.dobleAudio = true;     // se apaga si el teléfono no deja usar el segundo <audio>
    this.preparado = null;      // bloque siguiente ya cargado en `otro`
    this.retiro = null;         // retira el <audio> anterior apenas suena el nuevo (ver #retirarCuandoSuene)
    this.doc = null;
    this.contenido = null;
    this.ajustes = null;
    this.actual = 0;            // oración que suena (o sonará al dar play)
    this.bloque = null;         // bloque cargado en `audio`: { ini, fin, url, offsets, dur, anticipo }
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
    this.topePasos = null;      // calidad automática: tope de pasos en esta sesión (ver #medirRitmo)
    this.noAlcanza = false;     // ni con la calidad más baja alcanza a generar a tiempo
    this.ritmo = { clave: '', audio: 0, gen: 0, n: 0 };
    this.reintentos = new Set(); // bloques que ya se rehicieron una vez por no poder sonar
    this.espera = null;         // { tipo: 'arranque' | 'corte' | 'salto' | 'ajuste' | 'reintento', t }
    this.metrica = { n: 0, audio: 0, gen: 0, backend: '' };

    // Los eventos solo cuentan para el <audio> que suena; el otro solo precarga.
    for (const el of [audio, this.otro]) {
      el.addEventListener('playing', () => this.desbloqueados.add(el));
      el.addEventListener('ended', () => { if (el === this.audio) this.#alTerminar(); });
      el.addEventListener('timeupdate', () => { if (el === this.audio) this.#seguirPosicion(); });
      el.addEventListener('seeked', () => { if (el === this.audio) this.#seguirPosicion(); });
      el.addEventListener('pause', () => {
        // Pausa del sistema (llamada, otra app, Siri).
        // Las pausas que provoca el propio reproductor al cambiar de audio se ignoran.
        if (el !== this.audio || el.ended || !this.sonando || performance.now() < this.ignorarPausaHasta) return;
        this.sonando = false;
        this.retiro?.();
        anotar('pausa', { motivo: 'sistema', oracion: this.actual }, { urgente: true });
        this.#estado('pausa');
        this.guardarYa();
      });
      el.addEventListener('play', () => {
        if (el === this.audio && !this.sonando && this.bloque) {
          this.sonando = true;
          anotar('play', { motivo: 'sistema', oracion: this.actual });
          this.#estado('sonando');
          this.#llenar();
        }
      });
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.guardarYa(); });

    this.ultimoLatido = Date.now();
    this.sonabaEnLatido = false;
    this.avance = null;
    setInterval(() => this.#latido(), LATIDO_MS);

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
    this.formatoNumeros = detectarFormato(contenido.oraciones, doc.idioma); // 1.234,5 o 1,234.5
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
    this.#desbloquearOtro();
  }

  // Debe llamarse dentro de un toque y sin esperas antes del primer play():
  // iOS solo deja reproducir audio si ocurre en el mismo instante del toque.
  // `motivo`: 'tú' (botones de la app) o 'controles' (pantalla bloqueada, auto, audífonos).
  play(motivo = 'tú') {
    if (!this.doc) return;
    if (this.bloque && this.bloque.fin >= this.total - 1 && this.audio.ended) {
      this.#soltarBloque();
      this.actual = 0;
    }
    this.sonando = true;
    anotar('play', { motivo, oracion: this.actual });
    if (this.#bloqueCubre(this.actual) && !this.audio.ended) {
      this.audio.play().catch((e) => this.#falloAlSonar(e));
      this.#desbloquearOtro();
      this.#estado('sonando');
      this.#llenar();
      return;
    }
    // Desbloquea el audio con un silencio (en bucle) mientras se genera la primera oración.
    this.espera = { tipo: 'arranque', t: Date.now() };
    this.#esperarEnSilencio();
    this.#desbloquearOtro();
    if (this.listos.has(this.actual)) this.#sonarDesde(this.actual);
    else this.#estado(this.#motorListo() ? 'generando' : 'cargando-voz');
    this.#llenar();
  }

  pausar(motivo = 'tú') {
    if (!this.sonando) return;
    this.sonando = false;
    this.espera = null;
    anotar('pausa', { motivo, oracion: this.actual });
    this.#silenciarPausa();
    this.audio.pause();
    this.retiro?.();
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
        this.#soltarBloque();
        this.#esperarEnSilencio();
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
    for (const el of [this.audio, this.otro]) {
      el.defaultPlaybackRate = v;
      el.playbackRate = v;
    }
  }

  // Cambió la voz, la calidad o el idioma: lo generado ya no sirve.
  cambiarAjustes(ajustes, idioma) {
    // Si elegiste otra calidad, modelo o procesamiento, la calidad automática vuelve a medir.
    const antes = this.ajustes;
    if (!antes || antes.pasos !== ajustes.pasos || antes.modelo !== ajustes.modelo || antes.backend !== ajustes.backend) {
      this.topePasos = null;
      this.noAlcanza = false;
    }
    this.ajustes = ajustes;
    if (idioma && this.doc) {
      this.doc = { ...this.doc, idioma };
      this.formatoNumeros = detectarFormato(this.contenido.oraciones, idioma);
    }
    this.cambiarVelocidad(ajustes.velocidad || this.velocidad);
    this.epoca++;
    this.listos.clear();
    if (this.sonando) {
      this.espera = { tipo: 'ajuste', t: Date.now() };
      this.#soltarBloque();
      this.#esperarEnSilencio();
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
    let pasos = this.ajustes.pasos;
    if (this.respaldoCpu) pasos = Math.min(pasos, 5);
    if (this.topePasos) pasos = Math.min(pasos, this.topePasos);
    return pasos;
  }

  // Calidad automática (ver NIVELES_CALIDAD). Mide cuántos segundos de audio salen por segundo
  // generando, con la calidad y el motor de ahora. Un tropiezo aislado de la gráfica no baja la
  // calidad si todavía queda audio por delante: solo cuando el ritmo no alcanza y se está por cortar.
  #medirRitmo(motor, pasos, audio, gen) {
    if (this.respaldoCpu) return; // el respaldo ya tiene su calidad y dura hasta volver a la app
    const clave = `${motor.modeloId}|${motor.backend}|${pasos}`;
    if (this.ritmo.clave !== clave) this.ritmo = { clave, audio: 0, gen: 0, n: 0 };
    const r = this.ritmo;
    r.audio += audio;
    r.gen += gen;
    r.n++;
    if (r.n < 3 || (r.audio < RITMO_AUDIO_SEG && r.gen < RITMO_GEN_SEG)) return;
    this.ritmo = { clave, audio: 0, gen: 0, n: 0 }; // la próxima medición parte de cero
    const ritmo = r.audio / Math.max(0.001, r.gen);
    const holgura = this.#segundosAdelante() / this.velocidad;
    if (ritmo >= this.velocidad * RITMO_MARGEN || holgura >= HOLGURA_SEG) return;
    const datos = { ritmo: Math.round(ritmo * 100) / 100, vel: this.velocidad, holgura: Math.round(holgura) };
    const menor = NIVELES_CALIDAD.find((p) => p < pasos);
    if (!menor) {
      if (this.noAlcanza) return;
      this.noAlcanza = true;
      anotar('no-alcanza', { pasos, ...datos }, { urgente: true });
    } else {
      this.topePasos = menor;
      anotar('calidad-auto', { de: pasos, a: menor, ...datos }, { urgente: true });
    }
    this.#emitir('calidad', { pasos: this.#pasosEfectivos(), noAlcanza: this.noAlcanza });
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
    this.audio.loop = false;
    this.audio.src = url;
    if (anterior && anterior.url !== url) URL.revokeObjectURL(anterior.url);
  }

  // Suelta el bloque que suena y el que estaba precargado como su continuación.
  #soltarBloque() {
    this.#soltarPreparado();
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

  // ---------- sin momentos sin audio (ver el comentario del comienzo) ----------

  // Mientras se espera la voz suena un silencio en bucle: así iOS no duerme la app y la voz
  // se sigue generando con la pantalla bloqueada.
  #esperarEnSilencio() {
    this.#soltarPreparado();
    this.#cambiarFuente(this.silencio, null);
    this.audio.loop = true;
    this.audio.play().catch(() => { /* se reintenta con el primer bloque */ });
  }

  #enSilencio() {
    return !this.bloque && this.audio.loop && !this.audio.paused;
  }

  #otroListo() {
    return this.dobleAudio && this.desbloqueados.has(this.otro);
  }

  // iOS deja usar un <audio> sin un toque solo si ya sonó una vez con un toque: dentro del
  // toque de play se hace sonar medio segundo de silencio en el segundo <audio>.
  #desbloquearOtro() {
    const el = this.otro;
    if (!this.dobleAudio || this.desbloqueados.has(el) || this.preparado || this.retiro) return;
    el.loop = false;
    el.src = this.silencio;
    el.play().catch(() => { /* sin segundo audio: se sigue con uno solo */ });
  }

  #soltarPreparado() {
    const p = this.preparado;
    if (!p) return;
    this.preparado = null;
    if (this.otro.src === p.url) {
      this.otro.removeAttribute('src');
      this.otro.load();
    }
    URL.revokeObjectURL(p.url);
  }

  // Cuando al bloque que suena le quedan menos de PRECARGA_SEG, el siguiente se arma y se
  // carga en el otro <audio>, listo para sonar apenas termine este.
  #prepararSiguiente() {
    const b = this.bloque;
    if (this.preparado || this.retiro || !this.sonando || !b || !this.#otroListo()) return;
    if (this.audio.src !== b.url || b.dur - this.audio.currentTime > PRECARGA_SEG) return;
    const sig = b.fin + 1;
    if (sig >= this.total || !this.listos.has(sig)) return;
    const p = this.#armarBloque(sig);
    if (!p) return;
    this.preparado = p;
    this.otro.loop = false;
    this.otro.src = p.url;
    this.otro.defaultPlaybackRate = this.velocidad;
    this.otro.playbackRate = this.velocidad;
    this.otro.load();
  }

  // Pasa al bloque precargado sin espera: en la pausa final del bloque que suena (ver
  // `anticipo`) o, si no alcanzó, cuando termina.
  #pasarAlPreparado() {
    const p = this.preparado;
    const b = this.bloque;
    if (!p || !b || p.ini !== b.fin + 1 || this.retiro) return false;
    this.preparado = null;
    const viejo = this.audio;
    const nuevo = this.otro;
    this.audio = nuevo;
    this.otro = viejo;
    this.bloque = p;
    nuevo.defaultPlaybackRate = this.velocidad;
    nuevo.playbackRate = this.velocidad;
    nuevo.play().catch((e) => this.#falloAlPasar(e, p));
    this.#retirarCuandoSuene(viejo, nuevo, () => URL.revokeObjectURL(b.url));
    this.actual = p.ini;
    this.cambioPosicion = Date.now();
    this.#emitir('oracion', p.ini);
    this.#guardarPronto();
    anotar('bloque', { desde: p.ini, hasta: p.fin, seg: Math.round(p.dur), pre: 1 });
    this.#estado('sonando');
    this.#mediaSession();
    this.#podar();
    this.#llenar();
    return true;
  }

  // Suena el silencio de espera y ya está la voz: el bloque se carga en el otro <audio> y el
  // silencio se apaga recién cuando el bloque suena.
  #entrarSobreSilencio(b) {
    const silencio = this.audio;
    const nuevo = this.otro;
    this.audio = nuevo;
    this.otro = silencio;
    this.bloque = b;
    nuevo.loop = false;
    nuevo.src = b.url;
    nuevo.defaultPlaybackRate = this.velocidad;
    nuevo.playbackRate = this.velocidad;
    nuevo.play().catch((e) => { this.retiro?.(); this.#falloAlPasar(e, b); });
    this.#retirarCuandoSuene(silencio, nuevo);
  }

  // El <audio> anterior (ahora `otro`) se apaga cuando el nuevo ya suena; mientras tanto sigue
  // con lo que le quedaba (su pausa final o el silencio de espera). Con el bloque precargado
  // es inmediato.
  #retirarCuandoSuene(viejo, nuevo, alRetirar) {
    let hecho = false;
    const retirar = () => {
      if (hecho) return;
      hecho = true;
      if (this.retiro === retirar) this.retiro = null;
      if (this.otro === viejo) {
        viejo.pause();
        viejo.loop = false;
        viejo.removeAttribute('src');
        viejo.load();
      }
      alRetirar?.();
    };
    this.retiro = retirar;
    if (nuevo.readyState >= 3) {
      retirar();
      return;
    }
    nuevo.addEventListener('playing', retirar, { once: true });
    setTimeout(retirar, 4000); // por si el nuevo nunca llega a sonar
  }

  // El teléfono no dejó usar el segundo <audio> sin un toque: se sigue con uno solo (como
  // antes de esta versión) y el bloque suena en el <audio> de siempre.
  #falloAlPasar(e, b) {
    if (e?.name !== 'NotAllowedError' || !this.dobleAudio) {
      this.#falloAlSonar(e);
      return;
    }
    this.dobleAudio = false;
    anotar('audio-doble-falla', { msg: String(e?.message || e).slice(0, 80) }, { urgente: true });
    if (this.bloque !== b) return;
    this.retiro?.();
    const fallido = this.audio;
    this.audio = this.otro;
    this.otro = fallido;
    fallido.removeAttribute('src');
    fallido.load();
    this.#cambiarFuente(b.url, b);
    this.audio.defaultPlaybackRate = this.velocidad;
    this.audio.playbackRate = this.velocidad;
    if (this.sonando) this.audio.play().catch((e2) => this.#falloAlSonar(e2));
  }

  // Cada LATIDO_MS: si la app estuvo dormida con el audio puesto, o el audio debería sonar y
  // no avanza, queda en el registro (antes esos silencios no se veían). Si el audio quedó
  // detenido sin aviso, se intenta seguir.
  #latido() {
    const ahora = Date.now();
    const hueco = ahora - this.ultimoLatido;
    const sonaba = this.sonabaEnLatido; // dormir en pausa es normal: solo cuenta si sonaba
    this.ultimoLatido = ahora;
    this.sonabaEnLatido = this.sonando;
    if (!this.sonando) { this.avance = null; return; }
    if (sonaba && hueco > DORMIDA_SEG * 1000) {
      anotar('dormida', {
        seg: Math.round(hueco / 1000),
        oracion: this.actual,
        audio: this.audio.paused ? 'detenido' : 'sonando',
      }, { urgente: true });
    }
    const b = this.bloque;
    if (!b || this.audio.src !== b.url || this.espera || this.audio.ended) { this.avance = null; return; }
    const t = this.audio.currentTime;
    if (!this.avance || this.avance.url !== b.url || Math.abs(t - this.avance.t) > 0.05) {
      this.avance = { url: b.url, t, desde: ahora, avisado: false };
      return;
    }
    if (this.avance.avisado || ahora - this.avance.desde < TRABADO_SEG * 1000) return;
    this.avance.avisado = true;
    anotar('audio-trabado', {
      oracion: this.actual,
      pausado: this.audio.paused ? 1 : 0,
      listo: this.audio.readyState,
    }, { urgente: true });
    this.audio.play().catch(() => { /* queda anotado */ });
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
      this.#esperarEnSilencio();
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
    // Con dos <audio> el cambio de bloque no agrega pausa: la última oración lleva la suya.
    // Con uno solo, el cambio de archivo ya agrega una pausa propia.
    const conPrecarga = this.#otroListo();
    const pausas = partes.map((c, k) => (k === partes.length - 1 && !conPrecarga ? Math.min(c.pausa, PAUSA_FIN_BLOQUE) : c.pausa));
    const total = partes.reduce((n, c, k) => n + c.pcm.length + Math.round(pausas[k] * this.sr), 0);
    const datos = new Int16Array(total); // los ceros son las pausas
    let off = 0;
    partes.forEach((c, k) => {
      datos.set(c.pcm, off);
      off += c.pcm.length + Math.round(pausas[k] * this.sr);
    });
    const dur = t - partes.at(-1).pausa + pausas.at(-1);
    // `anticipo`: segundos finales que son solo pausa; ahí se puede pasar al bloque siguiente
    // sin cortar la voz.
    const anticipo = conPrecarga ? Math.max(0, pausas.at(-1) - 0.1) : 0;
    return { ini, fin: i - 1, url: URL.createObjectURL(wav(datos, this.sr)), offsets, dur, anticipo };
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
    // Si suena el silencio de espera, el bloque entra por el otro <audio> sin dejar un hueco.
    // Si no (un salto con la voz ya lista), se cambia en el mismo <audio>, como siempre.
    const sobreSilencio = this.#enSilencio() && this.#otroListo();
    this.#soltarPreparado();
    anotar('bloque', { desde: b.ini, hasta: b.fin, seg: Math.round(b.dur), ...(sobreSilencio ? { pre: 1 } : {}) });
    if (sobreSilencio) this.#entrarSobreSilencio(b);
    else {
      this.retiro?.();
      this.#cambiarFuente(b.url, b);
      this.audio.defaultPlaybackRate = this.velocidad;
      this.audio.playbackRate = this.velocidad;
      this.audio.play().catch((e) => this.#falloAlSonar(e));
    }
    this.#estado('sonando');
    this.#mediaSession();
    this.#podar();
    this.#llenar();
  }

  // Qué oración está sonando según el segundo exacto del bloque. También precarga el bloque
  // siguiente y, en la pausa final, pasa a él.
  #seguirPosicion() {
    const b = this.bloque;
    if (!b || this.audio.src !== b.url) return;
    const t = this.audio.currentTime;
    if (this.preparado && this.sonando && !this.audio.paused && b.dur - t <= b.anticipo && this.#pasarAlPreparado()) return;
    this.#prepararSiguiente();
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
    if (this.#pasarAlPreparado()) return;
    if (this.listos.has(sig)) {
      this.#sonarDesde(sig);
      return;
    }
    // Un corte: terminó el bloque y la oración siguiente aún no está generada. Se espera con
    // el silencio en bucle para que la app no se duerma.
    this.espera = { tipo: 'corte', t: Date.now() };
    anotar('corte-inicio', { oracion: sig, backend: this.respaldoCpu ? 'wasm' : this.metrica.backend || '' }, { urgente: true });
    this.#soltarBloque();
    this.#esperarEnSilencio();
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
        // Números, montos y fechas van en palabras (ver numeros.js).
        const texto = paraVoz(this.contenido.oraciones[i], this.doc.idioma, this.formatoNumeros);
        if (!/[\p{L}\p{N}]/u.test(texto)) {
          // Nada que leer (por ejemplo, solo la línea de DocuSign): un silencio breve.
          this.listos.set(i, { pcm: new Int16Array(Math.round(0.05 * this.sr)), pausa: 0, seg: 0.05 });
          if (this.sonando && i === this.actual && !this.#bloqueCubre(i)) this.#sonarDesde(i);
          continue;
        }
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
          r = await motor.sintetizar(texto, this.doc.idioma, voz, { pasos });
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
        const gen = (Date.now() - tGen) / 1000;
        this.metrica.n++;
        this.metrica.audio += pcm.length / this.sr;
        this.metrica.gen += gen;
        this.metrica.backend = motor.backend;
        this.#medirRitmo(motor, pasos, this.listos.get(i).seg, gen);
        // Si se estaba esperando esta oración (al partir, tras un salto o un corte), suena ya.
        if (this.sonando && i === this.actual && !this.#bloqueCubre(i)) this.#sonarDesde(i);
        else this.#prepararSiguiente(); // con la app oculta, timeupdate puede no llegar
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
    // 'controles': pantalla bloqueada, auto o audífonos (así el registro distingue esas pausas).
    poner('play', () => this.play('controles'));
    poner('pause', () => this.pausar('controles'));
    // Sin "pista anterior/siguiente": así la pantalla bloqueada muestra los botones de
    // retroceder y adelantar 15 s, como en los podcasts.
    poner('previoustrack', null);
    poner('nexttrack', null);
    poner('seekbackward', (d) => this.retroceder(d?.seekOffset || SALTO_SEG));
    poner('seekforward', (d) => this.avanzar(d?.seekOffset || SALTO_SEG));
  }
}
