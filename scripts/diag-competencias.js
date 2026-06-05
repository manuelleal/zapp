require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");

async function main() {
  // ── Fichas ───────────────────────────────────────────────────────────────
  const fichas = await prisma.ficha.findMany({
    select: { id: true, codigo: true, nombre: true, archivedAt: true, _count: { select: { evidencias: true } } },
    orderBy: { codigo: "asc" },
  });
  console.log("FICHAS TOTALES :", fichas.length);
  console.log("  Activas      :", fichas.filter(f => !f.archivedAt).length);
  console.log("  Archivadas   :", fichas.filter(f =>  f.archivedAt).length);
  console.log("");
  for (const f of fichas) {
    const flag = f.archivedAt ? "[arch]" : "[act ]";
    console.log(flag, f.codigo, "|", String(f._count.evidencias).padStart(3), "evidencias |", f.nombre.substring(0, 55));
  }

  // ── Análisis de evidencias ───────────────────────────────────────────────
  const RE = /\bGA(\d+)-(\d{9})\b/;
  const evs = await prisma.evidencia.findMany({ select: { nombre: true } });

  const compMap = new Map(); // codigo → count
  const gaSet   = new Map(); // "comp-GA{n}" → count
  let sinPatron = 0;

  for (const e of evs) {
    const m = e.nombre.match(RE);
    if (!m) { sinPatron++; continue; }
    const comp = m[2], ga = parseInt(m[1], 10);
    compMap.set(comp, (compMap.get(comp) || 0) + 1);
    const key = `${comp}-GA${String(ga).padStart(2,"0")}`;
    gaSet.set(key, (gaSet.get(key) || 0) + 1);
  }

  console.log("\nEVIDENCIAS TOTALES EN DB  :", evs.length);
  console.log("  Con patrón GA{N}-{comp} :", evs.length - sinPatron);
  console.log("  Sin patrón              :", sinPatron);

  console.log("\nCOMPETENCIAS detectadas en nombres:");
  for (const [c, n] of [...compMap.entries()].sort())
    console.log(`  ${c}  →  ${n} evidencias`);

  console.log("\nDETALLE guía × competencia:");
  for (const [k, n] of [...gaSet.entries()].sort())
    console.log(`  ${k}  →  ${n} evidencias`);

  // ── Muestra de nombres sin patrón ────────────────────────────────────────
  const sinPat = await prisma.evidencia.findMany({
    where: { nombre: { not: { contains: "GA" } } },
    select: { nombre: true },
    take: 10,
  });
  if (sinPat.length > 0) {
    console.log("\nMUESTRA de evidencias SIN patrón GA (primeras 10):");
    for (const e of sinPat) console.log(" ", e.nombre.substring(0, 70));
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
