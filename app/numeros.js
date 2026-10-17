// Texto para la voz: números, montos, porcentajes y fechas se escriben en palabras antes de
// leerlos. La voz lee los dígitos tal como vienen y con el formato chileno (321.231 o
// 1.324.321) el punto le parece un decimal. En pantalla el texto no cambia.

// ---------- español ----------

const ES_UNIDADES = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
  'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte',
  'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho',
  'veintinueve'];
const ES_DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const ES_CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos',
  'setecientos', 'ochocientos', 'novecientos'];
const ES_ORDINALES = ['', 'primero', 'segundo', 'tercero', 'cuarto', 'quinto', 'sexto', 'séptimo', 'octavo', 'noveno', 'décimo'];
const ES_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre',
  'noviembre', 'diciembre'];

// `genero`: 'pleno' (uno, al final), 'm' (un peso, veintiún días) o 'f' (una hora, doscientas personas).
function uno(genero, pleno, m, f) {
  return genero === 'f' ? f : genero === 'm' ? m : pleno;
}

function es99(n, genero) {
  if (n === 1) return uno(genero, 'uno', 'un', 'una');
  if (n === 21) return uno(genero, 'veintiuno', 'veintiún', 'veintiuna');
  if (n < 30) return ES_UNIDADES[n];
  const d = Math.floor(n / 10);
  const u = n % 10;
  if (!u) return ES_DECENAS[d];
  return `${ES_DECENAS[d]} y ${u === 1 ? uno(genero, 'uno', 'un', 'una') : ES_UNIDADES[u]}`;
}

function es999(n, genero) {
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const r = n % 100;
  let centena = ES_CENTENAS[c] || '';
  if (genero === 'f' && c >= 2) centena = centena.replace(/os$/, 'as');
  return [centena, r ? es99(r, genero) : ''].filter(Boolean).join(' ');
}

function esMenorMillon(n, genero) {
  const miles = Math.floor(n / 1000);
  const resto = n % 1000;
  const partes = [];
  if (miles === 1) partes.push('mil');
  else if (miles > 1) partes.push(`${es999(miles, genero === 'f' ? 'f' : 'm')} mil`);
  if (resto) partes.push(es999(resto, genero));
  return partes.join(' ');
}

export function esEntero(n, genero = 'pleno') {
  if (n === 0) return 'cero';
  const billones = Math.floor(n / 1e12);
  const millones = Math.floor((n % 1e12) / 1e6);
  const resto = n % 1e6;
  const partes = [];
  if (billones) partes.push(billones === 1 ? 'un billón' : `${esMenorMillon(billones, 'm')} billones`);
  if (millones) partes.push(millones === 1 ? 'un millón' : `${esMenorMillon(millones, 'm')} millones`);
  if (resto) partes.push(esMenorMillon(resto, genero));
  return partes.join(' ');
}

// ---------- inglés ----------

const EN_UNIDADES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_DECENAS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const EN_ORDINALES = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth',
};
const EN_MESES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];

function en99(n) {
  if (n < 20) return EN_UNIDADES[n];
  const d = Math.floor(n / 10);
  const u = n % 10;
  return u ? `${EN_DECENAS[d]}-${EN_UNIDADES[u]}` : EN_DECENAS[d];
}

function en999(n) {
  const c = Math.floor(n / 100);
  const r = n % 100;
  return [c ? `${EN_UNIDADES[c]} hundred` : '', r ? en99(r) : ''].filter(Boolean).join(' ');
}

export function enEntero(n) {
  if (n === 0) return 'zero';
  const partes = [];
  for (const [valor, nombre] of [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    const q = Math.floor(n / valor);
    if (q) {
      partes.push(`${en999(q % 1000)} ${nombre}`);
      n %= valor;
    }
  }
  if (n) partes.push(en999(n));
  return partes.join(' ');
}

// 1990 → nineteen ninety, 2026 → twenty twenty-six, 2005 → two thousand five.
function enAno(y) {
  if (y >= 2000 && y < 2010) return enEntero(y);
  const alto = Math.floor(y / 100);
  const bajo = y % 100;
  return `${en99(alto)} ${bajo === 0 ? 'hundred' : bajo < 10 ? `oh ${EN_UNIDADES[bajo]}` : en99(bajo)}`;
}

function enOrdinal(n) {
  const palabras = enEntero(n);
  const partes = palabras.split(/([ -])/);
  const ultima = partes.pop();
  const ordinal = EN_ORDINALES[ultima] || (ultima.endsWith('y') ? `${ultima.slice(0, -1)}ieth` : `${ultima}th`);
  return partes.join('') + ordinal;
}

// ---------- formato de los números del documento ----------

// Chileno ('es': 1.234.567,89) o inglés ('en': 1,234,567.89), según lo que no deja dudas en el
// documento. Si no hay nada claro, el del idioma. Los montos con grupos de 3 cifras cuentan
// ($391.889 es chileno): un monto casi nunca tiene 3 decimales.
export function detectarFormato(textos, idioma) {
  let es = 0;
  let en = 0;
  const cuenta = (t, re) => (t.match(re) || []).length;
  for (const t of textos) {
    if (!/\d[.,]\d/.test(t)) continue;
    es += cuenta(t, /\d{1,3}(?:\.\d{3}){2,}(?![\d,])|\d{1,3}(?:\.\d{3})+,\d+|\d,\d+\s?%|(?:\$|US\$|USD|CLP|UF)\s?\d{1,3}\.\d{3}(?![\d,])/g);
    en += cuenta(t, /\d{1,3}(?:,\d{3}){2,}(?![\d.])|\d{1,3}(?:,\d{3})+\.\d+|\d\.\d+\s?%|(?:\$|US\$|USD)\s?\d{1,3},\d{3}(?![\d.])/g);
  }
  if (es !== en) return es > en ? 'es' : 'en';
  return idioma === 'en' ? 'en' : 'es';
}

// "1.324.321" → { entero: 1324321, decimales: null }. null si no es una cantidad sino, por
// ejemplo, una cláusula ("3.2") o una versión ("1.2.3"). `cantidad`: es un monto, un
// porcentaje o lleva escala ("10.5 millones"): ahí "3.5" es decimal en cualquier formato.
function interpretar(s, formato, cantidad) {
  if (!/[.,]/.test(s)) return { entero: s, decimales: null };
  const conPunto = s.includes('.');
  const conComa = s.includes(',');
  if (conPunto && conComa) {
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const miles = dec === '.' ? ',' : '.';
    const k = s.lastIndexOf(dec);
    const ent = s.slice(0, k);
    if (ent.includes(dec) || !new RegExp(`^\\d{1,3}(?:\\${miles}\\d{3})*$`).test(ent)) return null;
    return { entero: ent.split(miles).join(''), decimales: s.slice(k + 1) };
  }
  const sep = conPunto ? '.' : ',';
  const partes = s.split(sep);
  const sepMiles = formato === 'es' ? '.' : ',';
  const enGrupos = /^\d{1,3}$/.test(partes[0]) && partes.slice(1).every((p) => p.length === 3);
  if (partes.length > 2) return enGrupos ? { entero: partes.join(''), decimales: null } : null;
  const [a, b] = partes;
  if (a === '0') return { entero: a, decimales: b };
  if (enGrupos && (sep === sepMiles || cantidad)) return { entero: a + b, decimales: null };
  if (sep !== sepMiles || cantidad) return { entero: a, decimales: b };
  return null;
}

// ---------- monedas y escalas ----------

const MONEDAS = {
  es: {
    $: ['peso', 'pesos'], CLP: ['peso', 'pesos'], 'US$': ['dólar', 'dólares'], 'U$S': ['dólar', 'dólares'],
    USD: ['dólar', 'dólares'], '€': ['euro', 'euros'], EUR: ['euro', 'euros'], UF: ['u efe', 'u efe'],
  },
  en: {
    $: ['dollar', 'dollars'], CLP: ['Chilean peso', 'Chilean pesos'], 'US$': ['dollar', 'dollars'],
    'U$S': ['dollar', 'dollars'], USD: ['dollar', 'dollars'], '€': ['euro', 'euros'], EUR: ['euro', 'euros'],
    UF: ['U F', 'U F'],
  },
};

function escalaPalabra(escala, es) {
  const e = escala.toLowerCase().replace(/\s+/g, ' ');
  if (/^(mil millones|bn|billions?)$/.test(e)) return es ? 'mil millones' : 'billion';
  if (/^(millones|millón|mm|mn|millions?)$/.test(e)) return es ? 'millones' : 'million';
  return es ? 'mil' : 'thousand';
}

// Palabras que no son sustantivos: delante de ellas el número va completo ("31 de mayo").
const ES_NO_SUSTANTIVOS = new Set(('de del a al y e o u en por para con sin que se su sus el la los las lo un una es son ' +
  'fue como más menos entre hasta desde sobre según durante mediante ante bajo tras contra hacia x ni pero').split(' '));
const ES_FEMENINOS = new Set(('hora horas persona personas vez veces semana semanas cuota cuotas página páginas unidad ' +
  'unidades acción acciones hectárea hectáreas tonelada toneladas libra libras cláusula cláusulas letra letras línea líneas ' +
  'noche noches sesión sesiones clase clases cuenta cuentas factura facturas boleta boletas mensualidad mensualidades ' +
  'empresa empresas oficina oficinas sociedad sociedades parte partes uf').split(' '));

function generoSiguiente(resto) {
  const palabra = resto.match(/^\s+([\p{L}]+)/u)?.[1]?.toLowerCase();
  if (!palabra || ES_NO_SUSTANTIVOS.has(palabra)) return 'pleno';
  return ES_FEMENINOS.has(palabra) ? 'f' : 'm';
}

// ---------- texto para la voz ----------

const NUM = String.raw`\d+(?:[.,]\d+)*`;
const RE_NUMERO = new RegExp(
  String.raw`(?<![\p{L}\p{N}_])` +
  String.raw`(?:(?<moneda>US\$|U\$S|USD|EUR|CLP|MM\$|M\$|\$|€|UF)\s?)?` +
  String.raw`(?<signo>[-−](?=\d))?` +
  `(?<num>${NUM})` +
  String.raw`(?<grado>[°ºª])?` +
  String.raw`(?:\s?(?<pct>%))?` +
  String.raw`(?:\s?(?<escala>mil\s+millones|millones|millón|mil|MM|mn|bn|millions?|billions?|thousand)(?![\p{L}]))?` +
  String.raw`(?:\s?(?<sufijo>USD|CLP|EUR|UF)(?![\p{L}]))?` +
  String.raw`(?![\p{L}\p{N}])`,
  'gu');
const RE_FECHA = /(?<![\p{L}\p{N}])(\d{1,2})([/-])(\d{1,2})\2(\d{4}|\d{2})(?![\p{L}\p{N}/-])/gu;
const RE_DOCUSIGN = /docusign envelope id:?\s*[0-9a-f-]{8,}/gi;

function digitos(s, es) {
  return [...s].map((c) => (es ? ES_UNIDADES : EN_UNIDADES)[+c]).join(' ');
}

function decimalesEnPalabras(d, es) {
  if (es && d.length <= 2 && d[0] !== '0') return esEntero(parseInt(d, 10));
  return digitos(d, es);
}

function fecha(m, d1, _sep, d2, a, es, formato) {
  let dia = +d1;
  let mes = +d2;
  if (!es && formato === 'en' && dia <= 12) [dia, mes] = [mes, dia]; // 10/15/2026
  if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return m;
  const ano = +a;
  if (es) return `${dia === 1 ? 'primero' : esEntero(dia)} de ${ES_MESES[mes - 1]} de ${esEntero(ano)}`;
  return `${EN_MESES[mes - 1]} ${enOrdinal(dia)}, ${a.length === 4 && ano >= 1100 && ano < 2100 ? enAno(ano) : enEntero(ano)}`;
}

function numero(m, g, resto, es, formato) {
  const moneda = g.moneda || g.sufijo || '';
  const esMonto = !!moneda;
  const v = interpretar(g.num, formato, esMonto || !!g.pct || !!g.escala);
  if (!v) {
    // Una cláusula o versión ("3.2", "1.2.3"): cada parte por separado.
    return g.num.split(/([.,])/).map((p) => (p === '.' ? (es ? ' punto ' : ' point ') : p === ',' ? ', '
      : es ? esEntero(parseInt(p, 10)) : enEntero(parseInt(p, 10)))).join('');
  }
  const { entero, decimales } = v;
  const n = parseInt(entero, 10);
  if (!Number.isSafeInteger(n)) return m;
  const signo = g.signo ? (es ? 'menos ' : 'minus ') : '';

  // Códigos y números largos sin separadores (cuentas, teléfonos): cifra por cifra.
  if (!esMonto && !g.pct && !g.escala && !decimales && !/[.,]/.test(g.num)
      && (entero.length >= 7 || (entero.length > 1 && entero[0] === '0'))) {
    return signo + digitos(entero, es);
  }

  // Ordinales: "Artículo 1°" → artículo primero.
  if (g.grado && !decimales && !esMonto && !g.pct) {
    if (!es) return `${signo}${enEntero(n)} degrees`;
    if (n >= 1 && n <= 10) return ES_ORDINALES[n].replace(/o$/, g.grado === 'ª' ? 'a' : 'o');
    return signo + esEntero(n);
  }

  let genero = 'pleno';
  if (es && !decimales) {
    if (moneda === 'UF') genero = 'f';
    else if (esMonto || g.escala) genero = 'm';
    else if (!g.pct) genero = generoSiguiente(resto);
  }
  let palabras;
  if (es) palabras = esEntero(n, genero);
  else palabras = !esMonto && !g.pct && !g.escala && !decimales && entero.length === 4 && n >= 1100 && n < 2100
    ? enAno(n) : enEntero(n);
  if (decimales) palabras += `${es ? ' coma ' : ' point '}${decimalesEnPalabras(decimales, es)}`;

  let escala = g.escala ? ` ${escalaPalabra(g.escala, es)}` : '';
  if (escala && es && n === 1 && !decimales && escala === ' millones') escala = ' millón';
  if (escala && es && n === 1 && !decimales && escala.startsWith(' mil')) palabras = ''; // mil, mil millones

  let texto = `${signo}${palabras}${escala}`.trim();
  if (g.pct) return `${texto}${es ? ' por ciento' : ' percent'}`;
  if (!moneda) return texto;

  // Montos: "$391.889" → trescientos noventa y un mil ochocientos ochenta y nueve pesos.
  if (moneda === 'MM$' || moneda === 'M$') {
    const millones = moneda === 'MM$';
    if (es) return `${texto} ${millones ? (n === 1 && !decimales ? 'millón' : 'millones') + ' de pesos' : 'mil pesos'}`.replace(/^un mil /, 'mil ');
    return `${texto} ${millones ? 'million' : 'thousand'} pesos`;
  }
  const nombres = (es ? MONEDAS.es : MONEDAS.en)[moneda];
  if (!nombres) return texto;
  let nombre = n === 1 && !decimales && !escala ? nombres[0] : nombres[1];
  // En inglés, "$" con números en formato chileno son pesos.
  if (!es && moneda === '$' && formato === 'es') nombre = n === 1 && !decimales && !escala ? 'peso' : 'pesos';
  const terminaEnMillon = /(millón|millones|billón|billones)$/.test(texto);
  return `${texto}${es && terminaEnMillon ? ' de' : ''} ${nombre}`;
}

// El texto que se le pasa a la voz. `formato`: el de detectarFormato.
export function paraVoz(texto, idioma, formato) {
  const es = idioma !== 'en';
  let t = texto.replace(RE_DOCUSIGN, ' ');
  t = t.replace(/(\d)\.-(?=[\s,;)]|$)/g, '$1');                       // "$39.393.-" (chileno)
  t = t.replace(es ? /\b[Nn][°º]\s?(?=\d)/g : /\bNo\.\s?(?=\d)/g, es ? 'número ' : 'number ');
  t = t.replace(RE_FECHA, (m, d1, sep, d2, a) => fecha(m, d1, sep, d2, a, es, formato));
  // RUT: "12.345.678-9" → … guion nueve. Rangos: "2024-2025" → dos mil veinticuatro a dos mil veinticinco.
  t = t.replace(/(?<![\p{L}\p{N}])(\d{1,2}\.\d{3}\.\d{3})-([\dkK])(?![\p{L}\p{N}])/gu,
    (m, num, dv) => `${num} guion ${/k/i.test(dv) ? 'ka' : dv}`);
  t = t.replace(/(?<![\p{L}\p{N}.,])(\d+)[-–](?=\d+(?![\p{L}\p{N}.,-]))/gu, `$1 ${es ? 'a' : 'to'} `);
  t = t.replace(RE_NUMERO, (m, ...args) => {
    const g = args.at(-1);
    const offset = args.at(-3);
    const todo = args.at(-2);
    return numero(m, g, todo.slice(offset + m.length), es, formato);
  });
  return t.replace(/\s{2,}/g, ' ').trim();
}
