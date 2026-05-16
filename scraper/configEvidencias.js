/**
 * scraper/configEvidencias.js
 *
 * Técnica: igual a la Extensión Z.
 *   1. GET /course/modedit.php?update={actId}  →  serializar TODOS los campos del formulario
 *   2. Sobreescribir solo los campos enviados (merge parcial)
 *   3. POST /course/modedit.php  con el cuerpo completo (incluye sesskey, hidden fields, etc.)
 *
 * Usar el formulario completo evita perder campos ocultos requeridos por Moodle
 * y no depende de interacciones UI frágiles (selectOption, check, etc.).
 */

const { BASE_URL, TIMEOUT, log, cerrarModal } = require("./auth");

// ─── FIELD MAPS POR TIPO (Sprint 2.6 FIX B) ─────────────────────────────────
// Mapping replica el de la Extensión Z (root.PiOpq-8m.js):
//   forum.duedate     → apertura  (en forum, duedate es la fecha visible al alumno)
//   forum.cutoffdate  → entrega   (cutoff = bloqueo de posts)
//   quiz.timeopen     → apertura
//   quiz.timeclose    → entrega
//   assign.allowsubmissionsfromdate → apertura
//   assign.duedate    → entrega
//   assign.cutoffdate → limite (extensión)
const FIELD_MAPS = {
  assign: {
    abrir:    "allowsubmissionsfromdate",
    entrega:  "duedate",
    limite:   "cutoffdate",
    intentos: { name: "maxattempts", unlimitedValue: "-1" },
  },
  forum: {
    abrir:    "duedate",
    entrega:  "cutoffdate",
    limite:   null,
    intentos: null,
  },
  quiz: {
    abrir:    "timeopen",
    entrega:  "timeclose",
    limite:   null,
    intentos: null,
  },
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────────────

/**
 * Detecta el tipo de modulo desde body.classList (path-mod-assign / path-mod-forum / path-mod-quiz).
 * Fallback: "assign".
 */
async function detectarTipo(page) {
  return await page.evaluate(() => {
    const cls = document.body.className || "";
    if (cls.includes("path-mod-forum")) return "forum";
    if (cls.includes("path-mod-quiz"))  return "quiz";
    if (cls.includes("path-mod-assign")) return "assign";
    return "assign";
  });
}

/**
 * Activa el modo edición del curso para esta sesión.
 *
 * Por qué: la extensión Z corre en el navegador del instructor que YA tiene
 * el modo edición activo (toggle visible arriba en la UI de Zajuna, ver
 * "Modo de edición" en la barra superior). Nuestra sesión Playwright es
 * fresca y Moodle puede redirigir /course/modedit.php?update=X cuando el
 * modo edición está OFF, devolviendo HTML sin el formulario y disparando
 * "Formulario modedit no encontrado".
 *
 * Solución: visitar /course/view.php?id={courseId}&edit=on&sesskey={X}
 * antes de cualquier navegación a modedit. Idempotente.
 */
async function enableEditMode(page, courseId) {
  if (!courseId) {
    log("[editmode] courseId ausente; saltando toggle edit=on");
    return;
  }
  // Aterrizar en una página del curso para tener M.cfg.sesskey disponible.
  await page.goto(
    `${BASE_URL}/course/view.php?id=${courseId}`,
    { waitUntil: "domcontentloaded", timeout: TIMEOUT }
  );
  await cerrarModal(page);

  const sesskey = await page.evaluate(() => {
    // 1) M.cfg (más confiable en Moodle 4.x)
    if (typeof window.M !== "undefined" && window.M.cfg && window.M.cfg.sesskey) {
      return window.M.cfg.sesskey;
    }
    // 2) input[name=sesskey] de cualquier form de la página
    const input = document.querySelector('input[name="sesskey"]');
    if (input && input.value) return input.value;
    // 3) link de logout (igual fallback que usa la extensión Z)
    const logout = document.querySelector(
      'a[href*="logout.php"], a[data-title="logout,moodle"]'
    );
    if (logout) {
      const m = (logout.href || "").match(/sesskey=([^&]+)/);
      if (m) return m[1];
    }
    return null;
  });

  if (!sesskey) {
    log("[editmode] No se pudo obtener sesskey; modo edición no se activará");
    return;
  }

  await page.goto(
    `${BASE_URL}/course/view.php?id=${courseId}&edit=on&sesskey=${encodeURIComponent(sesskey)}`,
    { waitUntil: "domcontentloaded", timeout: TIMEOUT }
  );
  await cerrarModal(page);
  log(`[editmode] edit=on activado (curso ${courseId})`);
}

/**
 * Navega al formulario modedit y verifica que cargó correctamente.
 */
async function navegarFormulario(page, actId) {
  const url = `${BASE_URL}/course/modedit.php?update=${actId}&return=1`;
  log(`[config] GET ${url}`);
  await page.goto(url, { waitUntil: "load", timeout: TIMEOUT });
  await cerrarModal(page);

  // Verificar que el formulario está presente
  const formOk = await page
    .locator("#modeditform, form[id*='modedit']")
    .isVisible({ timeout: 15_000 })
    .catch(() => false);

  if (!formOk) {
    // Detectar redirect a login (sesión expulsada por concurrencia)
    const url   = page.url();
    const isLogin = /\/login|loginindex/i.test(url);
    const html = await page.content();
    log(`[config] Formulario no visible. URL=${url}. HTML snippet:\n${html.substring(0, 800)}`);
    throw new Error(
      isLogin
        ? "La sesion fue expulsada (otro login concurrente). Vuelve a intentar en unos segundos."
        : "Formulario modedit no encontrado — verifica que actId sea correcto y que el usuario tenga permiso de edición"
    );
  }
}

/**
 * Serializa TODOS los campos del formulario modedit en un objeto plano { name: value }.
 * Replica el comportamiento de un submit nativo del navegador:
 *  - Checkboxes no marcados → valor del hidden hermano (patrón Moodle) o ausencia
 *  - Selects múltiples → última opción seleccionada (simplificado; Moodle no los usa aquí)
 *  - Botones submit → excluidos (se añaden luego al POST)
 */
async function serializarFormulario(page) {
  return await page.evaluate(() => {
    const form =
      document.querySelector("#modeditform") ||
      document.querySelector("form[method='post'][action*='modedit']");

    if (!form) return null;

    const data = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      // Excluir botones — se añaden manualmente en el POST
      if (el.type === "submit" || el.type === "button" || el.type === "image") continue;
      if (el.type === "checkbox") {
        // Solo añadir si está marcado; el hidden hermano (value="0") ya habrá
        // seteado la clave con "0" al pasar por el bloque else de abajo
        if (el.checked) data[el.name] = el.value || "1";
      } else if (el.type === "radio") {
        if (el.checked) data[el.name] = el.value;
      } else {
        data[el.name] = el.value;
      }
    }

    return { data, action: form.action };
  });
}

/**
 * Extrae una fecha/hora del objeto de campos serializado.
 * @param {Record<string,string>} d  — resultado de serializarFormulario
 * @param {string} prefix  — e.g. "allowsubmissionsfromdate"
 */
function extraerFecha(d, prefix) {
  const enabled = d[`${prefix}[enabled]`] === "1";
  if (!enabled) return { fecha: null, hora: null };

  const year   = d[`${prefix}[year]`];
  const month  = d[`${prefix}[month]`];
  const day    = d[`${prefix}[day]`];
  const hour   = d[`${prefix}[hour]`]   || "0";
  const minute = d[`${prefix}[minute]`] || "0";

  if (!year || !month || !day) return { fecha: null, hora: null };

  return {
    fecha: `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`,
    hora:  `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
  };
}

/**
 * Aplica una fecha al objeto de campos (merge parcial).
 * @param {Record<string,string>} d
 * @param {string} prefix
 * @param {string} fecha   — "YYYY-MM-DD"
 * @param {string} hora    — "HH:MM"
 */
function aplicarFecha(d, prefix, fecha, hora) {
  if (!fecha) return;

  const [yearStr, monthStr, dayStr] = fecha.split("-");
  let h = 0;
  let m = 0;
  if (hora) {
    const [hh, mm] = hora.split(":").map(Number);
    h = hh || 0;
    // Moodle ofrece minutos en múltiplos de 5; redondear
    m = Math.min(55, Math.round((mm || 0) / 5) * 5);
  }

  d[`${prefix}[enabled]`] = "1";
  d[`${prefix}[year]`]    = yearStr;
  d[`${prefix}[month]`]   = String(parseInt(monthStr, 10));
  d[`${prefix}[day]`]     = String(parseInt(dayStr, 10));
  d[`${prefix}[hour]`]    = String(h);
  d[`${prefix}[minute]`]  = String(m);

  log(`[config] ${prefix} → ${fecha} ${hora} (h=${h}, m=${m})`);
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

/**
 * Lee la configuracion actual de una evidencia desde el formulario modedit.
 * Detecta tipo (assign/forum/quiz) y usa el FIELD_MAP correspondiente.
 *
 * @param {import('playwright').Page} page
 * @param {string|number} actId  — course module ID
 * @returns {{
 *   tipo, nombre,
 *   abrirFecha, abrirHora, entregaFecha, entregaHora,
 *   limiteFecha, limiteHora,    // null para forum/quiz
 *   intentos,                    // null si el tipo no soporta intentos
 * }}
 */
async function leerConfigEvidencia(page, actId) {
  await navegarFormulario(page, actId);

  const tipo = await detectarTipo(page);
  const map  = FIELD_MAPS[tipo] || FIELD_MAPS.assign;

  const form = await serializarFormulario(page);
  if (!form) throw new Error("No se pudo serializar el formulario modedit");

  const d = form.data;

  const apertura = map.abrir   ? extraerFecha(d, map.abrir)   : { fecha: null, hora: null };
  const entrega  = map.entrega ? extraerFecha(d, map.entrega) : { fecha: null, hora: null };
  const limite   = map.limite  ? extraerFecha(d, map.limite)  : { fecha: null, hora: null };

  let intentos = null;
  if (map.intentos && map.intentos.name) {
    const raw = d[map.intentos.name];
    if (raw !== undefined && raw !== null) {
      intentos = raw === map.intentos.unlimitedValue ? "Ilimitado" : parseInt(raw, 10);
    }
  }

  const config = {
    tipo,
    nombre:       d["name"] || "",
    abrirFecha:   apertura.fecha,
    abrirHora:    apertura.hora,
    entregaFecha: entrega.fecha,
    entregaHora:  entrega.hora,
    limiteFecha:  limite.fecha,
    limiteHora:   limite.hora,
    intentos,
  };

  log(`[config] Leido tipo=${tipo}: ${JSON.stringify(config)}`);
  return config;
}

/**
 * Guarda la configuración en Moodle usando POST directo al formulario modedit.
 * Solo modifica los campos presentes en `config` (merge parcial).
 * @param {import('playwright').Page} page
 * @param {string|number} actId
 * @param {{ abrirFecha?, abrirHora?, entregaFecha?, entregaHora?, limiteFecha?, limiteHora?, intentos? }} config
 * @returns {{ ok: true }}
 */
async function guardarConfigEvidencia(page, actId, config) {
  await navegarFormulario(page, actId);

  const tipo = await detectarTipo(page);
  const map  = FIELD_MAPS[tipo] || FIELD_MAPS.assign;

  const form = await serializarFormulario(page);
  if (!form) throw new Error("No se pudo serializar el formulario modedit");

  // Copia mutable del formulario completo (incluye sesskey y todos los campos ocultos)
  const d = { ...form.data };

  // Aplicar solo los campos enviados, respetando el field map del tipo.
  if (config.abrirFecha !== undefined && map.abrir) {
    aplicarFecha(d, map.abrir, config.abrirFecha, config.abrirHora || "00:00");
  }
  if (config.entregaFecha !== undefined && map.entrega) {
    aplicarFecha(d, map.entrega, config.entregaFecha, config.entregaHora || "23:55");
  }
  if (config.limiteFecha !== undefined && map.limite) {
    aplicarFecha(d, map.limite, config.limiteFecha, config.limiteHora || "23:55");
  } else if (config.limiteFecha !== undefined && !map.limite) {
    log(`[config] tipo=${tipo} no soporta fecha limite; ignorando`);
  }
  if (config.intentos !== undefined && config.intentos !== null && map.intentos) {
    d[map.intentos.name] =
      config.intentos === "Ilimitado" || config.intentos === -1
        ? map.intentos.unlimitedValue
        : String(config.intentos);
  }

  // POST con el formulario completo desde dentro del contexto del navegador
  // (usa las cookies/sesión ya activas — mismo mecanismo que la Extensión Z)
  const postResult = await page.evaluate(
    async ({ action, fields }) => {
      const body = new URLSearchParams(fields);
      // Indicar a Moodle qué botón se "presionó"
      body.set("submitbutton2", "Guardar cambios y mostrar");

      const res = await fetch(action, {
        method:      "POST",
        headers:     { "Content-Type": "application/x-www-form-urlencoded" },
        body:        body.toString(),
        credentials: "include",
        redirect:    "follow",
      });

      const text = await res.text();
      return {
        ok:      res.ok,
        status:  res.status,
        finalUrl: res.url,
        snippet: text.substring(0, 1200),
      };
    },
    { action: form.action, fields: d }
  );

  log(`[config] POST → status=${postResult.status} url=${postResult.finalUrl}`);

  if (!postResult.ok) {
    throw new Error(`POST fallido: HTTP ${postResult.status}`);
  }

  // Detectar errores en la respuesta HTML (Moodle puede devolver 200 con error embebido)
  const errorPatterns = [
    "alert-danger", "class=\"error\"", "id=\"id_error_",
    "form-errors", "generalbox error",
  ];
  const hayError = errorPatterns.some((p) => postResult.snippet.includes(p));
  if (hayError) {
    // Extraer el texto del error con una regex simple
    const match = postResult.snippet.match(/class="[^"]*error[^"]*"[^>]*>([^<]{1,300})</i);
    const msg   = match ? match[1].trim() : "Error desconocido en respuesta de Moodle";
    throw new Error(`Error al guardar: ${msg}`);
  }

  log("[config] Guardado exitoso ✓");
  return { ok: true };
}

module.exports = { leerConfigEvidencia, guardarConfigEvidencia, enableEditMode };
