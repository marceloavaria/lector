// Guardado local en IndexedDB. Todo queda en el dispositivo.
//   docs:       ficha de cada documento + posición donde quedaste (liviano, para la biblioteca)
//   contenidos: oraciones, párrafos y secciones (se cargan solo al abrir un documento)
//   archivos:   archivo original, para reprocesarlo o sincronizarlo más adelante
//   ajustes:    preferencias (voz, velocidad…)

const NOMBRE = 'lector';
const VERSION = 1;
let conexion = null;

function abrir() {
  if (conexion) return conexion;
  conexion = new Promise((resolve, reject) => {
    const req = indexedDB.open(NOMBRE, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('contenidos')) db.createObjectStore('contenidos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('archivos')) db.createObjectStore('archivos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('ajustes')) db.createObjectStore('ajustes', { keyPath: 'clave' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return conexion;
}

async function operar(almacenes, modo, fn) {
  const db = await abrir();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(almacenes, modo);
    let resultado;
    Promise.resolve(fn(tx)).then((r) => { resultado = r; }, reject);
    tx.oncomplete = () => resolve(resultado);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transacción cancelada'));
  });
}

const pedir = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function listarDocs() {
  const docs = await operar(['docs'], 'readonly', (tx) => pedir(tx.objectStore('docs').getAll()));
  return docs.sort((a, b) => (b.abierto || b.creado) - (a.abierto || a.creado));
}

export const leerDoc = (id) => operar(['docs'], 'readonly', (tx) => pedir(tx.objectStore('docs').get(id)));
export const leerContenido = (id) => operar(['contenidos'], 'readonly', (tx) => pedir(tx.objectStore('contenidos').get(id)));

export function guardarDocumento(doc, contenido, archivo) {
  return operar(['docs', 'contenidos', 'archivos'], 'readwrite', (tx) => {
    tx.objectStore('docs').put(doc);
    tx.objectStore('contenidos').put(contenido);
    if (archivo) tx.objectStore('archivos').put({ id: doc.id, nombre: archivo.name || doc.titulo, blob: archivo });
  });
}

export function actualizarDoc(id, cambios) {
  return operar(['docs'], 'readwrite', async (tx) => {
    const store = tx.objectStore('docs');
    const doc = await pedir(store.get(id));
    if (doc) store.put({ ...doc, ...cambios });
  });
}

export function borrarDocumento(id) {
  return operar(['docs', 'contenidos', 'archivos'], 'readwrite', (tx) => {
    for (const s of ['docs', 'contenidos', 'archivos']) tx.objectStore(s).delete(id);
  });
}

export async function leerAjuste(clave, porDefecto) {
  const r = await operar(['ajustes'], 'readonly', (tx) => pedir(tx.objectStore('ajustes').get(clave)));
  return r ? r.valor : porDefecto;
}

export const guardarAjuste = (clave, valor) => operar(['ajustes'], 'readwrite', (tx) => tx.objectStore('ajustes').put({ clave, valor }));
