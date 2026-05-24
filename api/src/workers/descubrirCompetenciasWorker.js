require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { connection } = require("../lib/queue");
const prisma = require("../db/client");

// Extrae el código de competencia (9 dígitos) de nombres tipo "GA1-240202501-AA1-EV01"
const RE_COMP = /\bGA\d+-(\d{9})\b/;

const worker = new Worker("descubrirCompetencias", async (job) => {
  const { jobId, userId } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 10 } });

  // 1. Fichas activas del usuario
  const fichas = await prisma.ficha.findMany({
    where:  { userId, archivedAt: null },
    select: { id: true, codigo: true },
  });

  if (fichas.length === 0) {
    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "done", progreso: 100, resultado: { found: 0, nuevas: 0, codigos: [], msg: "Sin fichas sincronizadas. Ejecuta un escaneo primero." } },
    });
    return;
  }

  await prisma.job.update({ where: { id: jobId }, data: { progreso: 30 } });

  // 2. Extraer códigos de competencia desde nombres de evidencias en DB
  const fichaIds = fichas.map(f => f.id);
  const evidencias = await prisma.evidencia.findMany({
    where:  { fichaId: { in: fichaIds } },
    select: { nombre: true },
  });

  const codigosContados = new Map(); // codigo → count de evidencias
  for (const ev of evidencias) {
    const m = ev.nombre.match(RE_COMP);
    if (m) codigosContados.set(m[1], (codigosContados.get(m[1]) || 0) + 1);
  }

  await prisma.job.update({ where: { id: jobId }, data: { progreso: 60 } });

  // 3. Upsert: crear competencias desconocidas con nombre genérico editable
  let nuevas = 0;
  for (const [codigo] of codigosContados.entries()) {
    const existing = await prisma.competencia.findUnique({ where: { codigo } });
    if (!existing) {
      await prisma.competencia.create({ data: { codigo, nombre: `Competencia ${codigo}` } });
      nuevas++;
    }
  }

  const codigos = [...codigosContados.keys()].sort();

  await prisma.job.update({
    where: { id: jobId },
    data:  { status: "done", progreso: 100, resultado: { found: codigos.length, nuevas, codigos } },
  });
}, { connection });

module.exports = worker;
