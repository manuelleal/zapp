/**
 * scraper/configEvidencias.js
 * Leer y guardar configuración de una evidencia (assign) en Moodle.
 * Usa la página /course/modedit.php?update={actId}&return=1
 */

const { BASE_URL, TIMEOUT, log, cerrarModal } = require("./auth");

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function waitForForm(page, actId) {
  const url = `${BASE_URL}/course/modedit.php?update=${actId}&return=1`;
  log(`[config] Navegando a: ${url}`);
  await page.goto(url, { waitUntil: "load", timeout: TIMEOUT });
  await cerrarModal(page);

  const formOk = await page
    .locator("#id_name")
    .isVisible({ timeout: 15_000 })
    .catch(() => false);

  if (!formOk) {
    const html = await page.content();
    log(`[config] Formulario no visible. HTML (500 chars): ${html.substring(0, 500)}`);
    throw new Error("Formulario modedit no encontrado — verifica que actId sea correcto y que el usuario tenga permiso de edición");
  }
}

async function leerFecha(page, prefijo) {
  const enabled = await page
    .locator(`#id_${prefijo}enabled`)
    .isChecked()
    .catch(() => false);

  if (!enabled) return { fecha: null, hora: null };

  const year   = await page.locator(`#id_${prefijo}_year`).inputValue().catch(() => null);
  const month  = await page.locator(`#id_${prefijo}_month`).inputValue().catch(() => null);
  const day    = await page.locator(`#id_${prefijo}_day`).inputValue().catch(() => null);
  const hour   = await page.locator(`#id_${prefijo}_hour`).inputValue().catch(() => "0");
  const minute = await page.locator(`#id_${prefijo}_minute`).inputValue().catch(() => "0");

  if (!year || !month || !day) return { fecha: null, hora: null };

  return {
    fecha: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    hora:  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
  };
}

async function setFecha(page, prefijo, fecha, hora) {
  if (!fecha) return;

  const [yearStr, monthStr, dayStr] = fecha.split("-");
  const year  = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day   = parseInt(dayStr, 10);

  let h = 0;
  let m = 0;
  if (hora) {
    const [hh, mm] = hora.split(":").map(Number);
    h = hh || 0;
    // Moodle minute select has options in multiples of 5; round to nearest 5
    m = Math.min(55, Math.round((mm || 0) / 5) * 5);
  }

  const checkbox = page.locator(`#id_${prefijo}enabled`);
  const isChecked = await checkbox.isChecked().catch(() => false);
  if (!isChecked) {
    await checkbox.check();
    await page.waitForTimeout(300);
  }

  await page.locator(`#id_${prefijo}_year`).selectOption(String(year));
  await page.locator(`#id_${prefijo}_month`).selectOption(String(month));
  await page.locator(`#id_${prefijo}_day`).selectOption(String(day));
  await page.locator(`#id_${prefijo}_hour`).selectOption(String(h));
  await page.locator(`#id_${prefijo}_minute`).selectOption(String(m));

  log(`[config] ${prefijo} → ${fecha} ${hora} (h=${h}, m=${m})`);
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

/**
 * Lee la configuración actual de una actividad (assign) desde el formulario modedit.
 * @param {import('playwright').Page} page
 * @param {string|number} actId  — course module ID (cmId)
 * @returns {{ nombre, abrirFecha, abrirHora, entregaFecha, entregaHora, limiteFecha, limiteHora, intentos }}
 */
async function leerConfigEvidencia(page, actId) {
  await waitForForm(page, actId);

  const nombre = await page.locator("#id_name").inputValue().catch(() => "");

  const apertura = await leerFecha(page, "allowsubmissionsfromdate");
  const entrega  = await leerFecha(page, "duedate");
  const limite   = await leerFecha(page, "cutoffdate");

  const intentosVal = await page
    .locator("#id_maxattempts")
    .inputValue()
    .catch(() => null);

  let intentos = null;
  if (intentosVal !== null) {
    intentos = intentosVal === "-1" ? "Ilimitado" : parseInt(intentosVal, 10);
  }

  const config = {
    nombre,
    abrirFecha:   apertura.fecha,
    abrirHora:    apertura.hora,
    entregaFecha: entrega.fecha,
    entregaHora:  entrega.hora,
    limiteFecha:  limite.fecha,
    limiteHora:   limite.hora,
    intentos,
  };

  log(`[config] Leído: ${JSON.stringify(config)}`);
  return config;
}

/**
 * Guarda la configuración en el formulario modedit.
 * Solo modifica los campos que vengan definidos en config (merge parcial).
 * @param {import('playwright').Page} page
 * @param {string|number} actId
 * @param {{ abrirFecha?, abrirHora?, entregaFecha?, entregaHora?, limiteFecha?, limiteHora?, intentos? }} config
 * @returns {{ ok: true }}
 */
async function guardarConfigEvidencia(page, actId, config) {
  await waitForForm(page, actId);

  if (config.abrirFecha !== undefined) {
    await setFecha(page, "allowsubmissionsfromdate", config.abrirFecha, config.abrirHora || "00:00");
  }
  if (config.entregaFecha !== undefined) {
    await setFecha(page, "duedate", config.entregaFecha, config.entregaHora || "23:55");
  }
  if (config.limiteFecha !== undefined) {
    await setFecha(page, "cutoffdate", config.limiteFecha, config.limiteHora || "23:55");
  }
  if (config.intentos !== undefined && config.intentos !== null) {
    const val =
      config.intentos === "Ilimitado" || config.intentos === -1
        ? "-1"
        : String(config.intentos);
    await page
      .locator("#id_maxattempts")
      .selectOption(val)
      .catch((e) => log(`[config] maxattempts selectOption falló (puede no existir): ${e.message}`));
  }

  // Submit — Moodle 4.x usa #id_submitbutton2, versiones anteriores #id_submitbutton
  const submitSel = "#id_submitbutton2, #id_submitbutton, input[name='submitbutton']";
  const submitBtn = page.locator(submitSel).first();
  const submitOk  = await submitBtn.isVisible({ timeout: 5_000 }).catch(() => false);
  if (!submitOk) {
    const html = await page.content();
    log(`[config] Botón submit no encontrado. HTML: ${html.substring(0, 600)}`);
    throw new Error("Botón submit no encontrado en el formulario modedit");
  }

  await submitBtn.click();
  await page.waitForLoadState("load", { timeout: TIMEOUT });

  // Detectar errores post-submit
  const errorSel = ".alert-danger, .error, #id_error_name, .form-errors, .generalbox.error";
  const hasError  = await page.locator(errorSel).isVisible({ timeout: 3_000 }).catch(() => false);
  if (hasError) {
    const errText = await page.locator(errorSel).first().textContent().catch(() => "Error desconocido");
    throw new Error(`Error al guardar: ${errText.trim().substring(0, 300)}`);
  }

  log("[config] Guardado exitoso ✓");
  return { ok: true };
}

module.exports = { leerConfigEvidencia, guardarConfigEvidencia };
