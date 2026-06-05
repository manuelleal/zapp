require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const nodemailer = require("nodemailer");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const prisma = require("../db/client");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Reemplaza variables {{nombre}}, {{ficha}}, {{instructor}}, {{evidencias}}
 * en texto plano (sin envolver en HTML). Usar para campos como subject.
 *
 * Para {{evidencias}} en texto plano se concatena con saltos de línea (no <li>),
 * a diferencia de personalizarMensaje() que va en HTML.
 */
function aplicarVariables(texto, dest) {
  const evidenciasTxt = Array.isArray(dest.evidencias)
    ? dest.evidencias.join(", ")
    : (dest.evidencias ?? "");

  return String(texto ?? "")
    .replace(/\{\{nombre\}\}/gi,     dest.nombre ?? "")
    .replace(/\{\{evidencias\}\}/gi, evidenciasTxt)
    .replace(/\{\{ficha\}\}/gi,      dest.ficha ?? "")
    .replace(/\{\{instructor\}\}/gi, dest.instructor ?? "");
}

function personalizarMensaje(cuerpo, dest) {
  const evidenciasHtml = Array.isArray(dest.evidencias)
    ? dest.evidencias.map(e => `<li>${escapeHtml(e)}</li>`).join("")
    : escapeHtml(dest.evidencias ?? "");

  const texto = String(cuerpo ?? "")
    .replace(/\{\{nombre\}\}/gi,     escapeHtml(dest.nombre ?? ""))
    .replace(/\{\{evidencias\}\}/gi, evidenciasHtml)
    .replace(/\{\{ficha\}\}/gi,      escapeHtml(dest.ficha ?? ""))
    .replace(/\{\{instructor\}\}/gi, escapeHtml(dest.instructor ?? ""));

  return `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <div style="background:#1d4ed8;padding:16px;border-radius:8px 8px 0 0">
    <h2 style="color:white;margin:0;font-size:16px">🎓 Notificación SENA</h2>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:none;padding:20px;border-radius:0 0 8px 8px">
    ${texto.replace(/\n/g, "<br>")}
    <hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb">
    <p style="color:#6b7280;font-size:12px">
      Sistema de gestión SENA — Zajuna App<br>
      <a href="https://zajuna.sena.edu.co">Ingresar a Zajuna</a>
    </p>
  </div>
</div>`;
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker("emailMasivo", async (job) => {
  const { mensajeFormativoId, userId } = job.data;

  const mf = await prisma.mensajeFormativo.findUnique({ where: { id: mensajeFormativoId } });
  if (!mf) throw new Error(`MensajeFormativo ${mensajeFormativoId} no encontrado.`);

  const config = await prisma.configCorreo.findUnique({ where: { userId } });
  if (!config) {
    await prisma.mensajeFormativo.update({
      where: { id: mensajeFormativoId },
      data:  { estado: "error", errorMsg: "No hay configuración SMTP. Configura en Ajustes.", enviadoAt: new Date() },
    });
    throw new Error("No hay configuración de correo. Configura el SMTP en Ajustes.");
  }

  const pass = decrypt(config.smtpPassEnc);
  const transporter = nodemailer.createTransport({
    host:   config.smtpHost,
    port:   config.smtpPort,
    secure: config.smtpPort === 465,
    auth:   { user: config.smtpUser, pass },
  });

  const destinatarios = Array.isArray(mf.destinatarios) ? mf.destinatarios : [];
  let enviados = 0, errores = 0;
  const erroresDetalle = [];

  for (const dest of destinatarios) {
    if (!dest.email) {
      errores++;
      erroresDetalle.push({ email: null, nombre: dest.nombre, error: "Sin email" });
      continue;
    }
    try {
      await transporter.sendMail({
        from:    `"${config.fromNombre || "Instructor SENA"}" <${config.smtpUser}>`,
        to:      dest.email,
        subject: aplicarVariables(mf.asunto, dest),
        html:    personalizarMensaje(mf.cuerpo, dest),
      });
      enviados++;
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      errores++;
      erroresDetalle.push({ email: dest.email, nombre: dest.nombre, error: err.message });
      console.error(`[emailMasivo] Error enviando a ${dest.email}:`, err.message);
    }
  }

  const total = destinatarios.length;
  const estadoFinal = errores === 0 ? "enviado"
    : enviados === 0 ? "error"
    : "enviado"; // parcial → "enviado" con errorMsg

  await prisma.mensajeFormativo.update({
    where: { id: mensajeFormativoId },
    data: {
      estado:    estadoFinal,
      enviadoAt: new Date(),
      errorMsg:  errores > 0 ? `${enviados}/${total} enviados. ${errores} fallidos.` : null,
    },
  });

  return { enviados, errores, total, erroresDetalle };
}, { connection, concurrency: 1 });

worker.on("failed", async (job, err) => {
  if (job?.data?.mensajeFormativoId) {
    await prisma.mensajeFormativo.update({
      where: { id: job.data.mensajeFormativoId },
      data:  { estado: "error", errorMsg: err.message, enviadoAt: new Date() },
    }).catch(() => {});
  }
});

module.exports = worker;
