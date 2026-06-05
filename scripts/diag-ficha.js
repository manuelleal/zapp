require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const p = require("../api/src/db/client");

const CODIGO = process.argv[2] || "3186683";

async function main() {
  const ficha = await p.ficha.findFirst({
    where:  { codigo: CODIGO },
    select: { id: true, codigo: true, nombre: true, programa: true, courseId: true, archivedAt: true },
  });

  if (!ficha) { console.log("Ficha no encontrada:", CODIGO); return; }

  console.log("FICHA :", ficha.codigo);
  console.log("Nombre:", ficha.nombre);
  console.log("Program:", ficha.programa);
  console.log("CourseId:", ficha.courseId);
  console.log("Archivada:", ficha.archivedAt ?? "NO");

  const evs = await p.evidencia.findMany({
    where:   { fichaId: ficha.id },
    select:  { nombre: true, tipo: true },
    orderBy: { nombre: "asc" },
  });

  console.log("\nTOTAL evidencias:", evs.length);

  const RE = /\bGA(\d+)-(\d{9})\b/;
  const conPat = [];
  const sinPat = [];

  for (const e of evs) {
    const m = e.nombre.match(RE);
    if (m) conPat.push({ ga: parseInt(m[1], 10), comp: m[2], nombre: e.nombre, tipo: e.tipo });
    else   sinPat.push(e);
  }

  conPat.sort((a, b) => a.comp.localeCompare(b.comp) || a.ga - b.ga);

  console.log("\nCON patrón GA{N}-{comp}: " + conPat.length);
  for (const e of conPat)
    console.log("  GA" + String(e.ga).padStart(2, "0"), e.comp, "|", e.tipo.padEnd(7), "|", e.nombre.substring(0, 65));

  console.log("\nSIN patrón GA: " + sinPat.length);
  for (const e of sinPat)
    console.log(" ", e.tipo.padEnd(7), "|", e.nombre.substring(0, 70));

  // Resumen de guías por competencia
  const resumen = new Map();
  for (const e of conPat) {
    if (!resumen.has(e.comp)) resumen.set(e.comp, new Set());
    resumen.get(e.comp).add(e.ga);
  }
  console.log("\nRESUMEN — guías presentes por competencia:");
  for (const [comp, gas] of [...resumen.entries()].sort())
    console.log("  " + comp + "  →  GAs: " + [...gas].sort((a,b)=>a-b).map(g=>"GA"+String(g).padStart(2,"0")).join(", "));
}

main().catch(console.error).finally(() => p.$disconnect());
