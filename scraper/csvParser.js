/**
 * csvParser.js — Parser y clasificador de notas para Actas GOR-F-084 V02
 *
 * Entrada: texto CSV exportado desde el libro de calificaciones de Zajuna/Moodle
 * Salida:  array de aprendices clasificados + resumen de totales
 *
 * Uso standalone (diagnóstico):
 *   node scraper/csvParser.js path/al/archivo.csv
 *
 * Uso como módulo:
 *   const { parsearCSVActa } = require("./scraper/csvParser")
 *   const { filas, resumen, errores } = parsearCSVActa(csvText)
 */

// ─── Códigos RAP de inglés en scope ──────────────────────────────────────────

const COMPETENCIA = "240202501";
const RAP_NUMS    = ["01", "02", "03", "04", "05", "06"];
const RAP_CODIGOS = RAP_NUMS.map(n => `${COMPETENCIA}-${n}`);

// ─── Helpers CSV ─────────────────────────────────────────────────────────────

/**
 * Parsea una línea CSV con soporte de comillas y comas dentro de campos.
 * Devuelve array de strings (sin comillas externas).
 */
function parsearLineaCSV(linea) {
  const campos = [];
  let actual   = "";
  let enComilla = false;

  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') {
      if (enComilla && linea[i + 1] === '"') {
        actual += '"';
        i++;
      } else {
        enComilla = !enComilla;
      }
    } else if (c === "," && !enComilla) {
      campos.push(actual.trim());
      actual = "";
    } else {
      actual += c;
    }
  }
  campos.push(actual.trim());
  return campos;
}

/**
 * Parsea texto CSV completo → array de objetos { header: value }.
 * Ignora líneas vacías.
 */
function parsearCSV(texto) {
  const lineas = texto
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter(l => l.trim().length > 0);

  if (lineas.length < 2) return [];

  const headers = parsearLineaCSV(lineas[0]).map(h => h.replace(/﻿/g, "").trim());
  const filas   = [];

  for (let i = 1; i < lineas.length; i++) {
    const vals = parsearLineaCSV(lineas[i]);
    const fila = {};
    headers.forEach((h, idx) => {
      fila[h] = vals[idx] ?? "";
    });
    filas.push(fila);
  }
  return filas;
}

// ─── Detección de columnas ─────────────────────────────────────────────────────

const NOMBRES_COLUMNA_NOMBRE = [
  "nombre completo", "full name", "nombre", "name",
];
const NOMBRES_COLUMNA_DOCUMENTO = [
  "número de documento", "numero de documento", "documento", "cédula", "cedula",
  "id number", "identification", "número de identificación", "numero de identificacion",
];

function buscarColumna(headers, candidatos) {
  for (const h of headers) {
    const norm = h.toLowerCase().replace(/[_\-]/g, " ").trim();
    for (const c of candidatos) {
      if (norm === c || norm.includes(c)) return h;
    }
  }
  return null;
}

/**
 * Detecta qué columnas del CSV corresponden a cada RAP.
 * Patrones soportados:
 *   - "240202501-01" (código exacto)
 *   - "GA01-240202501-AA01 Descripción" (nombre de actividad Moodle SENA)
 *   - "240202501-01 Evidencia escrita" (código + texto libre)
 *
 * Retorna Map<rapCodigo, nombreColumna> solo para RAPs en scope.
 */
function detectarColumnasRap(headers) {
  const mapa = new Map();

  for (const h of headers) {
    // Solo procesar headers que contengan el código de competencia
    if (!h.includes(COMPETENCIA)) continue;

    for (const codigo of RAP_CODIGOS) {
      const num = codigo.split("-")[1]; // "01" a "06"

      // Patrón 1: código exacto "240202501-01"
      if (h.includes(codigo)) {
        if (!mapa.has(codigo)) mapa.set(codigo, h);
        break;
      }

      // Patrón 2: Moodle SENA "GA{N}-240202501-AA{N}" donde N = num del RAP
      // El número de AA y el del RAP deben coincidir
      const regexAA = new RegExp(`-AA${num}(?:[^0-9]|$)`, "i");
      if (regexAA.test(h)) {
        if (!mapa.has(codigo)) mapa.set(codigo, h);
        break;
      }

      // Patrón 3: "240202501" seguido en algún lugar por "-{num}" con el num exacto
      const regexGuion = new RegExp(`[^0-9]${num}(?:[^0-9]|$)`);
      if (regexGuion.test(h.replace(COMPETENCIA, ""))) {
        if (!mapa.has(codigo)) mapa.set(codigo, h);
        break;
      }
    }
  }
  return mapa;
}

// ─── Validación de filas ──────────────────────────────────────────────────────

const REGEX_INICIALES = /^[A-Z]{1,2}$/;

function esNombreValido(nombre) {
  if (!nombre || typeof nombre !== "string") return false;
  const partes = nombre.trim().split(/\s+/).filter(p => p.length > 0);
  if (partes.length < 2) return false;
  // Rechazar si TODAS las partes son iniciales (1-2 letras mayúsculas)
  if (partes.every(p => REGEX_INICIALES.test(p))) return false;
  return true;
}

function esDocumentoValido(doc) {
  if (!doc || typeof doc !== "string") return false;
  const limpio = doc.trim().replace(/[.\s-]/g, "");
  return /^\d{7,10}$/.test(limpio);
}

// ─── Clasificador ─────────────────────────────────────────────────────────────

function esAprobado(valor) {
  if (!valor || typeof valor !== "string") return false;
  const v = valor.trim().toUpperCase();
  return v === "A" || v === "APROBADO" || v === "APROBÓ" || v === "APPROVED";
}

/**
 * Aplica las 4 reglas de clasificación GOR-F-084 V02.
 *
 * Regla 1: TODOS 6 RAPs = A → "Aprobó"
 * Regla 2: ALGUNOS = A     → "Evidencias pendientes (RAP XX, RAP YY)"
 * Regla 3: NINGUNO = A + tiene cualquier registro → "Evidencias pendientes (RAP 01–06)"
 * Regla 4: SIN NINGÚN registro → "No participó"
 */
function clasificarAprendiz(gradesMap) {
  const aprobados  = [];
  const pendientes = [];
  let   tieneRegistro = false;

  for (const codigo of RAP_CODIGOS) {
    const val = gradesMap.get(codigo);
    if (val !== undefined && val.trim() !== "") tieneRegistro = true;
    if (esAprobado(val)) {
      aprobados.push(codigo.split("-")[1]);  // "01"
    } else {
      pendientes.push(codigo.split("-")[1]);
    }
  }

  // Regla 1
  if (aprobados.length === RAP_NUMS.length) {
    return {
      estado:      "Aprobó",
      rapsAprobados: aprobados,
      rapsPendientes: [],
    };
  }

  // Regla 2: algunos aprobados
  if (aprobados.length > 0) {
    const listaPend = pendientes.map(n => `RAP ${n}`).join(", ");
    return {
      estado:        `Evidencias pendientes (${listaPend})`,
      rapsAprobados: aprobados,
      rapsPendientes: pendientes,
    };
  }

  // Regla 3: ninguno aprobado pero tiene registros
  if (tieneRegistro) {
    const todosStr = pendientes.map(n => `RAP ${n}`).join(", ");
    return {
      estado:        `Evidencias pendientes (${todosStr})`,
      rapsAprobados: [],
      rapsPendientes: pendientes,
    };
  }

  // Regla 4: sin ningún registro
  return {
    estado:        "No participó",
    rapsAprobados: [],
    rapsPendientes: [],
  };
}

// ─── Función principal ────────────────────────────────────────────────────────

/**
 * Parsea el texto CSV de un libro de calificaciones Zajuna y retorna aprendices
 * clasificados según GOR-F-084 V02.
 *
 * @param {string} csvText — Texto completo del CSV (cualquier encoding UTF-8 / ANSI)
 * @returns {{
 *   filas: Array<{nombre,documento,estado,rapsAprobados,rapsPendientes,warningCount}>,
 *   resumen: {total,aprobaron,pendientes,noParticiparon},
 *   errores: string[],
 *   columnasDetectadas: { nombre: string|null, documento: string|null, raps: string[] }
 * }}
 */
function parsearCSVActa(csvText) {
  const errores = [];
  const filasRaw = parsearCSV(csvText);

  if (filasRaw.length === 0) {
    return { filas: [], resumen: { total: 0, aprobaron: 0, pendientes: 0, noParticiparon: 0 }, errores: ["CSV vacío o sin filas de datos"], columnasDetectadas: { nombre: null, documento: null, raps: [] } };
  }

  const headers = Object.keys(filasRaw[0]);

  // Detectar columnas
  const colNombre    = buscarColumna(headers, NOMBRES_COLUMNA_NOMBRE);
  const colDocumento = buscarColumna(headers, NOMBRES_COLUMNA_DOCUMENTO);
  const mapaRaps     = detectarColumnasRap(headers);

  if (!colNombre) {
    errores.push(`No se encontró columna de nombre. Columnas disponibles: ${headers.slice(0, 8).join(", ")}`);
  }

  const rapsEncontrados = [...mapaRaps.keys()];
  if (rapsEncontrados.length === 0) {
    errores.push(`No se encontraron columnas de RAPs (${COMPETENCIA}). Columnas disponibles: ${headers.slice(0, 8).join(", ")}`);
  }

  // Procesar filas
  const filas = [];
  let filasDescartadas = 0;

  for (const fila of filasRaw) {
    const nombre    = colNombre    ? (fila[colNombre]    || "").trim() : "";
    const documento = colDocumento ? (fila[colDocumento] || "").trim() : "";

    // Filtrar filas inválidas
    if (!esNombreValido(nombre)) {
      filasDescartadas++;
      continue;
    }
    // documento es opcional si no se encontró la columna, pero si existe debe ser válido
    if (colDocumento && documento && !esDocumentoValido(documento)) {
      filasDescartadas++;
      continue;
    }

    // Construir mapa de grades para este aprendiz
    const gradesMap = new Map();
    for (const [codigo, colHeader] of mapaRaps) {
      gradesMap.set(codigo, fila[colHeader] || "");
    }

    const clasificacion = clasificarAprendiz(gradesMap);

    filas.push({
      nombre,
      documento:      esDocumentoValido(documento) ? documento.replace(/[.\s-]/g, "") : null,
      estado:         clasificacion.estado,
      rapsAprobados:  clasificacion.rapsAprobados,
      rapsPendientes: clasificacion.rapsPendientes,
      warningCount:   0,  // se rellena en el endpoint con query a MensajeFormativo
    });
  }

  if (filasDescartadas > 0) {
    errores.push(`${filasDescartadas} fila(s) descartada(s) por nombre o documento inválido`);
  }

  // Calcular resumen
  let aprobaron     = 0;
  let pendientes    = 0;
  let noParticiparon = 0;

  for (const f of filas) {
    if (f.estado === "Aprobó")              aprobaron++;
    else if (f.estado.startsWith("Evidencias pendientes")) pendientes++;
    else if (f.estado === "No participó")   noParticiparon++;
  }

  const total = filas.length;

  // Hard-fail si los totales no cuadran
  if (aprobaron + pendientes + noParticiparon !== total) {
    errores.push(`ERROR CRÍTICO: totales no cuadran: ${aprobaron}+${pendientes}+${noParticiparon} ≠ ${total}`);
  }

  return {
    filas,
    resumen: { total, aprobaron, pendientes, noParticiparon },
    errores,
    columnasDetectadas: {
      nombre:    colNombre,
      documento: colDocumento,
      raps:      rapsEncontrados,
    },
  };
}

module.exports = { parsearCSVActa, clasificarAprendiz, esNombreValido, esDocumentoValido };

// ─── Tests inline (node scraper/csvParser.js) ──────────────────────────────────

if (require.main === module) {
  const fs   = require("fs");
  const path = require("path");

  const csvArg = process.argv[2];

  if (csvArg) {
    // Modo archivo: node scraper/csvParser.js ruta.csv
    const texto = fs.readFileSync(path.resolve(csvArg), "utf8");
    const resultado = parsearCSVActa(texto);
    console.log("\n=== Columnas detectadas ===");
    console.log("Nombre:", resultado.columnasDetectadas.nombre);
    console.log("Documento:", resultado.columnasDetectadas.documento);
    console.log("RAPs:", resultado.columnasDetectadas.raps.join(", ") || "NINGUNO — verificar headers del CSV");
    console.log("\n=== Resumen ===");
    console.log(`Total: ${resultado.resumen.total} | Aprobó: ${resultado.resumen.aprobaron} | Pendientes: ${resultado.resumen.pendientes} | No participó: ${resultado.resumen.noParticiparon}`);
    if (resultado.errores.length > 0) {
      console.log("\n=== Errores/Advertencias ===");
      resultado.errores.forEach(e => console.log("  ⚠", e));
    }
    console.log("\n=== Primeras 5 filas ===");
    resultado.filas.slice(0, 5).forEach(f => {
      console.log(`  ${f.nombre.padEnd(35)} | doc:${(f.documento || "—").padEnd(12)} | ${f.estado}`);
    });
    return;
  }

  // Modo tests internos
  console.log("=== Tests csvParser ===\n");
  let ok = 0; let fail = 0;

  function test(label, fn) {
    try {
      fn();
      console.log(`  ✅ ${label}`);
      ok++;
    } catch (e) {
      console.log(`  ❌ ${label}: ${e.message}`);
      fail++;
    }
  }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || "assertion failed");
  }

  // Tests de validación
  test("nombre válido — 2 palabras", () => assert(esNombreValido("JUAN JOSE SIERRA ORTEGA")));
  test("nombre inválido — 1 palabra", () => assert(!esNombreValido("JUAN")));
  test("nombre inválido — solo iniciales YZ", () => assert(!esNombreValido("YZ")));
  test("nombre inválido — iniciales dobles LP", () => assert(!esNombreValido("LP")));
  test("nombre inválido — vacío", () => assert(!esNombreValido("")));
  test("documento válido — 10 dígitos", () => assert(esDocumentoValido("1092647286")));
  test("documento válido — 7 dígitos", () => assert(esDocumentoValido("1234567")));
  test("documento inválido — 6 dígitos", () => assert(!esDocumentoValido("123456")));
  test("documento inválido — 11 dígitos", () => assert(!esDocumentoValido("12345678901")));
  test("documento inválido — letras", () => assert(!esDocumentoValido("12345678A")));

  // Regla 1: todos aprobados
  test("Regla 1 — todos 6 RAPs = A → Aprobó", () => {
    const grades = new Map(RAP_CODIGOS.map(c => [c, "A"]));
    const r = clasificarAprendiz(grades);
    assert(r.estado === "Aprobó", `Estado fue: ${r.estado}`);
    assert(r.rapsAprobados.length === 6);
    assert(r.rapsPendientes.length === 0);
  });

  // Regla 2: 5 de 6 aprobados
  test("Regla 2 — 5 de 6 A → pendiente RAP 06", () => {
    const grades = new Map(RAP_CODIGOS.map((c, i) => [c, i < 5 ? "A" : ""]));
    const r = clasificarAprendiz(grades);
    assert(r.estado.startsWith("Evidencias pendientes"), `Estado fue: ${r.estado}`);
    assert(r.estado.includes("RAP 06"), `No menciona RAP 06: ${r.estado}`);
    assert(r.rapsAprobados.length === 5);
    assert(r.rapsPendientes.includes("06"));
  });

  // Regla 2: 4 de 6 aprobados
  test("Regla 2 — 4 de 6 A → pendientes RAP 05, RAP 06", () => {
    const grades = new Map(RAP_CODIGOS.map((c, i) => [c, i < 4 ? "A" : ""]));
    const r = clasificarAprendiz(grades);
    assert(r.estado.includes("RAP 05"), `No menciona RAP 05: ${r.estado}`);
    assert(r.estado.includes("RAP 06"), `No menciona RAP 06: ${r.estado}`);
  });

  // Regla 3: 0 A + tiene registro
  test("Regla 3 — 0 A + tiene registro → Evidencias pendientes (RAP 01–06)", () => {
    const grades = new Map(RAP_CODIGOS.map(c => [c, "D"]));
    const r = clasificarAprendiz(grades);
    assert(r.estado.startsWith("Evidencias pendientes"), `Estado fue: ${r.estado}`);
    assert(r.rapsAprobados.length === 0);
  });

  // Regla 4: sin ningún registro
  test("Regla 4 — sin registro → No participó", () => {
    const grades = new Map(RAP_CODIGOS.map(c => [c, ""]));
    const r = clasificarAprendiz(grades);
    assert(r.estado === "No participó", `Estado fue: ${r.estado}`);
  });

  // Test CSV completo
  test("parsearCSVActa — CSV de muestra", () => {
    const csv = [
      `Nombre completo,Número de documento,GA01-${COMPETENCIA}-AA01,GA02-${COMPETENCIA}-AA02,GA03-${COMPETENCIA}-AA03,GA04-${COMPETENCIA}-AA04,GA05-${COMPETENCIA}-AA05,GA06-${COMPETENCIA}-AA06`,
      `"JUAN JOSE SIERRA ORTEGA",1092647286,A,A,A,A,A,A`,
      `"MARIA CAROLINA RUIZ PEREZ",1098765432,A,A,A,A,A,`,
      `"PEDRO LUIS GARCIA MORENO",1087654321,D,,,,,`,
      `"CAROLINA ANDREA FLORES VEGA",1076543210,,,,,`,
      `"YZ",,A,A,A,A,A,A`,  // inválido — iniciales
      `"SOLO",,A,A,A,A,A,A`, // inválido — 1 palabra
    ].join("\n");

    const r = parsearCSVActa(csv);
    assert(r.filas.length === 4, `Esperaba 4 filas, obtuvo ${r.filas.length}`);
    assert(r.resumen.aprobaron === 1, `Esperaba 1 Aprobó, obtuvo ${r.resumen.aprobaron}`);
    assert(r.resumen.pendientes === 2, `Esperaba 2 pendientes, obtuvo ${r.resumen.pendientes}`);
    assert(r.resumen.noParticiparon === 1, `Esperaba 1 no participó, obtuvo ${r.resumen.noParticiparon}`);
    assert(r.resumen.total === 4, `Esperaba total 4, obtuvo ${r.resumen.total}`);
  });

  console.log(`\n${ok} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
