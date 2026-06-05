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
 * Parsea la cadena "Último acceso" que devuelve Moodle es-CO.
 * Formatos observados:
 *   - "Nunca"                     → null
 *   - "hace 2 días"               → ahora - 2 días
 *   - "hace 5 horas 12 minutos"   → ahora - 5h12m
 *   - "hace 30 minutos"           → ahora - 30m
 *   - "miércoles, 14 de mayo de 2026, 10:30"  → fecha absoluta
 *   - ISO 8601 (poco común)       → Date.parse permisivo
 *
 * Devuelve un Date o null. NUNCA throw.
 */
function parseUltimoAcceso(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^nunca$/i.test(s)) return null;

  // 1. Intentar formatos relativos "hace X unidad [Y unidad]"
  const rel = s.match(/^hace\s+(.+)$/i);
  if (rel) {
    const partes = rel[1].matchAll(/(\d+)\s*(segundo|minuto|hora|d[ií]a|semana|mes|a[ñn]o)s?/gi);
    let totalMs = 0;
    let matched = false;
    for (const m of partes) {
      matched = true;
      const n = parseInt(m[1], 10);
      const unidad = m[2].toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const factor =
        unidad.startsWith("seg")  ? 1000 :
        unidad.startsWith("min")  ? 60_000 :
        unidad.startsWith("hor")  ? 3_600_000 :
        unidad.startsWith("dia")  ? 86_400_000 :
        unidad.startsWith("sem")  ? 7 * 86_400_000 :
        unidad.startsWith("mes")  ? 30 * 86_400_000 :
        unidad.startsWith("an")   ? 365 * 86_400_000 :
        0;
      totalMs += n * factor;
    }
    if (matched && totalMs > 0) return new Date(Date.now() - totalMs);
  }

  // 2. Fechas absolutas en español: "miércoles, 14 de mayo de 2026, 10:30"
  const meses = {
    enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
    julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
  };
  const abs = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?/i);
  if (abs) {
    const dia = parseInt(abs[1], 10);
    const mes = meses[abs[2].toLowerCase()];
    const anio = parseInt(abs[3], 10);
    const hora = abs[4] ? parseInt(abs[4], 10) : 0;
    const min  = abs[5] ? parseInt(abs[5], 10) : 0;
    if (mes !== undefined) return new Date(anio, mes, dia, hora, min);
  }

  // 3. Fallback Date.parse (ISO u otros)
  const ts = Date.parse(s);
  if (!Number.isNaN(ts)) return new Date(ts);

  return null;
}

/**
 * Extrae participantes del DOM de la página actual (`/user/index.php`).
 * Prueba múltiples selectores para sobrevivir versiones distintas de Moodle.
 *
 * @returns {Promise<Array<{moodleId:string, nombre:string, email:string, documento:string, ultimoAcceso:string, profileHref:string}>>}
 */
async function extraerParticipantesDelDOM(page) {
  return await page.evaluate(() => {
    const txt = (el) => (el?.textContent || "").trim();

    // ── Localizar filas de la tabla de participantes ─────────────────────────
    // Selectores en orden de preferencia. El primero que devuelva ≥1 fila gana.
    const SELECTORES_FILA = [
      "table#participants tbody tr",
      "table.userlist tbody tr",
      "table.generaltable tbody tr",
      "table.flexible tbody tr",
      "tr[data-userid]",
      "form#participantsform table tbody tr",
      "div.userlist table tbody tr",
    ];

    let filas = [];
    for (const sel of SELECTORES_FILA) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) {
        filas = Array.from(found).filter(f => {
          // Excluir filas vacías o de "no hay datos"
          if (f.classList.contains("emptyrow")) return false;
          if (txt(f).length < 3) return false;
          return true;
        });
        if (filas.length > 0) break;
      }
    }

    return filas.map((fila) => {
      // ── moodleId: data-userid o link a /user/view.php?id=N ─────────────────
      let moodleId = fila.getAttribute("data-userid") || "";
      let profileHref = "";
      if (!moodleId) {
        const linkUser = fila.querySelector('a[href*="/user/view.php?"], a[href*="user/profile.php?"]');
        if (linkUser) {
          profileHref = linkUser.getAttribute("href") || "";
          const m = profileHref.match(/[?&]id=(\d+)/);
          if (m) moodleId = m[1];
        }
      } else {
        const linkUser = fila.querySelector('a[href*="/user/view.php?"], a[href*="user/profile.php?"]');
        if (linkUser) profileHref = linkUser.getAttribute("href") || "";
      }

      // ── nombre: distintos selectores ───────────────────────────────────────
      const nombre = [
        ".col-fullname",
        "th.cell.c1",
        "td.cell.c1",
        ".cell.c1",
        "td:nth-child(2)",
        "th:nth-child(1)",
      ].map(s => txt(fila.querySelector(s))).find(t => t && t.length > 2) || "";

      // ── documento (username Moodle) ────────────────────────────────────────
      const documento = [
        ".col-username",
        "td.cell.c2",
        ".cell.c2",
        "td:nth-child(3)",
      ].map(s => txt(fila.querySelector(s))).find(t => t && t.length > 0) || "";

      // ── email: priorizar mailto: ───────────────────────────────────────────
      let email = "";
      const mailtoLink = fila.querySelector('a[href^="mailto:"]');
      if (mailtoLink) {
        email = mailtoLink.getAttribute("href").replace(/^mailto:/i, "").trim();
      }
      if (!email) {
        // Buscar texto que parezca email en cualquier celda
        for (const cell of fila.querySelectorAll("td, th")) {
          const t = txt(cell);
          const m = t.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
          if (m) { email = m[0]; break; }
        }
      }

      // ── último acceso: usualmente la última columna ────────────────────────
      const ultimoAcceso = [
        ".col-lastaccess",
        "td.cell.lastaccess",
        "td.lastaccess",
      ].map(s => txt(fila.querySelector(s))).find(t => t) ||
        // Fallback: última td si tiene formato de fecha o "hace"
        (() => {
          const tds = fila.querySelectorAll("td");
          if (tds.length === 0) return "";
          const last = txt(tds[tds.length - 1]);
          if (/hace\s|nunca|\d{4}|de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)/i.test(last)) {
            return last;
          }
          return "";
        })();

      return { moodleId, nombre, email, documento, ultimoAcceso, profileHref };
    });
  });
}

/**
 * Sincroniza la lista de participantes (aprendices) de un curso desde la página
 * de participantes de Moodle/Zajuna. Devuelve nombre, email, documento, último
 * acceso (string crudo) y moodleId de cada aprendiz (rol Estudiante).
 *
 * Estrategia:
 *  1. Navegar a /user/index.php?id=courseId&perpage=5000 (sin filtrar roleid;
 *     algunos cursos Zajuna no tienen el filtro o usan IDs distintos).
 *  2. Probar múltiples selectores en cascada (Moodle 3.x/4.x/Zajuna).
 *  3. Si se obtuvieron filas pero faltan emails en > 50%, hacer una segunda
 *     pasada por /user/profile.php?id=moodleId para llenar emails faltantes
 *     (lento pero confiable).
 *
 * NUNCA explota — si todo falla retorna []. Loggea diagnósticos.
 *
 * @param {import('playwright').Page} page  — Página autenticada en Zajuna
 * @param {number|string} courseId          — ID Moodle del curso (Ficha.courseId)
 * @param {{ profileFallback?: boolean }} [opts]
 * @returns {Promise<Array<{moodleId:string, nombre:string, email:string, documento:string, ultimoAcceso:string}>>}
 */
async function sincronizarParticipantes(page, courseId, opts = {}) {
  const { profileFallback = true } = opts;
  try {
    // 1. Intentar URL con perpage alto y SIN filtrar roleid (más permisivo).
    const urls = [
      `${BASE_URL}/user/index.php?id=${courseId}&perpage=5000`,
      `${BASE_URL}/user/index.php?id=${courseId}&roleid=5&perpage=500`,
    ];

    let participantes = [];
    let urlUsada = "";
    for (const url of urls) {
      try {
        log(`[sincronizarParticipantes] navegando a ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await cerrarModal(page).catch(() => {});

        // Esperar a que aparezca alguna tabla con filas. 8s es generoso.
        await page.waitForSelector("table tbody tr, tr[data-userid]", { timeout: 8000 }).catch(() => {});

        participantes = await extraerParticipantesDelDOM(page);
        if (participantes.length > 0) {
          urlUsada = url;
          break;
        }
      } catch (urlErr) {
        log(`[sincronizarParticipantes] fallo en ${url}: ${urlErr.message}`);
      }
    }

    if (participantes.length === 0) {
      log(`[sincronizarParticipantes] No se encontraron filas para courseId=${courseId} en ninguna URL.`);
      return [];
    }

    log(`[sincronizarParticipantes] courseId=${courseId} — ${participantes.length} filas encontradas via ${urlUsada}.`);

    // 2. Filtrar filas claramente inválidas (sin nombre, sin moodleId).
    let validos = participantes.filter(p => p.nombre && p.nombre.length > 3 && p.moodleId);
    log(`[sincronizarParticipantes] ${validos.length} validos (con moodleId y nombre).`);

    // 3. Fallback profile.php para emails faltantes.
    const sinEmail = validos.filter(p => !p.email);
    const ratio = validos.length > 0 ? sinEmail.length / validos.length : 0;
    if (profileFallback && ratio > 0.5 && sinEmail.length > 0) {
      log(`[sincronizarParticipantes] ${sinEmail.length}/${validos.length} sin email — fallback a /user/profile.php`);
      // Limitar a primeros 100 para evitar abusar (peor caso 100 navegaciones).
      const limite = Math.min(sinEmail.length, 100);
      for (let i = 0; i < limite; i++) {
        const p = sinEmail[i];
        const profileUrl = `${BASE_URL}/user/profile.php?id=${p.moodleId}`;
        try {
          await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
          await cerrarModal(page).catch(() => {});
          const emailFromProfile = await page.evaluate(() => {
            // En Moodle el email aparece como texto o link mailto en .userprofile
            const mailto = document.querySelector('a[href^="mailto:"]');
            if (mailto) return mailto.getAttribute("href").replace(/^mailto:/i, "").trim();
            const body = document.body.innerText;
            const m = body.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
            return m ? m[0] : "";
          });
          if (emailFromProfile) p.email = emailFromProfile;
        } catch (profErr) {
          log(`[sincronizarParticipantes] perfil ${p.moodleId} falló: ${profErr.message}`);
        }
      }
      const conEmail = validos.filter(v => v.email).length;
      log(`[sincronizarParticipantes] tras fallback: ${conEmail}/${validos.length} con email.`);
    }

    return validos;
  } catch (err) {
    log(`[sincronizarParticipantes] ERROR courseId=${courseId}: ${err.message}`);
    return [];
  }
}

module.exports = {
  enviarMensajeMoodle,
  linkWhatsApp,
  construirMensaje,
  sincronizarParticipantes,
  parseUltimoAcceso,
  extraerParticipantesDelDOM,
};
