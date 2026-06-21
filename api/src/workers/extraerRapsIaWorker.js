require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

/**
 * extraerRapsIaWorker.js — Cola "extraerRapsIa".
 *
 * QUÉ HACE (Fase 1 de "Cargar mis RAPs con IA"):
 *   El instructor sube la guía de aprendizaje en PDF; la ruta
 *   `POST /api/raps/extraer-ia` ya extrajo el texto y lo encoló aquí. Este worker
 *   pide a la IA que extraiga los RAPs (Resultados de Aprendizaje) + sus criterios
 *   y los deja PROPUESTOS en `Job.resultado` para que el instructor los confirme
 *   después con `POST /api/raps/import`.
 *
 * REGLA #8 DEL PROYECTO (la IA propone, el instructor decide):
 *   este worker NO escribe RAPs en la DB. Solo guarda la propuesta en el Job.
 *   La ÚNICA escritura que sí hace es asegurar el contenedor `Competencia` del
 *   usuario (shell con código+nombre) — eso NO son los RAPs, es el contenedor que
 *   evita que la página RAPs dé 422 y permite que el import funcione al confirmar.
 *
 * job.data: { jobId, userId, guiaTexto, competenciaCodigo }
 *   - jobId            id del modelo Job (para status/progreso/resultado).
 *   - userId           dueño del job (multi-tenant, regla #1).
 *   - guiaTexto        TEXTO ya extraído del PDF (no el binario — ver la ruta).
 *   - competenciaCodigo código ESTABLE de la competencia del usuario; los RAPs
 *                      propuestos deben empezar por él.
 *
 * SALIDA en Job.resultado (contrato con el frontend):
 *   { propuesta: { competenciaCodigo, competenciaNombre, raps: [{ codigo, descripcion, criterios: string[] }] },
 *     stats: { rapsPropuestos } }
 *
 * GOTCHA: chatJSON (lib/aiClient.js) extrae el primer objeto JSON por regex y NO
 *   depende de response_format. Aun así el modelo puede devolver algo sin `raps`;
 *   en ese caso dejamos el Job en "error" con mensaje claro (no tumbamos el worker).
 */

const { Worker } = require("bullmq");
const { connection } = require("../lib/queue");
const { chatJSON, proveedorActivo } = require("../lib/aiClient");
const prisma = require("../db/client");

// ─── Prompt IA ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "Eres un experto en el diseño curricular del SENA (Colombia). A partir del texto " +
  "de una guía de aprendizaje, extraes los Resultados de Aprendizaje del Proceso " +
  "(RAP) y sus criterios de evaluación. Respondes SIEMPRE con un único objeto JSON " +
  "válido, sin texto adicional ni explicaciones.";

/**
 * Prompt de usuario. Le damos el código de competencia objetivo para que los RAPs
 * propuestos empiecen por él (formato SENA `NNNNNNNNN-NN`: 9 dígitos, guion, 2 dígitos).
 * Conservamos hasta 60K chars de la guía: los RAPs viven al INICIO, pero los
 * "Criterios de evaluación" están MÁS ABAJO (en las guías SENA aparecen pasada la
 * pág. ~10; medido: la 1ª sección de criterios cae sobre el char ~44.000). Con un
 * recorte corto se perdían TODOS. Kimi K2 tiene contexto de sobra para 60K chars.
 */
function buildPrompt(guiaTexto, competenciaCodigo) {
  const texto = guiaTexto.length > 60000 ? guiaTexto.slice(0, 60000) : guiaTexto;
  return `Competencia objetivo (código): ${competenciaCodigo}

Texto de la guía de aprendizaje:
"""
${texto}
"""

Extrae SOLO los Resultados de Aprendizaje (RAP) y sus criterios que aparezcan en el texto. NO inventes nada que no esté en la guía.

Reglas:
- Los códigos de RAP tienen el formato NNNNNNNNN-NN (9 dígitos, guion, 2 dígitos) y deben empezar con el código de competencia objetivo (${competenciaCodigo}).
- "descripcion" es el resultado de aprendizaje en una sola oración.
- "criterios" es la lista de criterios de evaluación de ese RAP. Búscalos en las secciones "Criterios de evaluación" de la guía (suelen estar más abajo, junto a cada actividad/evidencia GA..-AA..-EV..) y asígnalos al RAP que corresponda. Déjala vacía [] solo si de verdad no aparecen.
- "competenciaNombre" es el nombre de la competencia si aparece en la guía; cadena vacía si no.

Responde SOLO con este JSON (sin prosa, sin markdown):
{
  "competenciaCodigo": "${competenciaCodigo}",
  "competenciaNombre": "",
  "raps": [
    { "codigo": "${competenciaCodigo}-01", "descripcion": "...", "criterios": ["...", "..."] }
  ]
}`;
}

// ─── Normalización de la propuesta IA ─────────────────────────────────────────────
// Saneamos lo que devuelve el modelo: filtramos RAPs sin código/descripción y
// normalizamos los criterios a un array de strings (el modelo a veces los devuelve
// como objetos {descripcion} o como una sola cadena).

// Recorta a la PRIMERA ORACIÓN + tope de longitud. La IA a veces arrastra el texto
// de la guía DESPUÉS del RAP ("...del programa de formación. • Duración de la guía...
// 2. PRESENTACIÓN Estimado aprendiz..."). Esto deja solo el RAP. Mismo saneo que
// scripts/extraerTodasLasGuias.js, que ya resolvía este caso con el extractor por regex.
function primeraOracion(t, max = 300) {
  let s = String(t ?? "").replace(/\s+/g, " ").trim();
  const p = s.search(/\.(?:\s|$)/);          // primer punto seguido de espacio o fin
  if (p > 20) s = s.slice(0, p + 1).trim();   // >20 para no cortar siglas cortas
  if (s.length > max) s = s.slice(0, max).trim();
  return s;
}

function normalizarPropuesta(parsed, competenciaCodigo) {
  const rapsRaw = Array.isArray(parsed?.raps) ? parsed.raps : null;
  if (!rapsRaw) return null; // sin `raps` → el caller lo trata como error

  const raps = rapsRaw
    .map((r) => {
      const codigo = String(r?.codigo ?? "").trim();
      // Saneo clave: el RAP es UNA oración; recortamos lo que la IA arrastre de la guía.
      const descripcion = primeraOracion(r?.descripcion, 300);

      let criterios = [];
      if (Array.isArray(r?.criterios)) {
        criterios = r.criterios
          .map((c) => primeraOracion(typeof c === "string" ? c : c?.descripcion, 300))
          .filter(Boolean);
      } else if (typeof r?.criterios === "string" && r.criterios.trim()) {
        criterios = [primeraOracion(r.criterios, 300)];
      }

      return { codigo, descripcion, criterios };
    })
    .filter((r) => r.codigo && r.descripcion);

  return {
    competenciaCodigo: String(parsed?.competenciaCodigo || competenciaCodigo).trim() || competenciaCodigo,
    competenciaNombre: String(parsed?.competenciaNombre || "").trim(),
    raps,
  };
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker("extraerRapsIa", async (job) => {
  const { jobId, userId, guiaTexto, competenciaCodigo } = job.data;

  console.log(`[extraerRapsIa] proveedor IA activo: ${proveedorActivo()} (comp ${competenciaCodigo})`);
  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 15 } });

  // 1. Pedir a la IA la extracción de RAPs. maxTokens alto: una guía produce varios
  //    RAPs con sus criterios.
  let parsed;
  try {
    parsed = await chatJSON({
      system:    SYSTEM_PROMPT,
      user:      buildPrompt(guiaTexto, competenciaCodigo),
      maxTokens: 4000,
    });
  } catch (err) {
    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "error", errorMsg: `La IA no pudo procesar la guía: ${err.message}` },
    });
    return;
  }

  await prisma.job.update({ where: { id: jobId }, data: { progreso: 70 } });

  // 2. Sanear la respuesta. Si no trae `raps`, es un error (no una propuesta vacía).
  const propuesta = normalizarPropuesta(parsed, competenciaCodigo);
  if (!propuesta) {
    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "error", errorMsg: "La IA no devolvió RAPs en el formato esperado." },
    });
    return;
  }

  // 3. Asegurar el CONTENEDOR Competencia del usuario (NO los RAPs — eso es la
  //    confirmación del instructor, regla #8). Sin esto, la página de RAPs sigue
  //    dando 422 y el import al confirmar no encuentra dónde colgar los RAPs.
  //    El nombre sale de lo que detectó la IA, o un placeholder editable.
  const nombreComp = propuesta.competenciaNombre || `Competencia ${competenciaCodigo}`;
  await prisma.competencia.upsert({
    where:  { codigo: competenciaCodigo },
    // update vacío a propósito: si la competencia ya existe NO le pisamos el nombre
    // (puede haber sido curado a mano; el placeholder solo aplica al crearla).
    create: { codigo: competenciaCodigo, nombre: nombreComp },
    update: {},
  });

  // 4. Guardar la propuesta en el Job para que el instructor la revise y confirme.
  await prisma.job.update({
    where: { id: jobId },
    data:  {
      status:    "done",
      progreso:  100,
      resultado: {
        propuesta,
        stats: { rapsPropuestos: propuesta.raps.length },
      },
    },
  });

  console.log(`[extraerRapsIa] job ${jobId}: ${propuesta.raps.length} RAP(s) propuestos para ${competenciaCodigo}.`);
}, { connection, concurrency: Number(process.env.EXTRAER_RAPS_CONCURRENCY) || 4 });
// concurrency 4: la extracción es I/O-bound (espera a OpenRouter), así que varias
// corren en paralelo sin saturar CPU/RAM — soporta ráfagas de varios instructores
// subiendo guías a la vez. Ajustable por env si hace falta bajarle por rate-limit de IA.

// ─── Error handler ────────────────────────────────────────────────────────────
// Red de seguridad: cualquier error no atrapado arriba deja el Job en "error".
worker.on("failed", async (job, err) => {
  console.error("[extraerRapsIa] job failed:", err.message);
  if (job?.data?.jobId) {
    await prisma.job.update({
      where: { id: job.data.jobId },
      data:  { status: "error", errorMsg: err.message },
    }).catch(() => {});
  }
});

module.exports = worker;
