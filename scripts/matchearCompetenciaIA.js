/**
 * matchearCompetenciaIA.js — Pone la IA (Kimi vía OpenRouter) a mapear sola las
 * evidencias de una competencia con sus RAPs, y GUARDA el resultado en DB.
 * Reemplaza el trabajo manual guía-por-guía con Gemini.
 *
 * NO necesita los PDFs: usa el "texto limpio" que ya está en la DB tras el scan —
 * el nombre de cada evidencia (con su código GA{n}-AA{m}-EV{nn} + título) y la
 * descripción/criterios de cada RAP. Eso es suficiente para que la IA infiera el
 * mapeo (lo confirmaron los agentes de análisis).
 *
 * FLUJO (1 sola llamada IA por competencia):
 *   1. Carga RAPs (código + descripción + criterios) y evidencias de la competencia.
 *   2. DEDUPLICA evidencias por código canónico GA-AA-EV (los scans repetidos crean
 *      ~10 filas por evidencia; la IA solo ve 1 representante).
 *   3. Pide a la IA el mapeo evidencia→RAP (permite multi-RAP) con confianza.
 *   4. Aplica el resultado a TODAS las filas Evidencia de ese código (todas las
 *      fichas) creando RapEvidenciaRel. Idempotente (upsert).
 *
 * Uso:
 *   node scripts/matchearCompetenciaIA.js <competenciaCodigo> [--dry-run] [--todas]
 *   node scripts/matchearCompetenciaIA.js 220501093 --dry-run
 *   node scripts/matchearCompetenciaIA.js --todas            # todas las competencias con evidencias
 *
 * Requiere: OPENROUTER_API_KEY en .env (o MOONSHOT_API_KEY / ANTHROPIC_API_KEY).
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");
const { chatJSON, proveedorActivo } = require("../api/src/lib/aiClient");

const DRY_RUN = process.argv.includes("--dry-run");
const TODAS   = process.argv.includes("--todas");
const COMP_ARG = process.argv.find(a => /^\d{9}$/.test(a)) || null;

// Código canónico de evidencia: GA{n}-{comp}-AA{m}-EV{nn} normalizado (sin ceros
// de relleno ni espacios) para deduplicar variantes de scans repetidos.
function codigoCanonico(nombre) {
  const m = String(nombre).toUpperCase().replace(/\s+/g, "")
    .match(/GA0*(\d+)-(\d{9})-AA0*(\d+)-EV0*(\d+)/);
  if (!m) return null;
  return `GA${m[1]}-${m[2]}-AA${m[3]}-EV${m[4]}`;
}

const SYSTEM = "Eres un experto en formación por competencias del SENA (Colombia). " +
  "Mapeas cada evidencia de aprendizaje al RAP (Resultado de Aprendizaje) que evalúa. " +
  "El código de la evidencia tiene forma GA{guía}-{competencia}-AA{actividad}-EV{n}: la " +
  "ACTIVIDAD (AA) suele alinearse con un RAP. Una evidencia puede mapear a más de un RAP. " +
  "Las evidencias de conocimiento (quiz/foro) van al MISMO RAP que las de producto/desempeño " +
  "de su misma actividad. Respondes SOLO con un objeto JSON válido.";

function construirPrompt(comp, raps, evidencias) {
  return `Competencia ${comp.codigo}: ${comp.nombre}

RAPs disponibles (mapea SOLO a estos códigos):
${raps.map(r => `- ${r.codigo}: ${r.descripcion}${r.criterios.length ? ` | Criterios: ${r.criterios.map(c => c.descripcion).join(" ")}` : ""}`).join("\n")}

Evidencias a mapear (código canónico + nombre):
${evidencias.map(e => `- ${e.codigo} | ${e.nombre}`).join("\n")}

Devuelve SOLO este JSON:
{"mapeos": [{"evidencia": "<codigo canónico>", "rap": "<codigo RAP>", "confianza": "alta|media|baja"}]}
Incluye una entrada por cada par evidencia-RAP. Si una evidencia prueba 2 RAPs, pon 2 entradas. Mapea TODAS las evidencias.`;
}

async function matchearUna(compCodigo) {
  const comp = await prisma.competencia.findUnique({
    where:   { codigo: compCodigo },
    include: { raps: { include: { criterios: true }, orderBy: { codigo: "asc" } } },
  });
  if (!comp)            { console.log(`  ⚠ ${compCodigo}: no existe en DB`); return; }
  if (comp.raps.length === 0) { console.log(`  ⚠ ${compCodigo}: sin RAPs en DB`); return; }

  // Evidencias de la competencia + dedup por código canónico
  const evDB = await prisma.evidencia.findMany({
    where:  { nombre: { contains: compCodigo } },
    select: { id: true, nombre: true, tipo: true },
  });
  const porCodigo = new Map(); // codigo canónico → { codigo, nombre, ids[] }
  for (const ev of evDB) {
    const cod = codigoCanonico(ev.nombre);
    if (!cod) continue;
    if (!porCodigo.has(cod)) porCodigo.set(cod, { codigo: cod, nombre: ev.nombre.replace(/\s+/g, " ").trim(), ids: [] });
    porCodigo.get(cod).ids.push(ev.id);
  }
  const unicas = [...porCodigo.values()];
  if (unicas.length === 0) { console.log(`  ⚠ ${compCodigo}: sin evidencias escaneadas (con código GA-AA-EV)`); return; }

  console.log(`\n▸ ${compCodigo} — ${comp.raps.length} RAPs, ${unicas.length} evidencias únicas (de ${evDB.length} filas con duplicados)`);

  // 1 llamada IA
  let resp;
  try {
    resp = await chatJSON({ system: SYSTEM, user: construirPrompt(comp, comp.raps, unicas), maxTokens: 4000, feature: "matching-script" });
  } catch (e) { console.log(`  ❌ IA falló: ${e.message}`); return; }

  const mapeos = Array.isArray(resp?.mapeos) ? resp.mapeos : [];
  if (mapeos.length === 0) { console.log(`  ⚠ la IA no devolvió mapeos`); return; }

  const rapPorCodigo = new Map(comp.raps.map(r => [r.codigo, r.id]));
  let creados = 0, sinRap = 0, sinEv = 0;
  const conf = { alta: 0, media: 0, baja: 0 };

  for (const m of mapeos) {
    const rapId = rapPorCodigo.get(String(m.rap).trim());
    const grupo = porCodigo.get(String(m.evidencia).trim().toUpperCase());
    if (!rapId) { sinRap++; continue; }
    if (!grupo) { sinEv++;  continue; }
    conf[(m.confianza || "media").toLowerCase()] = (conf[(m.confianza || "media").toLowerCase()] || 0) + 1;
    for (const evId of grupo.ids) {
      if (!DRY_RUN) {
        await prisma.rapEvidenciaRel.upsert({
          where:  { rapId_evidenciaId: { rapId, evidenciaId: evId } },
          create: { rapId, evidenciaId: evId },
          update: {},
        });
      }
      creados++;
    }
  }

  console.log(`  ✔ ${mapeos.length} mapeos IA → ${creados} RapEvidenciaRel ${DRY_RUN ? "(dry-run)" : "creados"} | confianza alta=${conf.alta} media=${conf.media} baja=${conf.baja}`);
  if (sinRap) console.log(`    ⚠ ${sinRap} mapeos con RAP fuera de lista`);
  if (sinEv)  console.log(`    ⚠ ${sinEv} mapeos con evidencia no reconocida`);
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  MATCHING IA POR COMPETENCIA — proveedor: ${proveedorActivo()}`);
  console.log(`  ${DRY_RUN ? "⚠ DRY RUN" : "Aplicando a DB"}`);
  console.log("═══════════════════════════════════════════════════════════════");

  let competencias;
  if (TODAS) {
    // Competencias que tienen evidencias escaneadas con código GA-AA-EV
    const evs = await prisma.evidencia.findMany({ select: { nombre: true } });
    const set = new Set();
    for (const e of evs) { const m = e.nombre.match(/\b(\d{9})\b/); if (m) set.add(m[1]); }
    competencias = [...set];
    console.log(`\n${competencias.length} competencias con evidencias: ${competencias.join(", ")}`);
  } else if (COMP_ARG) {
    competencias = [COMP_ARG];
  } else {
    console.error("Pasa un competenciaCodigo o --todas"); process.exit(1);
  }

  for (const c of competencias) await matchearUna(c);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(DRY_RUN ? "  DRY RUN — corre sin --dry-run para guardar." : "  ✅ Hecho. Mapeos guardados en RapEvidenciaRel.");
  console.log("═══════════════════════════════════════════════════════════════\n");
  await prisma.$disconnect();
}

main().catch(async e => { console.error("❌ Error:", e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
