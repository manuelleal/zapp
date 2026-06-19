/**
 * smtpErrors.js — Traduce errores crudos de SMTP (nodemailer) a pistas en español
 * accionables para el instructor. Lo usan emailMasivoWorker.js (al fallar un envío)
 * y la ruta /api/ajustes/correo/probar (botón "Probar conexión").
 *
 * No lanza: siempre devuelve un string. Si no reconoce el error, devuelve el mensaje
 * original (recortado) para no esconder información.
 */

function humanizarErrorSMTP(msg) {
  const m = String(msg || "");

  // Gmail con 2FA: rechaza la contraseña normal y exige "contraseña de aplicación".
  if (m.includes("Application-specific password") || m.includes("5.7.9") || m.includes("InvalidSecondFactor")) {
    return "Gmail requiere una CONTRASEÑA DE APLICACIÓN (no tu contraseña normal). " +
           "Actívala en https://myaccount.google.com/apppasswords y pégala en Ajustes → Correo.";
  }

  // Microsoft/Outlook: SMTP Auth básico deshabilitado por política del tenant.
  if (m.includes("SmtpClientAuthentication") || m.includes("535 5.7.139")) {
    return "Tu cuenta de Outlook/SENA tiene la autenticación SMTP deshabilitada por el administrador. " +
           "Usa Gmail con contraseña de aplicación, o contacta a sistemas del SENA.";
  }

  // Credenciales incorrectas en general.
  if (m.includes("Invalid login") || m.includes("Username and Password not accepted") || m.includes("535")) {
    return "Usuario o contraseña SMTP incorrectos. Revisa el correo y la contraseña en Ajustes → Correo.";
  }

  // Host/puerto inalcanzable.
  if (m.includes("ECONNREFUSED") || m.includes("ETIMEDOUT") || m.includes("ENOTFOUND") || m.includes("getaddrinfo")) {
    return "No se pudo conectar al servidor SMTP. Revisa el host y el puerto en Ajustes → Correo.";
  }

  return m.length > 160 ? m.slice(0, 160) + "…" : m;
}

module.exports = { humanizarErrorSMTP };
