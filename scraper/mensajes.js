const { BASE_URL, log, cerrarModal } = require("./auth");

/**
 * Envía un mensaje interno de Moodle a un aprendiz.
 * Requiere que `page` esté autenticado en Zajuna.
 *
 * @param {import('playwright').Page} page
 * @param {number|string} moodleUserId  — ID Moodle del destinatario
 * @param {string}        texto         — Texto del mensaje
 * @returns {{ ok: boolean, msgId?: number, error?: string }}
 */
async function enviarMensajeMoodle(page, moodleUserId, texto) {
  log(`Enviando mensaje interno a userId=${moodleUserId}...`);

  const resultado = await page.evaluate(
    async ({ baseUrl, touserid, text }) => {
      const sesskey = window.M?.cfg?.sesskey
        || document.querySelector('input[name="sesskey"]')?.value
        || new URL(document.querySelector('a[data-title="logout,moodle"]')?.href || "http://x")
             .searchParams.get("sesskey");

      if (!sesskey) return { ok: false, error: "No se pudo obtener sesskey" };

      const url = `${baseUrl}/lib/ajax/service.php?sesskey=${sesskey}&info=core_message_send_instant_messages`;

      const body = JSON.stringify([{
        index:      0,
        methodname: "core_message_send_instant_messages",
        args: {
          messages: [{
            touserid:   Number(touserid),
            text,
            textformat: 0,
          }],
        },
      }]);

      try {
        const res  = await fetch(url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        const json = await res.json();
        const item = json?.[0];

        if (!item)                  return { ok: false, error: "Respuesta vacía" };
        if (item.msgid === -1)      return { ok: false, error: item.errormessage || "Error Moodle" };
        if (item.error)             return { ok: false, error: item.exception?.message || item.error };
        return { ok: true, msgId: item.msgid };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    { baseUrl: BASE_URL, touserid: moodleUserId, text: texto }
  );

  if (resultado.ok) {
    log(`Mensaje enviado ✓ (msgId=${resultado.msgId})`);
  } else {
    log(`Error al enviar mensaje: ${resultado.error}`);
  }

  return resultado;
}

/**
 * Genera un link de WhatsApp para abrir directamente una conversación.
 *
 * @param {string} telefono  — Número con código de país sin + (ej: "573001234567")
 * @param {string} mensaje   — Texto del mensaje
 * @returns {string}         — URL wa.me
 */
function linkWhatsApp(telefono, mensaje) {
  const numero = telefono.replace(/\D/g, "");
  return `https://wa.me/${numero}?text=${encodeURIComponent(mensaje)}&app_absent=1`;
}

/**
 * Construye el texto de notificación estándar para un aprendiz.
 *
 * @param {{ nombre: string, instructor: string, ficha: string }} params
 * @param {string[]} evidenciasPendientes   — nombres de evidencias sin entregar
 * @param {string[]} evidenciasDesaprobadas — nombres de evidencias con D
 * @returns {string}
 */
function construirMensaje({ nombre, instructor, ficha }, evidenciasPendientes = [], evidenciasDesaprobadas = []) {
  const partes = [`Buen día ${nombre},`];

  if (evidenciasPendientes.length) {
    partes.push(
      `\nTienes ${evidenciasPendientes.length} evidencia(s) pendiente(s) de entregar en la ficha ${ficha}:`,
      ...evidenciasPendientes.map((e, i) => `  ${i + 1}. ${e}`)
    );
  }

  if (evidenciasDesaprobadas.length) {
    partes.push(
      `\nTienes ${evidenciasDesaprobadas.length} evidencia(s) con calificación D (Desaprobado):`,
      ...evidenciasDesaprobadas.map((e, i) => `  ${i + 1}. ${e}`)
    );
  }

  partes.push(`\nInstructor: ${instructor}`);
  return partes.join("\n");
}

/**
 * Sincroniza la lista de participantes (aprendices) de un curso desde la página
 * de participantes de Moodle/Zajuna. Devuelve nombre, email, documento, último
 * acceso y moodleId de cada aprendiz (rol Estudiante).
 *
 * NUNCA debe explotar — si los selectores fallan loguea el error y retorna [].
 *
 * @param {import('playwright').Page} page  — Página autenticada en Zajuna
 * @param {number|string} courseId          — ID Moodle del curso (Ficha.courseId)
 * @returns {Promise<Array<{moodleId:string, nombre:string, email:string, documento:string, ultimoAcceso:string}>>}
 */
async function sincronizarParticipantes(page, courseId) {
  try {
    // roleid=5 = Estudiante/Aprendiz en Moodle. perpage=500 evita paginar.
    const url = `${BASE_URL}/user/index.php?id=${courseId}&roleid=5&perpage=500`;
    log(`[sincronizarParticipantes] navegando a ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await cerrarModal(page).catch(() => {});

    // Esperar a que la tabla aparezca. Si no aparece en 8s, asumimos que la
    // página devolvió otra cosa (login expirado, error, etc.) y retornamos [].
    try {
      await page.waitForSelector("table tr[data-userid], #participants tr[data-userid]", { timeout: 8000 });
    } catch {
      log(`[sincronizarParticipantes] No se encontró tabla de participantes para courseId=${courseId}`);
      return [];
    }

    const participantes = await page.evaluate(() => {
      // Selectores principales de Moodle 4.x. TODO: si fallan, intentar
      // table.flexible tbody tr, td.cell.c1, td.cell.c2, td.cell.c3, td.cell.c5.
      const filas = document.querySelectorAll("tr[data-userid]");
      const txt = (el) => (el?.textContent || "").trim();
      return Array.from(filas).map((fila) => {
        const moodleId = fila.getAttribute("data-userid") || "";
        const nombre   = txt(fila.querySelector(".col-fullname, td.c1, td:nth-child(2)"));
        const documento = txt(fila.querySelector(".col-username, td.c2, td:nth-child(3)"));
        const email    = txt(fila.querySelector(".col-email, td.c3, td:nth-child(4)"));
        const ultimoAcceso = txt(fila.querySelector(".col-lastaccess, td.c5, td:nth-child(6)"));
        return { moodleId, nombre, email, documento, ultimoAcceso };
      });
    });

    const filtrados = participantes.filter(p => p.nombre && p.nombre.length > 3);
    log(`[sincronizarParticipantes] courseId=${courseId} — ${filtrados.length} encontrados (de ${participantes.length} filas).`);
    return filtrados;
  } catch (err) {
    log(`[sincronizarParticipantes] ERROR courseId=${courseId}: ${err.message}`);
    return [];
  }
}

module.exports = { enviarMensajeMoodle, linkWhatsApp, construirMensaje, sincronizarParticipantes };
