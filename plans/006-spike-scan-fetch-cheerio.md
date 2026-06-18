# Plan 006 (SPIKE): Validar y prototipar la migración de la lectura del scan a Node fetch + cheerio

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 762970a..HEAD -- api/src/workers/evidenciasWorker.js scraper/evidencias.js scraper/configEvidenciasFetch.js api/src/lib/sessionStore.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: L (el spike en sí: M — 1 día; la migración completa que especificará: L)
- **Risk**: MED (solo lecturas; el fallback a Playwright queda intacto)
- **Depends on**: plans/003-playwright-session-factory.md (recomendado: toca los mismos workers; ejecutar 003 primero evita conflictos)
- **Category**: perf / direction
- **Planned at**: commit `762970a`, 2026-06-10

## Why this matters

Es el **P1 #7 documentado** en CLAUDE.md §11.2/§11.6: el ahorro real de RAM (−90% en la ruta de lectura) y la llave del escalado no es más hardware, es sacar las LECTURAS de Chromium. El patrón ya está probado en producción para la config de evidencias (`scraper/configEvidenciasFetch.js`: fetch de Node + cookies del storageState + cheerio, validado contra el WAF de Zajuna en junio 2026). Falta aplicarlo al camino más caliente: el scan de evidencias (`evidenciasWorker`), que hoy abre un context de Chromium para TODO el job aunque la mayor parte sea leer HTML/JSON.

**Esto es un spike, no la migración**: el objetivo es responder 4 preguntas con evidencia y dejar escrito el plan de migración definitivo. NO se modifica ningún worker en este plan.

## Current state

- **El job de scan hoy** — `api/src/workers/evidenciasWorker.js`: login/sesión Playwright (líneas 33-61), luego con `page`:
  1. `obtenerEvidencias(page, courseId)` — Gradebook Tree (DOM).
  2. `cargarGrader(page, ...)` — grade report `perpage=5000` (DOM pesado): matriculados + notas por itemid.
  3. `descargarGradebookCSV(page, ...)` — export CSV.
  4. CAPA 2: `obtenerSesskey(page)` + `resolverAssignInfo` + `listarParticipantesBatch` — AJAX `mod_assign_list_participants`, pero ejecutado con `page.evaluate(fetch)` → **dentro de Chromium**.
  5. Foros/quiz: `revisarEntregasForo`/`revisarEntregasQuiz` (DOM serial).
- **El patrón objetivo ya existente** — `scraper/configEvidenciasFetch.js:40-63`:
  ```js
  function cookieHeaderFromState(storageState) {
    return (storageState?.cookies || [])
      .filter((c) => /zajuna|sena/i.test(c.domain || ""))
      .map((c) => `${c.name}=${c.value}`).join("; ");
  }
  async function fetchHtml(url, cookieStr, opts = {}) {
    const res = await fetch(url, { headers: { Cookie: cookieStr, "User-Agent": UA, ... },
      redirect: "follow", dispatcher: insecureAgent });  // undici Agent rejectUnauthorized:false (cert chain rota de Zajuna)
    ...
  }
  ```
  Docstring del archivo (líneas 12-13): "GET y POST por fetch de Node pasan el WAF y la sesión los acepta. Chromium queda SOLO para el login."
- **Sesión**: `api/src/lib/sessionStore.js` — `loadSession(userId)` devuelve el `storageState` (cookies) desde Redis, cifrado, TTL 2h. El login que lo acuña sigue siendo Playwright (SSO de SENA con JS — no migrable, CLAUDE.md §11.2).
- **Toolbox AJAX confirmado contra SENA** (CLAUDE.md §7 Capa 2): `mod_assign_list_participants` ✅ habilitada con sesskey; `sesskey` se extrae con regex del HTML (como hace `resolverAssignInfo` en `scraper/evidencias.js`).
- **Riesgo documentado** (CLAUDE.md §11.2): WAF/fingerprint TLS podría tratar distinto al fetch de Node — *ya desmentido para modedit/POST* por el probe de paridad de junio, pero NO está probado para: Gradebook Tree, grade report `perpage=5000` (página MUY pesada), export CSV, y el AJAX batch.
- Scripts probe previos como referencia de estilo: `scripts/probe-ajax-participants.js`, `scripts/probe-capa2-flow.js` (read-only, no escriben DB).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Sintaxis | `node --check scripts/probe-scan-fetch.js` | exit 0 |
| Probe (requiere sesión viva en Redis + .env) | `node scripts/probe-scan-fetch.js <courseId>` | reporte por endpoint (ver Step 2) |
| Infra | `docker-compose up -d` | Postgres+Redis arriba |

## Scope

**In scope**:
- `scripts/probe-scan-fetch.js` (crear — probe read-only)
- `plans/007-migracion-scan-fetch.md` (crear — el plan de migración definitivo, OUTPUT de este spike)
- `plans/README.md` (registrar resultados y el plan 007)

**Out of scope** (NO tocar en el spike):
- `api/src/workers/evidenciasWorker.js`, `scraper/evidencias.js` — la migración es el plan 007, no este.
- Cualquier escritura a Moodle o a la DB de la app (el probe es 100% lectura; puede leer `Evidencia.assignId` cacheados vía Prisma, sin writes).
- El login (`scraper/auth.js`) — Chromium para el login se queda.

## Git workflow

- Branch: `advisor/006-spike-scan-fetch` (desde `master`).
- Commit estilo repo: `test(probe): paridad fetch-vs-chromium para la ruta de lectura del scan`.
- NO push ni PR salvo instrucción del operador.

## Steps

### Step 1: Escribir el probe `scripts/probe-scan-fetch.js`

Read-only, modelado en `scripts/probe-capa2-flow.js` y reutilizando `cookieHeaderFromState`/`fetchHtml` importados de `scraper/configEvidenciasFetch.js` (NO copiarlos). Flujo:

1. Tomar `userId` (argv o el primer User de la DB) y `courseId` (argv).
2. `loadSession(userId)` → si no hay sesión en Redis, instruir en el output: "dispara cualquier scan desde el Dashboard para acuñar sesión y reintenta" y salir con código 2.
3. Contra Zajuna, por fetch de Node, medir **una por una** (try/catch por endpoint, tiempo + bytes + veredicto):
   - a. `GET /grade/report/grader/index.php?id={courseId}&perpage=5000` → ¿HTTP 200 con la tabla de notas? (buscar `gradereport` o `user-grades` en el HTML). ¿Cuánto pesa/tarda vs Chromium?
   - b. El **Gradebook Tree** — la URL que usa `obtenerEvidencias` (leerla de `scraper/evidencias.js`; típicamente `/grade/edit/tree/index.php?id={courseId}`) → ¿HTML con los gradeitems?
   - c. El **export CSV** del gradebook — la URL/POST que usa `descargarGradebookCSV` (leerla de `scraper/evidencias.js`) → ¿devuelve CSV?
   - d. `sesskey` por regex sobre cualquiera de los HTML anteriores → ¿se extrae?
   - e. `POST /lib/ajax/service.php?sesskey=...&info=mod_assign_list_participants` con 1-3 assignIds tomados de `Evidencia.assignId` de la DB (solo lectura) → ¿JSON válido con participantes?
4. Reporte final: tabla `endpoint | HTTP | ms | bytes | veredicto (OK / BLOQUEADO / DIFIERE)`, y comparación de RSS: el probe corre sin Chromium — reportar `process.memoryUsage().rss`.
5. Cabecera docstring en español: qué hace, qué NO hace (no escribe nada), cómo correrlo.

**Verify**: `node --check scripts/probe-scan-fetch.js` → exit 0.

### Step 2: Correr el probe contra Zajuna real

Requiere: `.env` completo, Redis con sesión viva (el operador dispara un scan primero si hace falta), y un `courseId` real (los conocidos del repo: 51083 tecnólogo ADSI, 77767 técnico — confirmar con el operador cuál usar).

**Verify**: el probe imprime la tabla con los 5 endpoints. Criterio de éxito del spike: a, d, e en OK (son el 80% del valor — notas, sesskey y estados assign sin Chromium). b y c pueden fallar sin matar el spike (se anota y la migración los deja en Playwright).

### Step 3: Escribir `plans/007-migracion-scan-fetch.md` con los resultados

Usando la plantilla de los demás planes de `plans/`, especificar la migración REAL de `evidenciasWorker` según lo que dio el probe:
- Qué endpoints migran a fetch (los OK) y cuáles quedan en Playwright (los BLOQUEADOS + el login).
- La arquitectura objetivo: el worker abre Chromium SOLO si no hay sesión válida en Redis (acuñar sesión) o para los pasos no migrables; la rama assign completa (sesskey + batch participants) y el grader report van por `fetchHtml` + cheerio.
- El fallback: si un fetch falla con redirect a login → invalidar sesión → re-acuñar con Playwright → reintentar UNA vez (mismo espíritu que el fallback DOM de la Capa 2 actual).
- Done criteria medibles: scan recurrente de una ficha conocida da los MISMOS contadores (evidencias/entregas/notas) que la versión actual (correr ambas y diffear), y el RSS del proceso workers durante un scan baja ≥50%.
- STOP conditions específicos heredados del probe.

**Verify**: el plan 007 existe, pasa el checklist de calidad de `.claude/skills/improve/references/plan-template.md` (autocontenido, gates por paso), y `plans/README.md` lo lista.

## Test plan

El probe ES el test del spike. Sin tests unitarios nuevos. El plan 007 especificará el test de paridad de la migración (diff de contadores de scan).

## Done criteria

- [ ] `scripts/probe-scan-fetch.js` existe, `node --check` exit 0, y es 100% read-only (revisión: cero `prisma.*.create/update/delete`, cero POSTs salvo el AJAX de lectura del paso e).
- [ ] Probe ejecutado contra Zajuna real; tabla de resultados pegada en `plans/007-migracion-scan-fetch.md` (sección Current state) y resumida en `plans/README.md`.
- [ ] Veredicto explícito: GO (a+d+e OK) o NO-GO (con qué endpoint falló y cómo).
- [ ] `plans/007-migracion-scan-fetch.md` escrito (si GO) o el NO-GO documentado en `plans/README.md` (si NO-GO).
- [ ] Ningún archivo de `api/` ni `scraper/` modificado (`git status`).

## STOP conditions

Stop and report back (do not improvise) if:

- No hay sesión en Redis y no hay operador disponible para acuñarla — el spike no puede correr sin sesión real; NO intentes loguearte programáticamente fuera del flujo existente.
- El WAF devuelve 403/challenge a los fetch (el fingerprint TLS de Node fue rechazado donde el de la config pasaba) — esto invierte el supuesto central; reportar con los headers de respuesta.
- El grader `perpage=5000` por fetch devuelve un HTML distinto al de Chromium (p.ej. paginado o sin notas) — anotar DIFIERE y seguir con los demás endpoints; el veredicto lo decide el conjunto.
- Te ves tentado a "ya que estoy" migrar el worker — NO: ese es el plan 007.

## Maintenance notes

- La sesión de Redis tiene TTL 2h — la migración real (007) debe manejar la expiración a mitad de scan (el fallback de re-acuñar).
- Si SENA arregla su cadena TLS algún día, quitar el `insecureAgent` de `configEvidenciasFetch.js` beneficia a todo lo migrado de una vez.
- Interacción con plan 003: la factory de sesión es quien decidirá "¿necesito Chromium o me basta la cookie?" — al ejecutar 007, extender la factory con un modo `soloCookies`.
