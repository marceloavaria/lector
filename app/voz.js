// Administra el motor de voz (Supertonic) que comparten la app y la página de prueba.

import { leerAjuste, guardarAjuste } from './db.js?v=1';

let st = null;
let motor = null;
let cargando = Promise.resolve(); // cola de cargas (ver enTurno)

// Celular o tablet (el iPad se presenta como Mac, pero tiene pantalla táctil).
const ua = navigator.userAgent;
export const ES_MOVIL = /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

export function tipoEquipo() {
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  return 'computador';
}

// Lo mejor para cada equipo, con la voz que eligió Marcelo ("Mujer 2"):
// - celular: Supertonic 3 liviano (145 MB, cabe en la memoria de Safari en el iPhone);
// - computador con WebGPU: Supertonic 3 completo (398 MB, misma voz sin comprimir): corre entero
//   en la tarjeta gráfica y es varias veces más rápido que el liviano (en el PC de un amigo el
//   liviano fue a 0,3x tiempo real);
// - computador sin WebGPU: el liviano, que en el procesador es el más rápido.
// revisarGrafica() lo confirma al abrir la app: hay navegadores con WebGPU pero sin una tarjeta
// gráfica que puedan usar (drivers viejos o bloqueados).
export let MODELO_RECOMENDADO = ES_MOVIL || !('gpu' in navigator) ? 'v3q' : 'v3';

export const AJUSTES_VOZ = {
  modelo: MODELO_RECOMENDADO,
  voz: 'F2',
  pasos: 8,
  backend: 'auto',
  velocidad: 1,
};

export async function revisarGrafica() {
  if (MODELO_RECOMENDADO !== 'v3') return;
  let adaptador = null;
  try {
    adaptador = await Promise.race([
      navigator.gpu.requestAdapter(),
      new Promise((r) => setTimeout(() => r(null), 3000)),
    ]);
  } catch { /* sin WebGPU */ }
  if (!adaptador) MODELO_RECOMENDADO = AJUSTES_VOZ.modelo = 'v3q';
}

export async function modulo() {
  if (!st) st = await import('../supertonic.js?v=5');
  return st;
}

export async function ajustesVoz() {
  return { ...AJUSTES_VOZ, ...(await leerAjuste('voz', {})) };
}

export async function guardarAjustesVoz(cambios) {
  const actuales = await ajustesVoz();
  const nuevos = { ...actuales, ...cambios };
  await guardarAjuste('voz', nuevos);
  return nuevos;
}

// Listo si se cargó para este mismo pedido. Así, al volver de "cpu" a "auto" se recarga con
// la tarjeta gráfica; y si "auto" terminó en el procesador (sin WebGPU), no se recarga en vano.
export function motorListo(modelo, backend) {
  return motor && motor.modeloId === modelo && motor.pedido === backend ? motor : null;
}

export async function estaDescargado(modelo) {
  return (await modulo()).estaDescargado(modelo);
}

// Las cargas, recargas y borrados van de a uno. Antes, la carga anticipada al abrir la app y
// el play podían cargar a la vez: una soltaba el motor que la otra estaba usando.
function enTurno(fn) {
  const turno = cargando.then(fn);
  cargando = turno.catch(() => {});
  return turno;
}

// Carga (y si hace falta descarga) el modelo pedido. Libera el anterior antes.
export function cargarMotor({ modelo, backend }, alAvanzar) {
  const ya = motorListo(modelo, backend);
  if (ya) return Promise.resolve(ya);
  return enTurno(async () => {
    const listo = motorListo(modelo, backend); // pudo quedar listo mientras esperaba el turno
    if (listo) return listo;
    const lib = await modulo();
    if (motor) { await motor.liberar(); motor = null; }
    marcar({ modelo, backend });
    try {
      const m = await lib.Supertonic.cargar(modelo, { backend, alAvanzar });
      m.pedido = backend;
      try {
        await m.sintetizar('Hola.', 'es', 'F1', { pasos: 2 });
      } catch (e) {
        // Si la prueba falla (la gráfica sigue caída), se suelta lo cargado para no dejar memoria tomada.
        await m.liberar().catch(() => {});
        throw e;
      }
      try { await navigator.storage?.persist?.(); } catch { /* opcional */ }
      motor = m;
      return m;
    } finally {
      marcar(null);
    }
  });
}

// Suelta el motor para que la próxima generación lo vuelva a cargar desde el caché.
// Sirve cuando la tarjeta gráfica falla a mitad de camino (iPhone: "map async was not successful").
export function reiniciarMotor() {
  return enTurno(async () => {
    if (motor) { try { await motor.liberar(); } catch { /* ya liberado */ } motor = null; }
  });
}

export function borrarVoces() {
  return enTurno(async () => {
    if (motor) { await motor.liberar(); motor = null; }
    return (await modulo()).borrarDescargas();
  });
}

// Igual que en la página de prueba: si Safari cierra la página mientras carga el
// modelo, la marca queda y al volver se avisa y se propone algo más liviano.
const MARCA = 'lector-app:preparando';
function marcar(v) {
  try { v ? localStorage.setItem(MARCA, JSON.stringify(v)) : localStorage.removeItem(MARCA); } catch { /* sin almacenamiento */ }
}
export function caidaAnterior() {
  try {
    const v = JSON.parse(localStorage.getItem(MARCA));
    localStorage.removeItem(MARCA);
    return v;
  } catch {
    return null;
  }
}
