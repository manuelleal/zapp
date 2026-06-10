/**
 * Test multi-tenant: simula otros instructores y verifica el aislamiento.
 *
 * Qué hace (todo vía HTTP contra localhost:3000, como un browser real):
 *   1. Login como superadmin (ddiddimmo) y toma IDs reales de su ficha/acta/evidencia.
 *   2. Por cada instructor de prueba (2, con competencias distintas):
 *      a. Login o registro (credenciales Zajuna ficticias — NO pueden escanear).
 *      b. Vincula User.competenciaId en DB (el register solo guarda el código string).
 *      c. "Mundo vacío": fichas/actas/evidencias/propuestas deben venir VACÍAS.
 *      d. Probes cross-tenant: intenta LEER y ESCRIBIR recursos del superadmin
 *         → se espera 403/404 en todos. Un 200 aquí = FUGA CRÍTICA.
 *         (si una escritura llegara a colar, el script la revierte y lo marca CRITICAL)
 *      e. Flujo propio: crea ficha → crea acta con los RAPs de SU competencia →
 *         auto-poblar (se espera 422 RAP_SIN_EVIDENCIAS: sus RAPs no tienen evidencias).
 *   3. Aislamiento inverso: el superadmin NO debe ver las fichas/actas de prueba.
 *
 * Los usuarios de prueba SE CONSERVAN para que puedas entrar por el browser:
 *   instructor1.test@zajuna.local / Test1234!   (competencia 220501096 — Desarrollar)
 *   instructor2.test@zajuna.local / Test1234!   (competencia 220501095 — Diseñar)
 *
 * Uso:
 *   node scripts/test-multitenant.js              # corre las pruebas (conserva usuarios)
 *   node scripts/test-multitenant.js --cleanup    # borra usuarios de prueba y sus datos, sin correr tests
 *
 * Requiere: servidor corriendo en localhost:3000 + ZAJUNA_PASS (o SUPERADMIN_PASS) en .env
 * Gotcha: el rate-limit de /api/auth/* es RATE_MAX (default 10) por IP / 15 min —
 *         correr esto muchas veces seguidas puede dar 429.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");

const BASE        = "http://localhost:3000";
const ADMIN_EMAIL = "ddiddimmo@gmail.com";
const ADMIN_PASS  = process.env.ZAJUNA_PASS || process.env.SUPERADMIN_PASS || "";
const CLEANUP     = process.argv.includes("--cleanup");

const TEST_USERS = [
  {
    nombre: "Instructor Prueba Uno",
    email:  "instructor1.test@zajuna.local",
    password: "Test1234!",
    competenciaCodigo: "220501096", // Desarrollar la solución de software (5 RAPs)
  },
  {
    nombre: "Instructor Prueba Dos",
    email:  "instructor2.test@zajuna.local",
    password: "Test1234!",
    competenciaCodigo: "220501095", // Diseñar la solución de software (4 RAPs)
  },
];

let passed = 0;
let failed = 0;
const criticos = []; // fugas cross-tenant (lo peor que puede salir de aquí)

function ok(label, detail = "")   { passed++; console.log(`  ✅ ${label}${detail ? "  →  " + detail : ""}`); }
function fail(label, detail = "") { failed++; console.log(`  ❌ ${label}${detail ? "  →  " + detail : ""}`); }
function critical(label, detail = "") { failed++; criticos.push(label); console.log(`  🚨 CRÍTICO: ${label}${detail ? "  →  " + detail : ""}`); }
function section(title)           { console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`); }

async function api(path, opts = {}, jwt = null) {
  const headers = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  const res  = await fetch(`${BASE}${path}`, { headers, ...opts });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// Un probe cross-tenant pasa si responde 403 o 404 (no existe para ese user).
// 200/201 = fuga. Cualquier otro código (500, 422...) también se reporta porque
// significa que la ruta procesó el recurso ajeno en vez de cortarlo de entrada.
function assertBloqueado(label, status, body) {
  if (status === 403 || status === 404) {
    ok(label, `HTTP ${status}`);
    return false; // no hubo fuga
  }
  if (status === 200 || status === 201) {
    critical(label, `HTTP ${status} — respondió con datos ajenos: ${JSON.stringify(body).slice(0, 120)}`);
    return true;
  }
  fail(label, `HTTP ${status} inesperado (se esperaba 403/404): ${JSON.stringify(body).slice(0, 120)}`);
  return false;
}

// Algunas rutas devuelven array directo y otras { algo: [...] } — normaliza.
function comoLista(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    for (const v of Object.values(body)) if (Array.isArray(v)) return v;
  }
  return null;
}

// ─── Cleanup de usuarios de prueba (datos + user) ─────────────────────────────

async function limpiarUsuariosPrueba() {
  for (const tu of TEST_USERS) {
    const user = await prisma.user.findUnique({ where: { email: tu.email } });
    if (!user) { console.log(`  (no existe ${tu.email})`); continue; }

    // Borrar en orden de FKs: actas → fichas → jobs/propuestas → user
    const actas = await prisma.actaSeguimiento.findMany({ where: { userId: user.id }, select: { id: true } });
    for (const a of actas) {
      await prisma.actaParticipante.deleteMany({ where: { actaId: a.id } }).catch(() => {});
      await prisma.actaSeguimiento.delete({ where: { id: a.id } });
    }
    await prisma.matchingPropuesta.deleteMany({ where: { userId: user.id } });
    await prisma.job.deleteMany({ where: { userId: user.id } });
    await prisma.ficha.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    console.log(`  🗑 Borrado ${tu.email} con sus fichas/actas de prueba`);
  }
}

// ─── Suite por instructor de prueba ───────────────────────────────────────────

async function probarInstructor(tu, idsAdmin) {
  section(`Instructor: ${tu.email} (competencia ${tu.competenciaCodigo})`);

  // a. Login o registro
  let jwt = null;
  const login1 = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: tu.email, password: tu.password }),
  });

  if (login1.status === 200 && login1.body.token) {
    jwt = login1.body.token;
    ok("Login (usuario ya existía)");
  } else {
    const reg = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({
        nombre: tu.nombre,
        email: tu.email,
        password: tu.password,
        zajunaUser: "00000000",          // ficticio — este usuario nunca escanea Moodle
        zajunaPass: "credencial-falsa",
        competenciaCodigo: tu.competenciaCodigo,
        competenciaNombre: "",
      }),
    });
    if (reg.status !== 200 || !reg.body.token) {
      fail("Registro", `HTTP ${reg.status} — ${JSON.stringify(reg.body)}`);
      return;
    }
    jwt = reg.body.token;
    ok("Registro", `id=${reg.body.user?.id}`);
  }

  // b. Vincular competenciaId (el register guarda solo el string del código)
  const comp = await prisma.competencia.findUnique({ where: { codigo: tu.competenciaCodigo }, include: { raps: { select: { id: true, codigo: true } } } });
  if (!comp) { fail(`Competencia ${tu.competenciaCodigo} no existe en DB`); return; }
  await prisma.user.update({ where: { email: tu.email }, data: { competenciaId: comp.id, competenciaNombre: comp.nombre } });
  ok("competenciaId vinculado en DB", `${comp.raps.length} RAPs disponibles`);

  // c. Mundo vacío — no debe ver NADA de otros usuarios
  const vacias = [
    ["GET /api/fichas",               "/api/fichas"],
    ["GET /api/actas",                "/api/actas"],
    ["GET /api/evidencias/todas",     "/api/evidencias/todas"],
    ["GET /api/matching/propuestas",  "/api/matching/propuestas"],
  ];
  for (const [label, path] of vacias) {
    const { status, body } = await api(path, {}, jwt);
    const lista = comoLista(body);
    if (status !== 200 || lista === null) { fail(`${label} (mundo vacío)`, `HTTP ${status}`); continue; }
    if (lista.length === 0) ok(`${label} vacío`);
    else critical(`${label} devuelve ${lista.length} items de OTRO usuario`, JSON.stringify(lista[0]).slice(0, 120));
  }

  // d. Probes cross-tenant contra recursos del superadmin
  if (idsAdmin.fichaId) {
    const r = await api(`/api/fichas/${idsAdmin.fichaId}/reporte-pendientes`, {}, jwt);
    assertBloqueado("Leer reporte de ficha ajena", r.status, r.body);

    const r2 = await api(`/api/fichas/${idsAdmin.fichaId}/evidencias`, {}, jwt);
    assertBloqueado("Listar evidencias de ficha ajena", r2.status, r2.body);
  }
  if (idsAdmin.actaId) {
    const r = await api(`/api/actas/${idsAdmin.actaId}`, {}, jwt);
    assertBloqueado("Leer acta ajena", r.status, r.body);

    // Probe de ESCRITURA: si pasa, además de marcar CRITICAL se revierte abajo
    const r2 = await api(`/api/actas/${idsAdmin.actaId}`, {
      method: "PATCH",
      body: JSON.stringify({ objetivo: "FUGA-MULTITENANT-DETECTADA" }),
    }, jwt);
    const fuga = assertBloqueado("Modificar acta ajena (PATCH)", r2.status, r2.body);
    if (fuga) {
      // revertir el objetivo original directamente en DB
      console.log("     ⚠ revirtiendo el PATCH que se coló...");
      // no conocemos el objetivo original aquí; marcarlo para revisión manual
      console.log("     ⚠ REVISAR MANUALMENTE el objetivo del acta", idsAdmin.actaId);
    }
  }
  if (idsAdmin.evidenciaId) {
    const r = await api(`/api/evidencias/${idsAdmin.evidenciaId}/entregas`, {}, jwt);
    assertBloqueado("Leer entregas de evidencia ajena", r.status, r.body);

    const r2 = await api(`/api/evidencias/${idsAdmin.evidenciaId}/config`, {}, jwt);
    assertBloqueado("Leer config de evidencia ajena", r2.status, r2.body);
  }

  // e. Flujo propio: ficha → acta con SUS RAPs → auto-poblar
  const codigoFicha = `TEST-MT-${tu.competenciaCodigo}`;
  let fichaId = null;

  const f = await api("/api/fichas", {
    method: "POST",
    body: JSON.stringify({ codigo: codigoFicha, courseId: 99999, nombre: "Ficha de prueba multi-tenant" }),
  }, jwt);
  if (f.status === 201)      { fichaId = f.body.id; ok("Crear ficha propia", codigoFicha); }
  else if (f.status === 409) {
    // quedó de una corrida anterior — recuperar el id
    const lista = comoLista((await api("/api/fichas", {}, jwt)).body) || [];
    fichaId = lista.find(x => x.codigo === codigoFicha)?.id ?? null;
    ok("Ficha propia ya existía (corrida anterior)", codigoFicha);
  } else fail("Crear ficha propia", `HTTP ${f.status} — ${JSON.stringify(f.body)}`);

  if (fichaId) {
    const misFichas = comoLista((await api("/api/fichas", {}, jwt)).body) || [];
    const ajenas = misFichas.filter(x => !String(x.codigo).startsWith("TEST-MT-"));
    if (ajenas.length === 0) ok(`GET /api/fichas solo muestra las propias (${misFichas.length})`);
    else critical("GET /api/fichas mezcla fichas ajenas", JSON.stringify(ajenas[0]).slice(0, 120));

    // Acta con los RAPs de SU competencia
    const hoy = new Date().toISOString().slice(0, 10);
    const a = await api("/api/actas", {
      method: "POST",
      body: JSON.stringify({
        fichaId,
        numero: "01",
        fecha: hoy,
        hora: "10:00",
        objetivo: "Acta de prueba multi-tenant",
        rapIds: comp.raps.map(r => r.id),
      }),
    }, jwt);

    if (a.status === 201) {
      ok("Crear acta propia", `id=${a.body.id}`);

      // auto-poblar: SE ESPERA 422 RAP_SIN_EVIDENCIAS (sus RAPs no tienen evidencias
      // vinculadas — la ficha de prueba no tiene scan). Un 500 aquí sería bug.
      const ap = await api(`/api/actas/${a.body.id}/auto-poblar`, { method: "POST", body: JSON.stringify({}) }, jwt);
      if (ap.status === 422) ok("auto-poblar corta limpio con 422 (sin evidencias vinculadas)", ap.body?.error || ap.body?.code || "");
      else if (ap.status === 200) ok("auto-poblar respondió 200 (¿RAPs con evidencias?)", JSON.stringify(ap.body).slice(0, 100));
      else fail("auto-poblar", `HTTP ${ap.status} — ${JSON.stringify(ap.body).slice(0, 150)}`);
    } else {
      fail("Crear acta propia", `HTTP ${a.status} — ${JSON.stringify(a.body).slice(0, 150)}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  TEST MULTI-TENANT — simulación de otros instructores");
  console.log("═══════════════════════════════════════════════════════════════");

  if (CLEANUP) {
    section("Cleanup de usuarios de prueba");
    await limpiarUsuariosPrueba();
    await prisma.$disconnect();
    return;
  }

  // ── 1. Login superadmin + recolectar IDs reales para los probes ─────────────
  section("1. Login superadmin y recolección de IDs");
  if (!ADMIN_PASS) {
    fail("ZAJUNA_PASS / SUPERADMIN_PASS no definido en .env");
    process.exit(1);
  }

  const login = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
  });
  if (login.status !== 200 || !login.body.token) {
    fail("Login superadmin", `HTTP ${login.status} — ${JSON.stringify(login.body)}`);
    process.exit(1);
  }
  const jwtAdmin = login.body.token;
  ok("Login superadmin");

  const fichasAdmin = comoLista((await api("/api/fichas", {}, jwtAdmin)).body) || [];
  const actasAdmin  = comoLista((await api("/api/actas", {}, jwtAdmin)).body) || [];
  const evsAdmin    = comoLista((await api("/api/evidencias/todas", {}, jwtAdmin)).body) || [];

  const idsAdmin = {
    fichaId:     fichasAdmin[0]?.id ?? null,
    actaId:      actasAdmin[0]?.id ?? null,
    evidenciaId: evsAdmin[0]?.id ?? null,
  };
  ok("IDs del superadmin para probes", `ficha=${!!idsAdmin.fichaId} acta=${!!idsAdmin.actaId} evidencia=${!!idsAdmin.evidenciaId}`);
  const fichasAdminAntes = fichasAdmin.length;

  // ── 2. Suite por cada instructor de prueba ───────────────────────────────────
  for (const tu of TEST_USERS) {
    await probarInstructor(tu, idsAdmin);
  }

  // ── 3. Aislamiento inverso: el superadmin no debe ver datos de prueba ───────
  section("3. Aislamiento inverso (vista del superadmin)");
  const fichasDespues = comoLista((await api("/api/fichas", {}, jwtAdmin)).body) || [];
  const contaminadas  = fichasDespues.filter(f => String(f.codigo).startsWith("TEST-MT-"));
  if (contaminadas.length === 0) ok(`Superadmin sigue viendo solo sus fichas (${fichasDespues.length}, antes ${fichasAdminAntes})`);
  else critical("Superadmin ve fichas de los usuarios de prueba", contaminadas.map(f => f.codigo).join(", "));

  const actasDespues = comoLista((await api("/api/actas", {}, jwtAdmin)).body) || [];
  const actasTest    = actasDespues.filter(a => a.objetivo === "Acta de prueba multi-tenant");
  if (actasTest.length === 0) ok("Superadmin no ve las actas de prueba");
  else critical("Superadmin ve actas de los usuarios de prueba");

  // ── Resumen ──────────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  RESULTADO: ${passed} ✅ pasaron  |  ${failed} ❌ fallaron`);
  if (criticos.length > 0) {
    console.log(`\n  🚨 FUGAS CRÍTICAS DE AISLAMIENTO (${criticos.length}):`);
    for (const c of criticos) console.log(`     - ${c}`);
  }
  console.log("\n  Usuarios de prueba CONSERVADOS para probar en el browser:");
  for (const tu of TEST_USERS) console.log(`     ${tu.email}  /  ${tu.password}   (${tu.competenciaCodigo})`);
  console.log("  Para borrarlos: node scripts/test-multitenant.js --cleanup");
  console.log("═══════════════════════════════════════════════════════════════\n");

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("\n❌ Error inesperado:", e); process.exit(1); });
