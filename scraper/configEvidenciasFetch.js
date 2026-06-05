/**
 * scraper/configEvidenciasFetch.js
 *
 * Variante de configEvidencias.js que NO usa Playwright: lee y guarda la config
 * de una evidencia (fechas/intentos) hablando con Moodle por `fetch` de Node con
 * las cookies de la sesión SSO (extraídas del storageState que guardamos en
 * Redis). El form modedit se parsea con cheerio.
 *
 * NOTA: Esta es la versión moderna y ligera para procesos en lote. Importa y reusa 
 * la lógica compartida (FIELD_MAPS, extraerFecha) de su gemelo configEvidencias.js.
 *
 * Validado en vivo (junio 2026): GET y POST por fetch de Node pasan el WAF y la
 * sesión los acepta (validado con probe de paridad (jun 2026), ya removido). Chromium queda SOLO para el login.
 *
 * REGLA CLAVE — disabledIf de Moodle:
 *   Moodle aplica por JavaScript el "deshabilitar fecha apagada". En el HTML
 *   crudo esos selects pueden venir SIN `disabled`, así que cheerio los incluiría
 *   con valores stale → Moodle rechaza el guardado en silencio. Por eso, tras
 *   serializar, emulamos ese disabledIf para los grupos de fecha conocidos:
 *   si `X[enabled]` != "1", se eliminan `X[year|month|day|hour|minute]`.
 *   (Mismo efecto que `new FormData(form)` sobre el form ya procesado por el JS.)
 */

const cheerio = require("cheerio");
const { Agent } = require("undici");
const { BASE_URL, log } = require("./auth");
const { FIELD_MAPS, extraerFecha, aplicarFecha } = require("./configEvidencias");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Zajuna no envía la cadena completa de certificados (igual que Playwright usa
// ignoreHTTPSErrors). Dispatcher con verificación relajada SOLO para estos fetch,
// sin tocar el TLS global del proceso (Anthropic API, etc. siguen verificando).
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

// Prefijos de fecha que Moodle deshabilita por JS cuando su [enabled] no está marcado.
const DATE_PREFIXES = ["allowsubmissionsfromdate", "duedate", "cutoffdate", "gradingduedate", "timeopen", "timeclose", "timelimit"];
const DATE_SUFFIXES = ["year", "month", "day", "hour", "minute"];

/** Header Cookie a partir del storageState de Playwright (cookies de zajuna/sena). */
function cookieHeaderFromState(storageState) {
  return (storageState?.cookies || [])
    .filter((c) => /zajuna|sena/i.test(c.domain || ""))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

async function fetchHtml(url, cookieStr, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      Cookie: cookieStr,
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      ...(opts.method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: opts.body,
    redirect: "follow",
    dispatcher: insecureAgent,
  });
  const text = await res.text();
  return { status: res.status, finalUrl: res.url, ok: res.ok, text };
}

function detectarTipoFromHtml($) {
  const cls = $("body").attr("class") || "";
  if (cls.includes("path-mod-forum")) return "forum";
  if (cls.includes("path-mod-quiz")) return "quiz";
  return "assign";
}

/**
 * Serializa el form como lo haría `new FormData(form)`:
 *  - excluye controles `disabled` y sin `name`
 *  - excluye botones (submit/button/reset/image) y file
 *  - checkbox/radio solo si `checked` (el hidden hermano value=0 sí va; el orden
 *    del DOM hace que el checkbox marcado lo sobrescriba)
 *  - select → valor de la option `selected` (o la primera si ninguna)
 *  - textarea → su texto
 */
function serializeForm($, formEl) {
  const data = {};
  $(formEl).find("input, select, textarea").each((_, el) => {
    const $el = $(el);
    if ($el.attr("disabled") !== undefined) return;
    const name = $el.attr("name");
    if (!name) return;
    const tag = el.tagName.toLowerCase();

    if (tag === "input") {
      const type = ($el.attr("type") || "text").toLowerCase();
      if (["submit", "button", "reset", "image", "file"].includes(type)) return;
      if (type === "checkbox" || type === "radio") {
        if ($el.attr("checked") !== undefined) data[name] = $el.attr("value") ?? "on";
        return;
      }
      data[name] = $el.attr("value") ?? "";
    } else if (tag === "textarea") {
      data[name] = $el.text() ?? "";
    } else if (tag === "select") {
      let opt = $el.find("option[selected]").first();
      if (opt.length === 0) opt = $el.find("option").first();
      if (opt.length) data[name] = opt.attr("value") ?? opt.text().trim();
    }
  });
  return data;
}

/** Emula el disabledIf de Moodle para grupos de fecha (ver REGLA CLAVE arriba). */
function aplicarDisabledIfFechas(data) {
  for (const p of DATE_PREFIXES) {
    if (data[`${p}[enabled]`] !== undefined && data[`${p}[enabled]`] !== "1") {
      for (const s of DATE_SUFFIXES) delete data[`${p}[${s}]`];
    }
  }
  return data;
}

/** GET del form modedit por fetch + parseo cheerio. */
async function obtenerFormFetch(cookieStr, actId) {
  const url = `${BASE_URL}/course/modedit.php?update=${actId}&return=1`;
  const r = await fetchHtml(url, cookieStr);
  if (/\/login|loginindex/i.test(r.finalUrl)) {
    throw new Error("La sesion fue expulsada/expirada al leer el formulario (fetch).");
  }
  const $ = cheerio.load(r.text);
  const formEl =
    $("#modeditform").get(0) ||
    $("form[method='post'][action*='modedit']").get(0) ||
    $("form.mform").get(0);
  if (!formEl) throw new Error("Formulario modedit no encontrado (fetch).");
  // El action del HTML crudo puede ser relativo ("modedit.php"); el fetch de Node
  // NO resuelve relativos (a diferencia del navegador). Lo absolutizamos contra
  // la URL de la página del form.
  const action = new URL($(formEl).attr("action") || url, url).toString();
  const tipo = detectarTipoFromHtml($);
  const data = aplicarDisabledIfFechas(serializeForm($, formEl));
  return { data, action, tipo };
}

/** Lee la config (fechas/intentos) por fetch. Misma forma que leerConfigEvidencia. */
async function leerConfigEvidenciaFetch(cookieStr, actId) {
  const { data: d, tipo } = await obtenerFormFetch(cookieStr, actId);
  const map = FIELD_MAPS[tipo] || FIELD_MAPS.assign;

  const apertura = map.abrir ? extraerFecha(d, map.abrir) : { fecha: null, hora: null };
  const entrega = map.entrega ? extraerFecha(d, map.entrega) : { fecha: null, hora: null };
  const limite = map.limite ? extraerFecha(d, map.limite) : { fecha: null, hora: null };

  let intentos = null;
  if (map.intentos && map.intentos.name) {
    const raw = d[map.intentos.name];
    if (raw !== undefined && raw !== null) {
      intentos = raw === map.intentos.unlimitedValue ? "Ilimitado" : parseInt(raw, 10);
    }
  }

  const raw = {
    duedate: d["duedate[year]"] ? `${d["duedate[year]"]}-${d["duedate[month]"]}-${d["duedate[day]"]}` : null,
    allowsubmissionsfromdate: d["allowsubmissionsfromdate[year]"] ? `${d["allowsubmissionsfromdate[year]"]}-${d["allowsubmissionsfromdate[month]"]}-${d["allowsubmissionsfromdate[day]"]}` : null,
    cutoffdate: d["cutoffdate[year]"] ? `${d["cutoffdate[year]"]}-${d["cutoffdate[month]"]}-${d["cutoffdate[day]"]}` : null,
    maxattempts: d["maxattempts"] ?? null,
  };

  return {
    tipo,
    abrirFecha: apertura.fecha, abrirHora: apertura.hora,
    entregaFecha: entrega.fecha, entregaHora: entrega.hora,
    limiteFecha: limite.fecha, limiteHora: limite.hora,
    intentos, raw,
  };
}

/** Guarda config por fetch (GET form → merge → POST → re-GET verificación). */
async function guardarConfigEvidenciaFetch(cookieStr, actId, config) {
  const { data: form0, action, tipo } = await obtenerFormFetch(cookieStr, actId);
  const map = FIELD_MAPS[tipo] || FIELD_MAPS.assign;
  const d = { ...form0 };
  const prefijosCambiados = [];

  if (config.abrirFecha !== undefined && map.abrir) {
    aplicarFecha(d, map.abrir, config.abrirFecha, config.abrirHora || "00:00");
    if (config.abrirFecha) prefijosCambiados.push(map.abrir);
  }
  if (config.entregaFecha !== undefined && map.entrega) {
    aplicarFecha(d, map.entrega, config.entregaFecha, config.entregaHora || "23:55");
    if (config.entregaFecha) prefijosCambiados.push(map.entrega);
  }
  if (config.limiteFecha !== undefined && map.limite) {
    aplicarFecha(d, map.limite, config.limiteFecha, config.limiteHora || "23:55");
    if (config.limiteFecha) prefijosCambiados.push(map.limite);
  }
  if (config.intentos !== undefined && config.intentos !== null && map.intentos) {
    d[map.intentos.name] =
      config.intentos === "Ilimitado" || config.intentos === -1
        ? map.intentos.unlimitedValue
        : String(config.intentos);
  }

  const esperado = {};
  for (const p of prefijosCambiados) {
    esperado[p] = { year: d[`${p}[year]`], month: d[`${p}[month]`], day: d[`${p}[day]`], hour: d[`${p}[hour]`], minute: d[`${p}[minute]`] };
  }

  const body = new URLSearchParams(d);
  body.set("submitbutton", "Guardar cambios y mostrar");
  const post = await fetchHtml(action, cookieStr, { method: "POST", body: body.toString() });

  if (/\/login|loginindex/i.test(post.finalUrl || "")) {
    throw new Error("La sesion fue expulsada durante el guardado (fetch). Reintentar.");
  }
  if (!post.ok) throw new Error(`POST fallido: HTTP ${post.status}`);
  // Señal de éxito robusta: al guardar, Moodle REDIRIGE fuera de modedit (a
  // mod/.../view.php). Si la URL final sigue en modedit.php, re-renderizó el form
  // = la validación falló. (NO usar regex de "id_error_": Moodle emite esos
  // placeholders OCULTOS para cada campo siempre → falso positivo.)
  if (/modedit\.php/i.test(post.finalUrl || "")) {
    const m = post.text.match(/alert-danger[^>]*>\s*([^<]{3,300})/i);
    throw new Error(`Error al guardar: ${m ? m[1].trim() : "Moodle re-renderizó el formulario (validación rechazada)"}`);
  }

  // Verificación: releer y comparar lo que pedimos cambiar.
  if (prefijosCambiados.length > 0) {
    const { data: d2 } = await obtenerFormFetch(cookieStr, actId);
    const norm = (v) => String(parseInt(v, 10));
    for (const p of prefijosCambiados) {
      const e = esperado[p];
      const ok =
        d2[`${p}[enabled]`] === "1" &&
        d2[`${p}[year]`] === e.year &&
        norm(d2[`${p}[month]`]) === norm(e.month) &&
        norm(d2[`${p}[day]`]) === norm(e.day) &&
        norm(d2[`${p}[hour]`]) === norm(e.hour) &&
        norm(d2[`${p}[minute]`]) === norm(e.minute);
      if (!ok) {
        const got = `${d2[`${p}[year]`]}-${d2[`${p}[month]`]}-${d2[`${p}[day]`]} ${d2[`${p}[hour]`]}:${d2[`${p}[minute]`]} (enabled=${d2[`${p}[enabled]`]})`;
        throw new Error(`Moodle no guardó ${p}: quedó ${got}`);
      }
    }
    log(`[config-fetch] Verificación OK: ${prefijosCambiados.join(", ")} ✓`);
  }

  return { ok: true };
}

module.exports = {
  cookieHeaderFromState,
  obtenerFormFetch,
  serializeForm,
  aplicarDisabledIfFechas,
  leerConfigEvidenciaFetch,
  guardarConfigEvidenciaFetch,
};
