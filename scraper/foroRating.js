/**
 * scraper/foroRating.js — Sprint 2.5 FIX 4
 *
 * Califica posts de un foro Moodle usando el form `form.postratingform`
 * que apunta a /rating/rate.php. Misma técnica que configEvidencias.js:
 *
 *   1. Ir a /mod/forum/view.php?id={actId} (foros blog/single muestran posts aquí)
 *   2. Para foros generales, iterar /mod/forum/discuss.php?d={d} de cada thread
 *   3. Encontrar `form.postratingform` con `input[name=rateduserid]` = moodleUserId
 *   4. Serializar todos los hidden fields del form (contextid, sesskey, itemid, scaleid, etc.)
 *   5. Sobreescribir `rating` con la nota recibida
 *   6. POST a /rating/rate.php con application/x-www-form-urlencoded
 */

const { BASE_URL, TIMEOUT, log, cerrarModal } = require("./auth");

/**
 * Devuelve la lista de form.postratingform de la página actual, serializados.
 * Cada item incluye TODOS los hidden inputs + valor actual del select de rating.
 *
 * @returns {Promise<Array<{
 *   action: string,
 *   rateduserid: string,
 *   itemid: string|null,
 *   fields: Record<string,string>,
 *   ratingOptions: string[],
 * }>>}
 */
async function recolectarFormsRating(page) {
  return await page.evaluate(() => {
    const out = [];
    const forms = Array.from(document.querySelectorAll('form.postratingform, form[id^="postrating"]'));
    for (const form of forms) {
      const fields = {};
      for (const el of form.elements) {
        if (!el.name) continue;
        if (el.type === "submit" || el.type === "button" || el.type === "image") continue;
        if (el.type === "checkbox" || el.type === "radio") {
          if (el.checked) fields[el.name] = el.value;
        } else {
          fields[el.name] = el.value;
        }
      }
      const rateduserid = fields["rateduserid"] || null;
      const itemid      = fields["itemid"]      || null;
      if (!rateduserid) continue;

      // Opciones disponibles del select (sin contar el placeholder "-999")
      const sel = form.querySelector('select[name="rating"]');
      const ratingOptions = sel
        ? Array.from(sel.options).map((o) => o.value).filter((v) => v && v !== "-999")
        : [];

      out.push({
        action: form.action,
        rateduserid: String(rateduserid),
        itemid: itemid ? String(itemid) : null,
        fields,
        ratingOptions,
      });
    }
    return out;
  });
}

/**
 * Califica posts del foro `actId`. Cada item de `ratings` es { moodleUserId, nota }.
 * Si una nota no aparece como opción válida en el select del form se rechaza esa
 * fila (continúa con las demás).
 *
 * @param {import('playwright').Page} page
 * @param {string|number} actId
 * @param {Array<{ moodleUserId: string, nota: number|string }>} ratings
 * @returns {Promise<Array<{ moodleUserId: string, ok: boolean, error?: string, nota?: string, status?: number }>>}
 */
async function calificarPostsForo(page, actId, ratings) {
  const viewUrl = `${BASE_URL}/mod/forum/view.php?id=${actId}`;
  log(`[foroRating] View: ${viewUrl}`);
  await page.goto(viewUrl, { waitUntil: "load", timeout: TIMEOUT });
  await cerrarModal(page);

  // Mapa moodleUserId → form serializado
  const formsByUser = new Map();
  for (const f of await recolectarFormsRating(page)) {
    formsByUser.set(f.rateduserid, f);
  }
  log(`[foroRating] Forms en view.php: ${formsByUser.size}`);

  // Si faltan rateduserids (foros tipo general), iterar discussions
  const faltantes = ratings
    .map((r) => String(r.moodleUserId))
    .filter((id) => !formsByUser.has(id));

  if (faltantes.length > 0) {
    const discussIds = await page.evaluate(() => {
      const ids = new Set();
      document.querySelectorAll('a[href*="/mod/forum/discuss.php?d="]').forEach((a) => {
        const m = a.href.match(/[?&]d=(\d+)/);
        if (m) ids.add(m[1]);
      });
      return Array.from(ids);
    });
    log(`[foroRating] Faltan ${faltantes.length} users; recorriendo ${discussIds.length} discussions...`);

    for (const d of discussIds) {
      await page.goto(`${BASE_URL}/mod/forum/discuss.php?d=${d}`, { waitUntil: "load", timeout: TIMEOUT });
      await cerrarModal(page);
      for (const f of await recolectarFormsRating(page)) {
        if (!formsByUser.has(f.rateduserid)) formsByUser.set(f.rateduserid, f);
      }
      // Salir temprano si ya tenemos todos
      if (faltantes.every((id) => formsByUser.has(id))) break;
    }
    log(`[foroRating] Tras barrer discussions: ${formsByUser.size} forms`);
  }

  // POST por cada rating solicitado
  const results = [];
  for (const r of ratings) {
    const userId = String(r.moodleUserId);
    const form = formsByUser.get(userId);
    if (!form) {
      results.push({ moodleUserId: userId, ok: false, error: "Sin form de rating (no publicó)" });
      continue;
    }

    const notaStr = String(r.nota);
    if (form.ratingOptions.length > 0 && !form.ratingOptions.includes(notaStr)) {
      results.push({
        moodleUserId: userId, ok: false,
        error: `Nota ${notaStr} no permitida. Valores: ${form.ratingOptions.join(",")}`,
      });
      continue;
    }

    // Construir el body con todos los hidden + rating override
    const body = { ...form.fields, rating: notaStr };

    const post = await page.evaluate(async ({ action, fields }) => {
      const body = new URLSearchParams(fields);
      const res  = await fetch(action, {
        method:      "POST",
        headers:     { "Content-Type": "application/x-www-form-urlencoded" },
        body:        body.toString(),
        credentials: "include",
        redirect:    "follow",
      });
      const text = await res.text();
      return {
        ok: res.ok, status: res.status, finalUrl: res.url,
        snippet: text.substring(0, 800),
      };
    }, { action: form.action, fields: body });

    if (!post.ok) {
      results.push({ moodleUserId: userId, ok: false, status: post.status, error: `HTTP ${post.status}` });
      continue;
    }

    // Detectar mensajes de error embebidos en la respuesta de Moodle
    const errorPatterns = ["alert-danger", "errorbox", "form-errors"];
    const hayError = errorPatterns.some((p) => post.snippet.includes(p));
    if (hayError) {
      const m = post.snippet.match(/class="[^"]*error[^"]*"[^>]*>([^<]{1,200})</i);
      results.push({
        moodleUserId: userId, ok: false, status: post.status,
        error: m ? m[1].trim() : "Error embebido en respuesta",
      });
      continue;
    }

    log(`[foroRating] OK user=${userId} nota=${notaStr}`);
    results.push({ moodleUserId: userId, ok: true, nota: notaStr, status: post.status });
  }

  const okCount = results.filter((r) => r.ok).length;
  log(`[foroRating] Total: ${okCount}/${results.length} OK`);
  return results;
}

module.exports = { calificarPostsForo, recolectarFormsRating };
