/**
 * actaSaneado.js — Saneo de los textos del acta GOR-F-084 antes de generar el Word.
 *
 * POR QUÉ: el acta se arma con datos scrapeados de Zajuna y extraídos de PDFs de
 * guías. Varios campos salen "sucios" y antes se imprimían crudos en el documento
 * institucional (ver auditoría del agente, jun 2026):
 *   - `RAP.descripcion` arrastra basura del PDF ("• Duración de la guía… 2. PRESENTACIÓN…")
 *     e incluso mezcla texto de OTRA competencia.
 *   - `Competencia.nombre` a veces es el placeholder "[Sin nombre — Guía de aprendizaje N…]".
 *   - `Ficha.programa`/`nombre` son códigos internos ("P_228118_V_3070432_R_68_C_9545").
 *   - `documento` viene pegado y en minúscula ("79451297cc" en vez de "CC 79451297").
 *   - El `objetivo` lo teclea el instructor y puede traer typos ("lengua extranjero").
 *
 * DOS NIVELES:
 *   1. Limpiadores DETERMINISTAS (siempre corren, sin tokens): formato de documento,
 *      detección de placeholders, primera oración del RAP, detección de código de
 *      programa. Reparan lo mecánico sin depender de la IA.
 *   2. Pasada de IA (opcional, `sanearActaConIA`): para lo que el código no puede
 *      adivinar (redactar el nombre real de la competencia/programa, limpiar la
 *      descripción del RAP conservando solo el resultado de aprendizaje, corregir
 *      typos). Usa el cliente agnóstico `aiClient.js` (OpenRouter/Kimi/Anthropic).
 *
 * REGLA #8 DEL PROYECTO: la IA solo repara TEXTO de extracción (descripciones,
 * nombres). NUNCA toca los juicios académicos (aprobó/pendiente) — esos siguen
 * calculándose deterministamente en lib/calificacion. La IA no decide notas.
 *
 * ROBUSTEZ: `sanearActaConIA` JAMÁS lanza. Si la IA falla, no hay API key, o tarda,
 * devuelve los textos ya limpiados por la capa determinista. La descarga del acta
 * nunca se rompe por culpa de la IA.
 *
 * CACHE: en memoria por proceso (Map keyed por hash de las entradas) para no gastar
 * tokens al re-descargar la misma acta. Se pierde al reiniciar (aceptable: el costo
 * es una llamada barata por acta y sesión).
 *
 * KILL-SWITCH: `ACTA_IA=0` desactiva la pasada de IA (solo determinista).
 */

const crypto = require("crypto");
const { chatJSON, proveedorActivo } = require("./aiClient");

// ════════════════════════════════════════════════════════════════════════════
// 1. LIMPIADORES DETERMINISTAS
// ════════════════════════════════════════════════════════════════════════════

// Tipos de documento de identidad que usa el SENA (Colombia).
const TIPOS_DOC = ["CC", "TI", "CE", "PPT", "PEP", "NIT", "RC", "NUIP", "PA"];
const TIPOS_DOC_RE = TIPOS_DOC.join("|");

/**
 * Normaliza el documento al formato "CC 79451297".
 * Maneja sufijo pegado ("79451297cc"), prefijo ("cc 79451297"), o número solo.
 * Devuelve "—" si está vacío.
 */
function formatearDocumento(doc) {
  if (doc === null || doc === undefined) return "—";
  const s = String(doc).trim();
  if (!s) return "—";

  // Sufijo pegado o separado: "79451297cc", "1076739181 ti"
  let m = s.match(new RegExp(`^(\\d[\\d.\\-]*)\\s*(${TIPOS_DOC_RE})$`, "i"));
  if (m) return `${m[2].toUpperCase()} ${m[1]}`;

  // Prefijo: "CC 79451297", "ti1076739181"
  m = s.match(new RegExp(`^(${TIPOS_DOC_RE})\\s*(\\d[\\d.\\-]*)$`, "i"));
  if (m) return `${m[1].toUpperCase()} ${m[2]}`;

  // Solo número → asumimos CC (lo más común); si no es numérico, lo dejamos crudo.
  if (/^\d[\d.\-]*$/.test(s)) return `CC ${s}`;
  return s;
}

/**
 * ¿Es el nombre un placeholder de competencia sin nombre real?
 * Ej. "[Sin nombre — Guía de aprendizaje 1 Página]" (ver CLAUDE.md §Notas técnicas).
 */
function esPlaceholderCompetencia(nombre) {
  if (!nombre) return true;
  return /\[\s*sin\s+nombre/i.test(nombre) || /guía\s+de\s+aprendizaje\s+\d+\s+págin/i.test(nombre);
}

/**
 * ¿Es el "nombre" en realidad un código interno de programa/ficha?
 * Ej. "P_228118", "P_228118_V_3070432_R_68_C_9545".
 */
function esCodigoPrograma(nombre) {
  if (!nombre) return false;
  return /^P_\d+(_[A-Za-z]_?\w+)*$/i.test(nombre.trim());
}

/**
 * Extrae la PRIMERA oración limpia de una descripción de RAP, cortando la basura
 * del PDF (viñetas, "Duración de la guía", "PRESENTACIÓN", "Transversal:"…).
 * Es la misma idea que el extractor de guías pero aplicada en lectura, como red
 * de seguridad cuando el dato ya quedó sucio en DB.
 */
function primeraOracionRap(desc) {
  if (!desc) return "";
  let t = String(desc).trim();

  // Cortar en los marcadores típicos de basura del PDF de guías SENA.
  const cortes = [
    /\s*[••]/,                       // viñeta
    /\s*\bDuración\s+de\s+la\s+guía\b/i,
    /\s*\d+\.\s*PRESENTACIÓN\b/i,
    /\s*\bPRESENTACIÓN\b/i,
    /\s*\bTransversal\s*:/i,
    /\s*\bTécnica\s*:/i,
    /\s*\bClave\s*:/i,
  ];
  for (const c of cortes) {
    const idx = t.search(c);
    if (idx > 20) t = t.slice(0, idx);   // >20 para no cortar una descripción muy corta
  }

  // Quedarnos con la primera oración (hasta el primer punto seguido de espacio/fin).
  const m = t.match(/^[\s\S]*?[.](?:\s|$)/);
  let out = (m ? m[0] : t).trim();

  // Red de seguridad de longitud.
  if (out.length > 300) out = out.slice(0, 300).trim() + "…";
  return out;
}

/**
 * Aplica TODA la capa determinista sobre los campos del acta.
 * Devuelve `{ competenciaNombre, programaNombre, objetivo, raps }` saneados.
 * No depende de la IA ni de la red.
 *
 * @param {object} campos
 * @param {string} campos.competenciaNombre
 * @param {string} campos.competenciaCodigo
 * @param {string} campos.programaNombre   nombre/programa crudo de la ficha
 * @param {string} campos.objetivo
 * @param {Array<{codigo:string, descripcion:string}>} campos.raps
 */
function sanearDeterminista({ competenciaNombre, competenciaCodigo, programaNombre, objetivo, raps }) {
  let comp = competenciaNombre;
  if (esPlaceholderCompetencia(comp)) {
    // Sin nombre real: usar solo el código (lee natural tras "...de la competencia
    // 240202501"); si no hay código, dejar vacío y que el caller decida el fallback.
    comp = competenciaCodigo || "";
  }

  let prog = programaNombre;
  if (esCodigoPrograma(prog)) prog = "";   // el caller cae a otra fuente legible

  const rapsLimpios = (raps || []).map(r => ({
    codigo:      r.codigo,
    descripcion: primeraOracionRap(r.descripcion),
  }));

  return {
    competenciaNombre: comp,
    programaNombre:    prog,
    objetivo:          (objetivo || "").trim(),
    raps:              rapsLimpios,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 2. PASADA DE IA (opcional, con fallback y cache)
// ════════════════════════════════════════════════════════════════════════════

const _cache = new Map();   // hash → resultado saneado

function _hash(obj) {
  return crypto.createHash("sha1").update(JSON.stringify(obj)).digest("hex");
}

const SYSTEM_PROMPT =
  "Eres un asistente experto en formación del SENA (Colombia) que limpia texto " +
  "extraído automáticamente de PDFs de guías de aprendizaje. El texto trae basura " +
  "de extracción (viñetas, 'Duración de la guía', 'PRESENTACIÓN', mezclas de otras " +
  "competencias). Tu trabajo es devolver SOLO el texto correcto y conciso de cada " +
  "campo, sin inventar contenido que no esté en la entrada. Para los Resultados de " +
  "Aprendizaje (RAP), conserva EXACTAMENTE la acción del resultado (la primera " +
  "oración real) y elimina lo demás. Corrige errores gramaticales evidentes. " +
  "Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional ni markdown.";

/**
 * Construye el prompt de usuario con los campos a sanear.
 */
function _construirPromptUsuario(campos) {
  return (
    "Limpia los siguientes campos de un acta de seguimiento SENA y devuelve un JSON " +
    "con EXACTAMENTE esta forma:\n" +
    '{\n' +
    '  "competenciaNombre": "<nombre real y legible de la competencia, o cadena vacía si no se puede saber>",\n' +
    '  "programaNombre": "<nombre legible del programa de formación, o cadena vacía>",\n' +
    '  "objetivo": "<objetivo corregido gramaticalmente>",\n' +
    '  "raps": [ { "codigo": "<mismo código de entrada>", "descripcion": "<solo el resultado de aprendizaje, una oración limpia>" } ]\n' +
    "}\n\n" +
    "No agregues, quites ni reordenes RAPs: devuelve uno por cada código de entrada, " +
    "con el MISMO código. Si un campo de entrada ya está limpio, devuélvelo igual.\n\n" +
    "ENTRADA:\n" + JSON.stringify(campos, null, 2)
  );
}

/**
 * Valida y normaliza la salida de la IA contra la entrada (defensa anti-alucinación):
 * - Los códigos de RAP de salida deben corresponder a los de entrada.
 * - Si la IA devolvió un RAP de menos o cambió un código, se conserva el determinista.
 */
function _reconciliarRaps(rapsIA, rapsDet) {
  const porCodigo = new Map((rapsIA || []).map(r => [String(r.codigo), r.descripcion]));
  return rapsDet.map(r => {
    const descIA = porCodigo.get(String(r.codigo));
    return {
      codigo:      r.codigo,
      descripcion: (descIA && String(descIA).trim()) ? String(descIA).trim() : r.descripcion,
    };
  });
}

/**
 * Sanea el acta con la capa determinista y, si está habilitado, con una pasada de IA.
 * NUNCA lanza: ante cualquier fallo devuelve el resultado determinista.
 *
 * @param {object} [opts] - { userId } para atribuir el consumo de tokens al instructor.
 * @returns {Promise<{competenciaNombre, programaNombre, objetivo, raps, fuente}>}
 *   `fuente` = "ia" | "determinista" (útil para log/UI).
 */
async function sanearActa(campos, opts = {}) {
  const det = sanearDeterminista(campos);

  // Kill-switch o sin proveedor → solo determinista.
  if (process.env.ACTA_IA === "0") return { ...det, fuente: "determinista" };

  // Entrada para la IA: lo crudo (para que pueda inferir el nombre real), no lo ya
  // recortado, salvo el documento. Le pasamos código + nombre crudos.
  const entradaIA = {
    competenciaCodigo: campos.competenciaCodigo || "",
    competenciaNombre: campos.competenciaNombre || "",
    programaNombre:    campos.programaNombre || "",
    objetivo:          campos.objetivo || "",
    raps:              (campos.raps || []).map(r => ({ codigo: r.codigo, descripcion: r.descripcion })),
  };

  const key = _hash(entradaIA);
  if (_cache.has(key)) return _cache.get(key);

  // Timeout duro: si la IA tarda más que esto, degradamos a determinista para no
  // colgar la descarga del acta (el fetch de aiClient no tiene timeout propio).
  const timeoutMs = Number(process.env.ACTA_IA_TIMEOUT_MS) || 20000;

  try {
    const out = await Promise.race([
      chatJSON({
        system:    SYSTEM_PROMPT,
        user:      _construirPromptUsuario(entradaIA),
        maxTokens: 1200,
        userId:    opts.userId || null,
        feature:   "acta-saneado",
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timeout ${timeoutMs}ms`)), timeoutMs)),
    ]);

    const resultado = {
      // Si la IA devuelve vacío, caemos al determinista.
      competenciaNombre: (out.competenciaNombre && String(out.competenciaNombre).trim()) || det.competenciaNombre,
      programaNombre:    (out.programaNombre && String(out.programaNombre).trim()) || det.programaNombre,
      objetivo:          (out.objetivo && String(out.objetivo).trim()) || det.objetivo,
      raps:              _reconciliarRaps(out.raps, det.raps),
      fuente:            "ia",
    };
    _cache.set(key, resultado);
    return resultado;
  } catch (err) {
    // La IA es best-effort: logueamos y seguimos con lo determinista.
    console.warn(`[actaSaneado] IA no disponible (${proveedorActivo()}): ${err.message}. Uso saneo determinista.`);
    return { ...det, fuente: "determinista" };
  }
}

module.exports = {
  // deterministas (también exportados para tests y uso directo)
  formatearDocumento,
  esPlaceholderCompetencia,
  esCodigoPrograma,
  primeraOracionRap,
  sanearDeterminista,
  // pasada completa (determinista + IA con fallback)
  sanearActa,
};
