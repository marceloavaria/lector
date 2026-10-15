// Registro del viaje: anota lo que pasa mientras suena (cortes, fallos de la tarjeta
// gráfica, idas y vueltas a otras apps, velocidad de generación) para copiarlo después
// de manejar. Queda en el dispositivo (localStorage) aunque iOS recargue la página.

const CLAVE = 'lector-app:registro';
const MAX_EVENTOS = 1500;
const SESION = Date.now();

let eventos = leer();
let pendiente = null;

function leer() {
  try { return JSON.parse(localStorage.getItem(CLAVE)) || []; } catch { return []; }
}

function guardar() {
  clearTimeout(pendiente);
  pendiente = null;
  try { localStorage.setItem(CLAVE, JSON.stringify(eventos)); } catch { /* sin almacenamiento */ }
}

// `urgente`: se guarda al tiro (al ocultarse la app iOS puede suspenderla en segundos).
export function anotar(tipo, datos = {}, { urgente = false } = {}) {
  eventos.push({ t: Date.now(), s: SESION, o: document.hidden ? 1 : 0, tipo, ...datos });
  if (eventos.length > MAX_EVENTOS) eventos = eventos.slice(-MAX_EVENTOS);
  if (urgente) guardar();
  else if (!pendiente) pendiente = setTimeout(guardar, 5000);
}

export function borrarRegistro() {
  eventos = [];
  guardar();
}

export const cantidadEventos = () => eventos.length;

// ---------- resumen para copiar ----------

const hora = (t) => new Date(t).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fecha = (t) => new Date(t).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const coma = (x, d = 1) => x.toFixed(d).replace('.', ',');
function dur(seg) {
  seg = Math.round(seg);
  if (seg < 60) return `${seg} s`;
  const min = Math.round(seg / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

function resumirSesion(evs) {
  const ini = evs[0].t;
  const fin = evs.at(-1).t;
  const L = [`Sesión ${fecha(ini)} → ${hora(fin)} (${dur((fin - ini) / 1000)})`];

  // Tiempo con la app oculta (Waze delante o pantalla bloqueada).
  let oculta = 0;
  let desde = null;
  for (const e of evs) {
    if (e.tipo === 'oculta' && desde == null) desde = e.t;
    if (e.tipo === 'visible' && desde != null) { oculta += e.t - desde; desde = null; }
  }
  if (desde != null) oculta += fin - desde;

  const minutos = evs.filter((e) => e.tipo === 'minuto');
  const sonando = minutos.filter((e) => e.sonando).length;
  const cortes = evs.filter((e) => e.tipo === 'corte-fin');
  const sinCerrar = evs.filter((e) => e.tipo === 'corte-inicio').length - cortes.length;
  const segCortes = cortes.reduce((n, e) => n + (e.seg || 0), 0);
  const maxCorte = cortes.reduce((m, e) => Math.max(m, e.seg || 0), 0);
  const fallos = evs.filter((e) => e.tipo === 'fallo-gpu');
  const pausasSistema = evs.filter((e) => e.tipo === 'pausa' && e.motivo === 'sistema').length;
  const errores = evs.filter((e) => e.tipo === 'error');

  // Tiempo con el procesador de respaldo.
  let respaldo = 0;
  let r0 = null;
  for (const e of evs) {
    if (e.tipo === 'respaldo-cpu' && r0 == null) r0 = e.t;
    if (e.tipo === 'vuelve-gpu' && r0 != null) { respaldo += e.t - r0; r0 = null; }
  }
  if (r0 != null) respaldo += fin - r0;

  const velocidad = (filtro) => {
    const xs = minutos.filter(filtro);
    const audio = xs.reduce((n, e) => n + (e.audio || 0), 0);
    const gen = xs.reduce((n, e) => n + (e.gen || 0), 0);
    return gen > 0 ? `${coma(audio / gen)}x` : '—';
  };

  L.push(`- Sonando: ~${sonando} min · app oculta: ${dur(oculta / 1000)}`);
  L.push(`- Cortes esperando la voz: ${cortes.length}${sinCerrar > 0 ? ` (+${sinCerrar} sin terminar)` : ''}${cortes.length ? ` · ${dur(segCortes)} en total, el más largo ${dur(maxCorte)}` : ''}`);
  L.push(`- Fallos de la tarjeta gráfica: ${fallos.length}${fallos.length ? ` (${fallos.filter((e) => e.o).length} con la app oculta)` : ''} · con procesador de respaldo: ${dur(respaldo / 1000)}`);
  L.push(`- Velocidad de generación: gráfica ${velocidad((e) => e.backend === 'webgpu')} (oculta ${velocidad((e) => e.backend === 'webgpu' && e.o)}) · procesador ${velocidad((e) => e.backend === 'wasm')}`);
  L.push(`- Pausas del sistema (llamadas, Siri, otra app): ${pausasSistema} · errores: ${errores.length}`);
  return L;
}

function linea(e) {
  const { t, s, o, tipo, ...resto } = e;
  const datos = Object.entries(resto).map(([k, v]) => `${k}=${typeof v === 'number' && !Number.isInteger(v) ? coma(v) : v}`).join(' ');
  return `${hora(t)}${o ? ' [oculta]' : ''} ${tipo}${datos ? ` ${datos}` : ''}`;
}

// Texto para pegar en el chat: un resumen por sesión (cada vez que se abrió la app) y los
// últimos eventos. `contexto` agrega equipo y voz.
export function textoRegistro(contexto = '') {
  guardar();
  if (!eventos.length) return 'REGISTRO DEL VIAJE · Marshalls Lector\n(sin eventos todavía)';
  const L = ['REGISTRO DEL VIAJE · Marshalls Lector', `Copiado: ${fecha(Date.now())}`];
  if (contexto) L.push(contexto);
  const sesiones = new Map();
  for (const e of eventos) {
    if (!sesiones.has(e.s)) sesiones.set(e.s, []);
    sesiones.get(e.s).push(e);
  }
  for (const evs of [...sesiones.values()].slice(-4)) L.push('', ...resumirSesion(evs));
  L.push('', 'Eventos (máx. 250, los más recientes al final):');
  L.push(...eventos.slice(-250).map(linea));
  return L.join('\n');
}
