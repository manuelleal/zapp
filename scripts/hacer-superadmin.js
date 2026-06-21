/**
 * scripts/hacer-superadmin.js — Asigna el rol "superadmin" a un usuario por email.
 *
 * El superadmin puede CURAR (sobrescribir) los RAPs compartidos y entrar al panel
 * /admin. Los instructores normales solo AGREGAN RAPs que falten (no pisan los
 * existentes) — ver el blindaje en api/src/routes/raps.js (import).
 *
 * Uso:  node scripts/hacer-superadmin.js correo@ejemplo.com
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");

async function main() {
  const email = process.argv[2];
  if (!email) { console.error("Uso: node scripts/hacer-superadmin.js <email>"); process.exit(1); }

  const u = await prisma.user.update({ where: { email }, data: { rol: "superadmin" } })
    .catch(() => null);
  if (!u) { console.error("🔴 No se encontró un usuario con ese email:", email); process.exit(1); }

  console.log(`✅ ${u.email} ahora es superadmin (rol=${u.rol}).`);
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); })
      .finally(() => prisma.$disconnect());
