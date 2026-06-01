/**
 * scripts/probe-ws-token.js
 *
 * PROBE de decisión arquitectónica para la Fase A (tabla de evidencias vía Web Services).
 *
 * Pregunta que responde: ¿Zajuna/SENA permite obtener un token de Web Services
 * automáticamente con usuario+contraseña vía /login/token.php?
 *   - Si SÍ  → podemos cargar TODA la config (fechas) de un curso en 1 request
 *             usando mod_assign_get_assignments (camino 1, el de la extensión Z
 *             pero automatizado, sin pegar token a mano).
 *   - Si NO  → SENA tiene el servicio mobile capado → vamos por el camino 2
 *             (sesskey + lib/ajax/service.php con la sesión Playwright).
 *
 * Uso:
 *   node scripts/probe-ws-token.js [email-del-usuario]
 *   node scripts/probe-ws-token.js [email] [courseId]   ← además prueba mod_assign_get_assignments
 *
 * Si no pasas email, toma el primer usuario que tenga credenciales Zajuna.
 * NO escribe nada en la DB. Solo lee credenciales y hace requests de prueba.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

// Zajuna no envía la cadena completa de certificados (falta el intermedio), así
// que Node falla con UNABLE_TO_VERIFY_LEAF_SIGNATURE. Para este PROBE de
// diagnóstico contra un host conocido, ignoramos la verificación TLS de todo el
// proceso. (En la implementación final habrá que manejar el cert correctamente
// —p.ej. incluir el intermedio o un https.Agent acotado—, NO copiar esto.)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const prisma = require("../api/src/db/client");
const { decrypt } = require("../api/src/lib/crypto");

const BASE_URL = "https://zajuna.sena.edu.co/zajuna";
const SERVICE = "moodle_mobile_app"; // shortname estándar del servicio mobile de Moodle

async function main() {
  const email   = process.argv[2] || null;
  const courseId = process.argv[3] || null;

  // 1. Obtener usuario con credenciales Zajuna.
  // zajunaUserEnc es String obligatorio en el schema → no se puede filtrar por
  // null. Si no pasan email, tomamos el primer usuario (típico tras registro).
  const user = await prisma.user.findFirst({
    where: email ? { email } : undefined,
    select: { id: true, email: true, zajunaUserEnc: true, zajunaPassEnc: true },
  });

  if (!user) {
    console.error(`✖ No se encontró usuario${email ? ` con email ${email}` : " con credenciales Zajuna"}.`);
    process.exit(1);
  }
  if (!user.zajunaUserEnc || !user.zajunaPassEnc) {
    console.error(`✖ El usuario ${user.email} no tiene credenciales Zajuna guardadas.`);
    process.exit(1);
  }

  const username = decrypt(user.zajunaUserEnc);
  const password = decrypt(user.zajunaPassEnc);
  console.log(`→ Usuario: ${user.email}  (Zajuna user: ${username})`);

  // 2. Intentar /login/token.php
  const tokenUrl = `${BASE_URL}/login/token.php`;
  const params = new URLSearchParams({ username, password, service: SERVICE });
  console.log(`\n→ POST ${tokenUrl}  (service=${SERVICE})`);

  let token = null;
  try {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Algunos WAF de SENA rechazan requests sin User-Agent de navegador.
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
      },
      body: params.toString(),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }

    console.log(`   HTTP ${res.status}`);
    if (json && json.token) {
      token = json.token;
      console.log(`\n✅ SÍ FUNCIONA — token obtenido automáticamente.`);
      console.log(`   token: ${token.slice(0, 8)}…${token.slice(-4)} (${token.length} chars)`);
      if (json.privatetoken) console.log(`   privatetoken presente.`);
    } else if (json && (json.error || json.errorcode)) {
      console.log(`\n⚠️  SENA RECHAZÓ el token automático.`);
      console.log(`   errorcode: ${json.errorcode || "(sin código)"}`);
      console.log(`   error:     ${json.error || "(sin mensaje)"}`);
      console.log(`\n   → Interpretación:`);
      const ec = json.errorcode || "";
      if (/enablews|servicenotavailable|webservicesnotenabled|disabled/i.test(ec + json.error)) {
        console.log(`   El servicio mobile está DESHABILITADO en Zajuna. Ir por el CAMINO 2`);
        console.log(`   (sesskey + lib/ajax/service.php con la sesión Playwright).`);
      } else if (/invalidlogin|usernotconfirmed|invalidaccount/i.test(ec)) {
        console.log(`   Credenciales rechazadas por token.php (¿el servicio existe pero el login`);
        console.log(`   falla?). Verifica usuario/clave; puede que el servicio esté ok.`);
      } else {
        console.log(`   Revisar el errorcode arriba. Probablemente servicio capado → CAMINO 2.`);
      }
    } else {
      console.log(`\n? Respuesta inesperada (no JSON):`);
      console.log("   " + text.slice(0, 300));
    }
  } catch (e) {
    console.error(`\n✖ Error de red llamando token.php: ${e.message}`);
    // Node envuelve el error real en e.cause — ahí está la causa verdadera.
    if (e.cause) {
      console.error(`   causa: ${e.cause.code || ""} ${e.cause.message || e.cause}`);
      if (e.cause.code === "ENOTFOUND")              console.error(`   → DNS no resuelve. ¿Hay internet/VPN? (raro, porque Playwright sí conecta)`);
      else if (e.cause.code === "ECONNREFUSED")      console.error(`   → Conexión rechazada por el servidor.`);
      else if (e.cause.code === "ETIMEDOUT")         console.error(`   → Timeout. Posible firewall/proxy bloqueando.`);
      else if (/CERT|SSL|TLS|self-signed/i.test(e.cause.code + e.cause.message)) console.error(`   → Problema de certificado TLS. Puede que SENA use una cadena que Node rechaza.`);
    }
  }

  // 3. (Opcional) Si hay token y courseId, probar mod_assign_get_assignments
  if (token && courseId) {
    const wsUrl = `${BASE_URL}/webservice/rest/server.php`;
    const wsParams = new URLSearchParams({
      wstoken: token,
      wsfunction: "mod_assign_get_assignments",
      moodlewsrestformat: "json",
      "courseids[0]": String(courseId),
    });
    console.log(`\n→ POST ${wsUrl}  wsfunction=mod_assign_get_assignments courseid=${courseId}`);
    try {
      const res = await fetch(wsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: wsParams.toString(),
      });
      const json = await res.json();
      if (json.exception || json.errorcode) {
        console.log(`   ⚠️  ${json.errorcode || json.exception}: ${json.message || json.error}`);
      } else {
        const courses = json.courses || [];
        const assigns = courses[0]?.assignments || [];
        console.log(`   ✅ ${assigns.length} assignments devueltos. Muestra de fechas:`);
        for (const a of assigns.slice(0, 3)) {
          console.log(`      cmid=${a.cmid} "${a.name}"`);
          console.log(`        allowsubmissionsfromdate=${a.allowsubmissionsfromdate} duedate=${a.duedate} cutoffdate=${a.cutoffdate}`);
        }
      }
    } catch (e) {
      console.error(`   ✖ Error: ${e.message}`);
    }
  } else if (token && !courseId) {
    console.log(`\nℹ Pásame un courseId como 2º argumento para probar mod_assign_get_assignments:`);
    console.log(`   node scripts/probe-ws-token.js ${user.email} <courseId>`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("✖ Error fatal:", e);
  await prisma.$disconnect();
  process.exit(1);
});
