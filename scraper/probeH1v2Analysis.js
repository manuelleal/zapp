require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");
const GA_REGEX = /GA(\d+)-(\d{9})-AA(\d+)-EV(\d+)/i;

async function main() {
  const evidencias = await prisma.evidencia.findMany({
    select: { id: true, nombre: true, ficha: { select: { id: true, codigo: true } } },
  });

  const grupos = new Map();
  let sinParsear = 0;

  for (const ev of evidencias) {
    const m = ev.nombre.replace(/\s+/g, "").match(GA_REGEX);
    if (!m) { sinParsear++; continue; }
    const key = `${ev.ficha.codigo}|GA${m[1]}|AA${m[3]}`;
    if (!grupos.has(key)) {
      grupos.set(key, { ficha: ev.ficha.codigo, guia: parseInt(m[1]), aa: parseInt(m[3]), comp: m[2], evs: [] });
    }
    grupos.get(key).evs.push(`EV${m[4]}`);
  }

  // Por ficha
  const porFicha = new Map();
  for (const [, g] of grupos) {
    if (!porFicha.has(g.ficha)) porFicha.set(g.ficha, []);
    porFicha.get(g.ficha).push(g);
  }

  // Patrón global (cuántas fichas ven cada GA-AA)
  const patrones = new Map();
  for (const [, g] of grupos) {
    const k = `GA${String(g.guia).padStart(2,"0")}-AA${g.aa}`;
    if (!patrones.has(k)) patrones.set(k, { guia: g.guia, aa: g.aa, fichas: new Set(), evNums: new Set() });
    const p = patrones.get(k);
    p.fichas.add(g.ficha);
    g.evs.forEach(e => p.evNums.add(e));
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("  ESTRUCTURA POR FICHA  (GA × AA × EVs)");
  console.log(`${"═".repeat(60)}\n`);

  for (const [ficha, gs] of [...porFicha.entries()].sort()) {
    const porGuia = new Map();
    for (const g of gs) {
      if (!porGuia.has(g.guia)) porGuia.set(g.guia, []);
      porGuia.get(g.guia).push(g);
    }
    console.log(`  Ficha ${ficha}:`);
    for (const [guia, aas] of [...porGuia.entries()].sort((a, b) => a[0] - b[0])) {
      const total = aas.reduce((s, a) => s + a.evs.length, 0);
      const aaStr = aas
        .sort((a, b) => a.aa - b.aa)
        .map(a => `AA${a.aa}[${a.evs.sort().join(",")}]`)
        .join("  +  ");
      console.log(`    GA${guia}:  ${aaStr}  →  ${total} ev totales`);
    }
    const totalFicha = gs.reduce((s, g) => s + g.evs.length, 0);
    const totalGuias = porGuia.size;
    console.log(`    ─ ${totalGuias} guía(s), ${totalFicha} evidencias\n`);
  }

  console.log(`${"═".repeat(60)}`);
  console.log("  PATRÓN GLOBAL  (apariciones por GA-AA en todas las fichas)");
  console.log(`${"═".repeat(60)}\n`);

  for (const [k, p] of [...patrones.entries()].sort()) {
    const evList = [...p.evNums].sort().join(", ");
    console.log(`  ${k}  |  ${p.fichas.size} ficha(s)  |  EVs: ${evList}`);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Total evidencias : ${evidencias.length}`);
  console.log(`  Sin código GA    : ${sinParsear}`);
  console.log(`  Combinaciones GA-AA únicas: ${patrones.size}`);
  console.log(`${"═".repeat(60)}\n`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
