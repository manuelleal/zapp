/**
 * verificar-ia.js — Prueba de humo del cliente IA (OpenRouter / Kimi / Anthropic).
 *
 * POR QUÉ: tras rotar la OPENROUTER_API_KEY (quedó expuesta) hay que confirmar, sin
 * pegar one-liners largos en la terminal del servidor (gotcha #3: corrompe líneas),
 * que la clave nueva responde y que la IA "sirve" en ese entorno.
 *
 * QUÉ HACE: lee el .env del entorno donde se ejecuta, muestra qué proveedor/clave
 * está activa (ENMASCARADA, nunca imprime el secreto completo) y hace UNA llamada
 * real pidiendo un JSON trivial. Si responde, la IA funciona.
 *
 * USO:  node scripts/verificar-ia.js
 *   - En el PC:       desde C:\zajuna
 *   - En el servidor: desde /opt/helper
 *
 * No escribe en la base de datos (el registro de tokens de aiClient es best-effort y
 * tolera que Postgres no esté arriba).
 */

require("dotenv").config();
const { chatJSON, proveedorActivo } = require("../api/src/lib/aiClient");

// Enmascara una clave para loguear sin filtrarla (deja ver prefijo/sufijo y largo).
function enmascarar(clave) {
  if (!clave) return "(no definida)";
  if (clave.length <= 12) return "(definida)";
  return `${clave.slice(0, 8)}…${clave.slice(-4)} (len ${clave.length})`;
}

(async () => {
  const proveedor = proveedorActivo();
  console.log("── Verificación de IA ──────────────────────────────");
  console.log("Proveedor activo:", proveedor);
  console.log("OPENROUTER_API_KEY:", enmascarar(process.env.OPENROUTER_API_KEY));
  console.log("OPENROUTER_MODEL:", process.env.OPENROUTER_MODEL || "moonshotai/kimi-k2 (default)");
  console.log("MOONSHOT_API_KEY:", process.env.MOONSHOT_API_KEY ? "SET" : "(no definida)");
  console.log("ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "SET" : "(no definida)");
  console.log("────────────────────────────────────────────────────");

  try {
    const t0 = Date.now();
    const r = await chatJSON({
      system: "Devuelve SOLO JSON, sin texto extra.",
      user: 'Responde exactamente con {"ok": true, "saludo": "hola"}.',
      maxTokens: 64,
      feature: "verificar-ia",
    });
    const ms = Date.now() - t0;
    if (r && r.ok === true) {
      console.log(`✅ IA OK en ${ms} ms → ${JSON.stringify(r)}`);
      process.exit(0);
    }
    console.log(`⚠️ Respondió pero sin el JSON esperado (${ms} ms):`, JSON.stringify(r));
    process.exit(2);
  } catch (e) {
    console.error("❌ FALLO la llamada a la IA:", e.message);
    console.error("   Revisa que la clave del .env de ESTE entorno sea la nueva y que");
    console.error("   tras cambiarla recreaste PM2 (pm2 delete all && pm2 start ecosystem.config.js).");
    process.exit(1);
  }
})();
