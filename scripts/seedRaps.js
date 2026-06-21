/**
 * scripts/seedRaps.js — Siembra Competencias + RAPs + Criterios en la DB actual
 * (la que apunte DATABASE_URL) desde scripts/data/raps-seed.json.
 *
 * Para qué: la base de PRODUCCIÓN arranca vacía tras las migraciones (las tablas se
 * crean sin datos). Sin Competencias/RAPs, la página RAPs sale vacía para TODOS los
 * instructores ("No hay RAPs para tu competencia"). Este script carga los datos de
 * referencia de una, y es REPETIBLE (idempotente: upsert por código).
 *
 * Qué hace y qué NO:
 *   - Upsert de Competencia (por `codigo` @unique) y de RAP (por @@unique
 *     [competenciaId, codigo]); reemplaza los Criterios de cada RAP sembrado.
 *   - NO borra competencias/RAPs que no estén en el JSON.
 *   - NO toca usuarios, evidencias ni RapEvidenciaRel (eso es per-instructor y se
 *     reconstruye con el scan + matching IA en prod).
 *
 * Tras sembrar, cada instructor cuyo `competenciaCodigo` coincida con una competencia
 * sembrada verá sus RAPs en cuanto recargue (el FK se auto-vincula, ver lib/competencia.js).
 *
 * Uso:
 *   node scripts/seedRaps.js --dry-run   # muestra qué haría, sin escribir
 *   node scripts/seedRaps.js             # siembra de verdad
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");
const fs = require("fs");
const path = require("path");

async function main() {
  const dry  = process.argv.includes("--dry-run");
  const file = path.resolve(__dirname, "data", "raps-seed.json");
  if (!fs.existsSync(file)) {
    console.error("No existe", file, "— corre antes scripts/exportRapsSeed.js en una DB con datos.");
    process.exitCode = 1;
    return;
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Sembrando desde ${path.basename(file)} (export ${data.exportedAt})${dry ? "  [DRY-RUN]" : ""}`);
  console.log(`DB destino: ${process.env.DATABASE_URL?.split("@")[1] || "?"}\n`);

  let nComp = 0, nRapCreate = 0, nRapUpdate = 0, nCrit = 0;

  for (const c of data.competencias) {
    if (dry) {
      nComp++;
      for (const r of c.raps) { nRapCreate++; nCrit += r.criterios.length; }
      continue;
    }

    const comp = await prisma.competencia.upsert({
      where:  { codigo: c.codigo },
      create: { codigo: c.codigo, nombre: c.nombre },
      update: { nombre: c.nombre },
    });
    nComp++;

    for (const r of c.raps) {
      const criteriosCreate = r.criterios
        .map((cr, i) => ({ descripcion: String(cr.descripcion ?? "").trim(), orden: typeof cr.orden === "number" ? cr.orden : i }))
        .filter(cr => cr.descripcion);

      const existing = await prisma.rAP.findUnique({
        where: { competenciaId_codigo: { competenciaId: comp.id, codigo: r.codigo } },
      });

      if (existing) {
        // Reemplazar criterios y refrescar la descripción.
        await prisma.$transaction([
          prisma.criterio.deleteMany({ where: { rapId: existing.id } }),
          prisma.rAP.update({
            where: { id: existing.id },
            data:  { descripcion: r.descripcion, criterios: { create: criteriosCreate } },
          }),
        ]);
        nRapUpdate++;
      } else {
        await prisma.rAP.create({
          data: { competenciaId: comp.id, codigo: r.codigo, descripcion: r.descripcion, criterios: { create: criteriosCreate } },
        });
        nRapCreate++;
      }
      nCrit += criteriosCreate.length;
    }
  }

  console.log(dry
    ? `[DRY-RUN] Sembraría: ${nComp} competencias, ${nRapCreate} RAPs, ${nCrit} criterios.`
    : `✅ Sembrado: ${nComp} competencias | RAPs creados ${nRapCreate}, actualizados ${nRapUpdate} | ${nCrit} criterios.`);
}

main().catch(e => { console.error("ERROR:", e.message); process.exitCode = 1; })
      .finally(() => prisma.$disconnect());
