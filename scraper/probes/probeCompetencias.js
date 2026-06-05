require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");
async function main() {
  const evs = await prisma.evidencia.findMany({ select: { nombre: true }, take: 500 });
  const codigos = new Map(); // codigo → count
  for (const e of evs) {
    const m = e.nombre.match(/GA(\d+)-(\d{9})-AA(\d+)/);
    if (m) {
      const key = m[2];
      codigos.set(key, (codigos.get(key) || 0) + 1);
    }
  }
  console.log("Competencias en evidencias DB:");
  [...codigos.entries()].sort().forEach(([c, n]) => console.log(`  ${c}  (${n} evidencias)`));

  const comps = await prisma.competencia.findMany({ include: { raps: { select: { id: true } } } });
  console.log("\nCompetencias en tabla Competencia:");
  comps.forEach(c => console.log(`  ${c.codigo}  "${c.nombre}"  →  ${c.raps.length} RAPs`));

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
