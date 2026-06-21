/**
 * scripts/exportRapsSeed.js — Exporta Competencias + RAPs + Criterios de la DB
 * actual a un JSON versionado (scripts/data/raps-seed.json), para poder SEMBRARLOS
 * en otra base (típicamente producción, que arranca vacía tras las migraciones).
 *
 * Se exportan SOLO datos de referencia globales (no hay userId en estas tablas):
 * NO toca usuarios, evidencias ni RapEvidenciaRel (esos son per-instructor y se
 * reconstruyen en prod con el scan + matching IA).
 *
 * El nombre de Competencia se recorta a 250 chars: el extractor a veces guardó el
 * texto completo de la guía (~4000 chars) en `nombre`. Recortar evita filas enormes;
 * la limpieza fina del nombre es un follow-up aparte.
 *
 * Uso (en local, con la DB buena cargada):  node scripts/exportRapsSeed.js
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");
const fs = require("fs");
const path = require("path");

async function main() {
  const comps = await prisma.competencia.findMany({
    orderBy: { codigo: "asc" },
    include: {
      raps: {
        orderBy: { codigo: "asc" },
        include: { criterios: { orderBy: { orden: "asc" } } },
      },
    },
  });

  const data = {
    exportedAt: new Date().toISOString(),
    competencias: comps.map(c => ({
      codigo: c.codigo,
      nombre: (c.nombre || "").slice(0, 250),
      raps: c.raps.map(r => ({
        codigo:      r.codigo,
        descripcion: r.descripcion,
        criterios:   r.criterios.map(cr => ({ descripcion: cr.descripcion, orden: cr.orden })),
      })),
    })),
  };

  const outDir = path.resolve(__dirname, "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "raps-seed.json");
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2), "utf8");

  const totRap  = data.competencias.reduce((a, c) => a + c.raps.length, 0);
  const totCrit = data.competencias.reduce((a, c) => a + c.raps.reduce((b, r) => b + r.criterios.length, 0), 0);
  console.log("Escrito:", outFile);
  console.log(`Competencias: ${data.competencias.length} | RAPs: ${totRap} | Criterios: ${totCrit}`);
  console.log(`Tamaño: ${(fs.statSync(outFile).size / 1024).toFixed(1)} KB`);
}

main().catch(e => { console.error("ERROR:", e.message); process.exitCode = 1; })
      .finally(() => prisma.$disconnect());
