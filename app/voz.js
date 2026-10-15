// Administra el motor de voz (Supertonic) que comparten la app y la página de prueba.

import { leerAjuste, guardarAjuste } from './db.js?v=1';

let st = null;
let motor = null;
let cargando = null;

export const AJUSTES_VOZ = {
  modelo: 'v2',     // probado en el iPhone: 16x tiempo real con WebGPU
  voz: 'M3',
  pasos: 8,
  backend: 'auto',
  velocidad: 1,
};

export async function modulo() {
  if (!st) st = await import('../supertonic.js?v=4');
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

// Carga (y si hace falta descarga) el modelo pedido. Libera el anterior antes.
export async function cargarMotor({ modelo, backend }, alAvanzar) {
  const ya = motorListo(modelo, backend);
  if (ya) return ya;
  if (cargando) await cargando.catch(() => {});
  const lib = await modulo();
  if (motor) { await motor.liberar(); motor = null; }
  cargando = (async () => {
    marcar({ modelo, backend });
    const m = await lib.Supertonic.cargar(modelo, { backend, alAvanzar });
    m.pedido = backend;
    try {
      await m.sintetizar('Hola.', 'es', 'F1', { pasos: 2 });
    } catch (e) {
      // Si la prueba falla (la gráfica sigue caída), se suelta lo cargado para no dejar memoria tomada.
      await m.liberar().catch(() => {});
      throw e;
    }
    marcar(null);
    try { await navigator.storage?.persist?.(); } catch { /* opcional */ }
    motor = m;
    return m;
  })();
  try {
    return await cargando;
  } catch (e) {
    marcar(null);
    throw e;
  } finally {
    cargando = null;
  }
}

// Suelta el motor para que la próxima generación lo vuelva a cargar desde el caché.
// Sirve cuando la tarjeta gráfica falla a mitad de camino (iPhone: "map async was not successful").
export async function reiniciarMotor() {
  if (cargando) await cargando.catch(() => {});
  if (motor) { try { await motor.liberar(); } catch { /* ya liberado */ } motor = null; }
}

export async function borrarVoces() {
  if (motor) { await motor.liberar(); motor = null; }
  return (await modulo()).borrarDescargas();
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
