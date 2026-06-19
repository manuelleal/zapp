/**
 * emailMasivoWorker.js — Cola "emailMasivo".
 *
 * QUÉ HACE: envía correos masivos por SMTP (nodemailer) — distinto de
 * mensajeFormativoWorker, que usa la mensajería interna de Moodle. Este NO toca
 * Zajuna ni Playwright: lee el MensajeFormativo y dispara emails reales.
 *
 * job.data: { mensajeFormativoId, userId }
 * concurrency: 1.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const nodemailer = require("nodemailer");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const { humanizarErrorSMTP } = require("../lib/smtpErrors");
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
 * Normaliza dest.evidencias a nombres (strings). Mismo criterio que en
 * mensajeFormativoWorker.js: acepta array de strings O de objetos { nombre }
 * (defensivo — sin esto, un objeto produciría "[object Object]" en el correo).
 */
function nombresDeEvidencias(evidencias) {
  if (!Array.isArray(evidencias)) return [];
  return evidencias
    .map(e => (typeof e === "string" ? e : e?.nombre ?? ""))
    .map(s => String(s).trim())
    .filter(Boolean);
}

/**
 * Reemplaza variables {{nombre}}, {{ficha}}, {{instructor}}, {{evidencias}}
 * en texto plano (sin envolver en HTML). Usar para campos como subject.
 *
 * Para {{evidencias}} en texto plano (subject) se concatena con comas (no <li>),
 * a diferencia de personalizarMensaje() que va en HTML.
 */
function aplicarVariables(texto, dest) {
  const evidenciasTxt = nombresDeEvidencias(dest.evidencias).join(", ");

  return String(texto ?? "")
    .replace(/\{\{nombre\}\}/gi,     dest.nombre ?? "")
    .replace(/\{\{evidencias\}\}/gi, () => evidenciasTxt)
    .replace(/\{\{ficha\}\}/gi,      dest.ficha ?? "")
    .replace(/\{\{instructor\}\}/gi, dest.instructor ?? "");
}

function personalizarMensaje(cuerpo, dest) {
  // {{evidencias}} en HTML: encabezado "Tienes N..." + <ol> numerado, misma
  // semántica que el texto plano de mensajeFormativoWorker (paridad de canales).
  // Si no hay evidencias → "" (no queda el token crudo en el correo).
  // Solo la lista numerada (sin "Tienes N..." — la plantilla ya da el contexto,
  // evita el texto duplicado). Si no hay evidencias → "" (no queda token crudo).
  const nombresEv = nombresDeEvidencias(dest.evidencias);
  const evidenciasHtml = nombresEv.length
    ? `<ol style="margin:8px 0;padding-left:20px">${nombresEv.map(e => `<li>${escapeHtml(e)}</li>`).join("")}</ol>`
    : "";

  const texto = String(cuerpo ?? "")
    .replace(/\{\{nombre\}\}/gi,     escapeHtml(dest.nombre ?? ""))
    // función como replacement: evita interpretar "$&"/"$1" del contenido
    .replace(/\{\{evidencias\}\}/gi, () => evidenciasHtml)
    .replace(/\{\{ficha\}\}/gi,      escapeHtml(dest.ficha ?? ""))
    .replace(/\{\{instructor\}\}/gi, escapeHtml(dest.instructor ?? ""));

  return `
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#f8fafc">
  <div style="background:#39A900;padding:18px 20px;border-radius:8px 8px 0 0">
    <h2 style="color:white;margin:0;font-size:17px;font-weight:600">Servicio Nacional de Aprendizaje — SENA</h2>
  </div>
  <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:none;padding:22px;border-radius:0 0 8px 8px;color:#1f2937;font-size:14px;line-height:1.55">
    ${texto.replace(/\n/g, "<br>")}
    <hr style="margin:18px 0;border:none;border-top:1px solid #e5e7eb">
    <p style="color:#6b7280;font-size:12px;margin:0">
      Este es un mensaje de seguimiento de tu proceso de formación.
      Ingresa a la plataforma para revisar tus evidencias:
      <a href="https://zajuna.sena.edu.co" style="color:#39A900;text-decoration:none;font-weight:600">zajuna.sena.edu.co</a>
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
  // Tres niveles, igual que el canal Zajuna: enviado / parcial / error.
  const estadoFinal = errores === 0 ? "enviado"
    : enviados === 0 ? "error"
    : "parcial";

  // Mensaje de error legible: si todo falló por la misma causa SMTP (ej. Gmail sin
  // contraseña de aplicación), se muestra esa pista en vez de un críptico "X/Y".
  let errorMsg = null;
  if (errores > 0) {
    const primera = erroresDetalle.find(e => e.error && e.error !== "Sin email")?.error;
    const pista = primera ? humanizarErrorSMTP(primera) : null;
    errorMsg = `${enviados}/${total} enviados, ${errores} fallidos.` + (pista ? ` ${pista}` : "");
  }

  await prisma.mensajeFormativo.update({
    where: { id: mensajeFormativoId },
    data: { estado: estadoFinal, enviadoAt: new Date(), errorMsg },
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
