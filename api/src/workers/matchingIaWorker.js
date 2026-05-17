require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const Anthropic  = require("@anthropic-ai/sdk");
const { connection } = require("../lib/queue");
const prisma = require("../db/client");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the prompt for Claude to match a single evidencia against a list of RAPs.
 */
function buildPrompt(ev, raps) {
  return `Eres un evaluador de competencias SENA. Dada la siguiente evidencia de aprendizaje, determina cuál de los RAPs (Resultados de Aprendizaje del Proceso) de la lista evalúa mejor.

Evidencia: "${ev.nombre}"
Tipo: ${ev.tipo}

RAPs disponibles:
${raps.map(r => `- ${r.id} | ${r.codigo}: ${r.descripcion}`).join("\n")}

Responde SOLO con JSON válido en este formato:
{"rapId": "<id del RAP más apropiado>", "confianza": <número 0-100>, "razon": "<explicación breve en español, max 150 chars>"}

Si ningún RAP aplica claramente, usa confianza < 50.`;
}

/**
 * Call Claude and extract JSON from the response text.
 * Returns null on failure (so the caller can log and continue).
 */
async function callClaude(prompt) {
  const message = await client.messages.create({
    model:      "claude-haiku-4-5",
    max_tokens: 256,
    messages:   [{ role: "user", content: prompt }],
  });

  const text = message.content?.[0]?.text ?? "";

  // Extract JSON from the response (Claude may wrap it in ```json ... ```)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Claude response did not contain JSON: ${text.slice(0, 200)}`);

  return JSON.parse(jsonMatch[0]);
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker("matchingIa", async (job) => {
  const { jobId, userId, evidenciaIds } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 5 } });

  // 1. Fetch the user + competencia
  const user = await prisma.user.findUnique({
    where:   { id: userId },
    select:  { competenciaId: true },
  });

  if (!user?.competenciaId) {
    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "error", errorMsg: "El usuario no tiene competencia asignada." },
    });
    return;
  }

  // 2. Fetch all RAPs for the user's competencia (with criterios)
  const raps = await prisma.rAP.findMany({
    where:   { competenciaId: user.competenciaId },
    include: { criterios: { orderBy: { orden: "asc" } } },
    orderBy: { codigo: "asc" },
  });

  if (raps.length === 0) {
    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "error", errorMsg: "No hay RAPs configurados para tu competencia." },
    });
    return;
  }

  // 3. Resolve which evidencias to evaluate
  let evidencias;
  if (Array.isArray(evidenciaIds) && evidenciaIds.length > 0) {
    // Only evaluate the requested subset — but verify they belong to the user
    evidencias = await prisma.evidencia.findMany({
      where: {
        id:    { in: evidenciaIds },
        ficha: { userId },
      },
      select: { id: true, nombre: true, tipo: true },
    });
  } else {
    // Evaluate ALL evidencias across all fichas of this user
    evidencias = await prisma.evidencia.findMany({
      where:  { ficha: { userId } },
      select: { id: true, nombre: true, tipo: true },
    });
  }

  const total = evidencias.length;
  if (total === 0) {
    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "done", progreso: 100, resultado: { total: 0, procesadas: 0, errores: 0 } },
    });
    return;
  }

  // 4. Process each evidencia
  let procesadas = 0;
  let errores    = 0;

  for (let i = 0; i < evidencias.length; i++) {
    const ev = evidencias[i];

    try {
      const prompt = buildPrompt(ev, raps);
      const parsed = await callClaude(prompt);

      const { rapId, confianza, razon } = parsed;

      // Validate rapId belongs to the list
      const rapValido = raps.find(r => r.id === rapId);
      if (!rapValido) {
        console.warn(`[matchingIa] rapId "${rapId}" not in list for evidencia ${ev.id} — skipping`);
        errores++;
      } else {
        // Upsert the MatchingPropuesta
        await prisma.matchingPropuesta.upsert({
          where:  { userId_evidenciaId_rapId: { userId, evidenciaId: ev.id, rapId } },
          create: {
            userId,
            evidenciaId: ev.id,
            rapId,
            confianza:   Math.min(100, Math.max(0, Math.round(confianza))),
            razon:       String(razon).slice(0, 300),
            estado:      "propuesto",
          },
          update: {
            confianza:   Math.min(100, Math.max(0, Math.round(confianza))),
            razon:       String(razon).slice(0, 300),
            estado:      "propuesto",
            decidedAt:   null,
          },
        });
        procesadas++;
      }
    } catch (err) {
      console.error(`[matchingIa] Error evaluando evidencia ${ev.id} (${ev.nombre}):`, err.message);
      errores++;
    }

    // Update progress after each evidencia
    const progreso = Math.round(10 + ((i + 1) / total) * 88);
    await prisma.job.update({ where: { id: jobId }, data: { progreso } });
  }

  await prisma.job.update({
    where: { id: jobId },
    data:  {
      status:    "done",
      progreso:  100,
      resultado: { total, procesadas, errores },
    },
  });

}, { connection, concurrency: 1 });

// ─── Error handler ────────────────────────────────────────────────────────────

worker.on("failed", async (job, err) => {
  console.error(`[matchingIa] job failed:`, err.message);
  if (job?.data?.jobId) {
    await prisma.job.update({
      where: { id: job.data.jobId },
      data:  { status: "error", errorMsg: err.message },
    }).catch(() => {});
  }
});

module.exports = worker;
