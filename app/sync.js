// Sincronización con un repositorio privado de GitHub (por defecto marceloavaria/lector-datos).
//   biblioteca.json        ficha de cada documento + dónde quedaste (gana lo más reciente)
//   contenidos/<id>.json   el texto ya dividido en oraciones (se escribe una sola vez)
// La clave (token) la crea Marcelo en GitHub y queda guardada solo en cada dispositivo.

import { listarDocs, leerContenido, guardarDocumento, actualizarDoc, borrarDocumento, leerAjuste, guardarAjuste } from './db.js?v=1';

export const REPO_POR_DEFECTO = 'marceloavaria/lector-datos';
export const URL_CREAR_CLAVE = 'https://github.com/settings/personal-access-tokens/new?' + new URLSearchParams({
  name: 'Lector',
  description: 'Sincroniza la biblioteca y el avance del Lector entre el iPhone y los computadores.',
  target_name: 'marceloavaria',
  expires_in: '365',
  contents: 'write',
});
const API = 'https://api.github.com';
const INDICE = 'biblioteca.json';

export class ErrorSync extends Error {}

export const configuracion = () => leerAjuste('sync', null);
export const guardarConfiguracion = (cfg) => guardarAjuste('sync', cfg);
export const desconectar = () => guardarAjuste('sync', null);
export const ultimaSync = () => leerAjuste('ultimaSync', 0);

// Lo borrado en un dispositivo se anota para borrarlo también en los demás.
export async function registrarBorrado(id) {
  const borrados = await leerAjuste('borrados', {});
  borrados[id] = Date.now();
  await guardarAjuste('borrados', borrados);
}

export async function quitarBorrado(id) {
  const borrados = await leerAjuste('borrados', {});
  if (id in borrados) {
    delete borrados[id];
    await guardarAjuste('borrados', borrados);
  }
}

// ---------- GitHub ----------

function aBase64(texto) {
  const bytes = new TextEncoder().encode(texto);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function deBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

async function pedir(cfg, ruta, { metodo = 'GET', cuerpo, crudo = false } = {}) {
  let resp;
  try {
    resp = await fetch(`${cfg.apiBase || API}${ruta}`, {
      method: metodo,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: crudo ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
  } catch {
    throw new ErrorSync('Sin conexión con GitHub. Se sincroniza cuando vuelva internet.');
  }
  if (resp.status === 401) throw new ErrorSync('La clave de GitHub no es válida o venció. Crea una nueva en "Sincronizar".');
  if (resp.status === 403) {
    const texto = await resp.text();
    throw new ErrorSync(/rate limit/i.test(texto)
      ? 'GitHub está limitando las consultas; se reintenta en un rato.'
      : 'La clave no tiene permiso para escribir en el repositorio. Revisa que "Contents" diga "Read and write".');
  }
  return resp;
}

export async function probarConexion(cfg) {
  const resp = await pedir(cfg, `/repos/${cfg.repo}`);
  if (resp.status === 404) throw new ErrorSync('No encuentro el repositorio, o la clave no tiene acceso a él. Al crear la clave, elige "Only select repositories" y marca lector-datos.');
  if (!resp.ok) throw new ErrorSync(`GitHub respondió ${resp.status}.`);
  const repo = await resp.json();
  if (!repo.private) throw new ErrorSync('Ese repositorio es público: tus libros quedarían a la vista de cualquiera. Usa uno privado.');
  return repo;
}

async function leerArchivo(cfg, ruta, { crudo = false } = {}) {
  const resp = await pedir(cfg, `/repos/${cfg.repo}/contents/${ruta}`, { crudo });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new ErrorSync(`No pude leer ${ruta} (GitHub respondió ${resp.status}).`);
  if (crudo) return { texto: await resp.text() };
  const j = await resp.json();
  return { sha: j.sha, texto: j.encoding === 'base64' ? deBase64(j.content) : null };
}

// Devuelve { conflicto: true } si otro dispositivo escribió antes (sha desactualizado o
// archivo que ya existía).
async function escribirArchivo(cfg, ruta, texto, sha, mensaje) {
  const resp = await pedir(cfg, `/repos/${cfg.repo}/contents/${ruta}`, {
    metodo: 'PUT',
    cuerpo: { message: mensaje, content: aBase64(texto), ...(sha ? { sha } : {}) },
  });
  if (resp.status === 409 || resp.status === 422) return { conflicto: true };
  if (!resp.ok) throw new ErrorSync(`No pude guardar ${ruta} (GitHub respondió ${resp.status}).`);
  return { sha: (await resp.json()).content?.sha };
}

// ---------- fusión ----------

const ficha = (doc) => ({
  titulo: doc.titulo,
  autor: doc.autor || '',
  tipo: doc.tipo,
  idioma: doc.idioma,
  metaT: doc.metaT || 0,
  creado: doc.creado,
  totalOraciones: doc.totalOraciones,
  caracteres: doc.caracteres,
  oracion: doc.oracion || 0,
  progresoT: doc.progresoT || 0,
  abierto: doc.abierto || 0,
});

async function sincronizarAhora(cfg) {
  for (let intento = 0; intento < 4; intento++) {
    const remoto = await leerArchivo(cfg, INDICE);
    const indice = remoto?.texto ? JSON.parse(remoto.texto) : { version: 1, docs: {} };
    indice.docs ||= {};
    const borrados = await leerAjuste('borrados', {});
    const resumen = { bajados: 0, subidos: 0, posiciones: 0, borrados: 0 };
    let cambioRemoto = !remoto;

    // 1. Borrados: los de aquí se anotan allá; los de allá se aplican aquí.
    const locales = new Map((await listarDocs()).map((d) => [d.id, d]));
    for (const [id, ts] of Object.entries(borrados)) {
      const local = locales.get(id);
      if (local && (local.creado || 0) > ts) continue; // se volvió a agregar después de borrarlo
      const r = indice.docs[id];
      if (!r?.borrado || r.borrado < ts) {
        indice.docs[id] = { ...(r || {}), borrado: ts };
        cambioRemoto = true;
      }
    }
    for (const [id, doc] of locales) {
      const r = indice.docs[id];
      if (r?.borrado && r.borrado >= (doc.creado || 0)) {
        await borrarDocumento(id);
        locales.delete(id);
        resumen.borrados++;
      }
    }

    // 2. Documentos de aquí: se suben los nuevos y se fusiona la posición.
    for (const [id, doc] of locales) {
      const r = indice.docs[id];
      if (!r || r.borrado) {
        const contenido = await leerContenido(id);
        if (!contenido) continue;
        await escribirArchivo(cfg, `contenidos/${id}.json`, JSON.stringify(contenido), null, `Agregar "${doc.titulo}"`);
        indice.docs[id] = ficha(doc);
        cambioRemoto = true;
        resumen.subidos++;
        continue;
      }
      const cambiosLocal = {};
      if ((doc.progresoT || 0) > (r.progresoT || 0)) {
        Object.assign(r, { oracion: doc.oracion || 0, progresoT: doc.progresoT });
        cambioRemoto = true;
      } else if ((r.progresoT || 0) > (doc.progresoT || 0)) {
        Object.assign(cambiosLocal, { oracion: r.oracion || 0, progresoT: r.progresoT });
        resumen.posiciones++;
      }
      if ((doc.metaT || 0) > (r.metaT || 0)) {
        Object.assign(r, { idioma: doc.idioma, metaT: doc.metaT });
        cambioRemoto = true;
      } else if ((r.metaT || 0) > (doc.metaT || 0)) {
        Object.assign(cambiosLocal, { idioma: r.idioma, metaT: r.metaT });
      }
      if ((doc.abierto || 0) > (r.abierto || 0)) {
        r.abierto = doc.abierto;
        cambioRemoto = true;
      } else if ((r.abierto || 0) > (doc.abierto || 0)) {
        cambiosLocal.abierto = r.abierto;
      }
      if (Object.keys(cambiosLocal).length) await actualizarDoc(id, cambiosLocal);
    }

    // 3. Documentos de allá que no están aquí: se bajan.
    for (const [id, r] of Object.entries(indice.docs)) {
      if (r.borrado || locales.has(id)) continue;
      const archivo = await leerArchivo(cfg, `contenidos/${id}.json`, { crudo: true });
      if (!archivo) continue;
      const contenido = JSON.parse(archivo.texto);
      await guardarDocumento({ id, ...ficha(r), oracion: r.oracion || 0 }, { ...contenido, id }, null);
      resumen.bajados++;
    }

    // 4. Se guarda el índice. Si otro dispositivo escribió entremedio, se repite todo.
    if (cambioRemoto) {
      indice.version = 1;
      indice.actualizado = Date.now();
      const r = await escribirArchivo(cfg, INDICE, JSON.stringify(indice, null, 1), remoto?.sha, 'Sincronizar biblioteca');
      if (r.conflicto) continue;
    }
    await guardarAjuste('ultimaSync', Date.now());
    return resumen;
  }
  throw new ErrorSync('Otro dispositivo estaba sincronizando al mismo tiempo. Se reintenta en un rato.');
}

// Las sincronizaciones van de a una: GitHub no admite escrituras simultáneas.
let cola = Promise.resolve();
export function sincronizar() {
  const turno = cola.then(async () => {
    const cfg = await configuracion();
    if (!cfg?.token) return null;
    return sincronizarAhora(cfg);
  });
  cola = turno.catch(() => {});
  return turno;
}
