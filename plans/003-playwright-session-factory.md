# Plan 003: Extraer el boilerplate de sesión Playwright de los 11 workers a una factory única

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 762970a..HEAD -- api/src/workers/ api/src/lib/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/002-verification-baseline.md (para que el CI atrape regresiones de sintaxis)
- **Category**: tech-debt
- **Planned at**: commit `762970a`, 2026-06-10

## Why this matters

11 workers BullMQ repiten el mismo bloque de ~25 líneas: cargar sesión de Redis → `acquireContext` → probar si la sesión sigue viva → login fresco si no → guardar sesión. Cuando SENA cambie algo del login (pasa — el portal SSO es de ellos), hay que editar 11 archivos, y ya hay **divergencias accidentales**: el chequeo de sesión válida es distinto entre workers (`page.url().includes("zajuna.sena.edu.co")` vs `page.url().includes("/zajuna/")`), los timeouts difieren (30s/45s/`TIMEOUT`), y solo algunos convierten "Credenciales incorrectas" en `UnrecoverableError`. Este es el P1 #6 documentado en CLAUDE.md §11.3. Tras este plan, la lógica vive en `api/src/lib/playwrightSession.js` y los 11 workers la importan.

## Current state

- **Workers con el boilerplate (11)** — confirmado por grep de `acquireContext|loadSession|loginZajuna`:
  `cambiarConfigWorker.js`, `cambiarFechaWorker.js`, `configWorker.js`, `fichasWorker.js`, `evidenciasWorker.js`, `foroDescubrirWorker.js`, `foroRatingWorker.js`, `leerConfigEvidenciaWorker.js`, `leerConfigLoteWorker.js`, `mensajeFormativoWorker.js`, `syncParticipantesWorker.js` (todos en `api/src/workers/`).
  `matchingIaWorker.js`, `emailMasivoWorker.js`, `autoScanWorker.js`, `mensajesProgramadosWorker.js` NO abren browser — no tocarlos.
- **Variante A** — `api/src/workers/evidenciasWorker.js:33-61` (inline, con `UnrecoverableError` para credenciales malas):
  ```js
  const savedSession = await loadSession(userId);
  const ctx = await acquireContext({
    locale: "es-CO",
    timezoneId: "America/Bogota",
    ...(savedSession ? { storageState: savedSession } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);
  // ...
  sessionValida = page.url().includes("/zajuna/") && !page.url().includes("/login");
  // ...
  if (err.message === "Credenciales incorrectas.") throw new UnrecoverableError(err.message);
  ```
- **Variante B** — `api/src/workers/mensajeFormativoWorker.js:82-105` (función local `getPaginaAutenticada()`, chequeo distinto, SIN UnrecoverableError):
  ```js
  sessionValida = !page.url().includes("/login") && page.url().includes("zajuna.sena.edu.co");
  ```
  Este worker además RE-crea la sesión a mitad del job cuando Moodle lo expulsa (líneas 159-167) — la factory debe poder llamarse más de una vez por job.
- **Infra ya existente que la factory debe usar (no reescribir)**:
  - `api/src/lib/browserPool.js` — `acquireContext(opts)` / `releaseContext(ctx)` (browser compartido, semáforo, bloqueo de recursos).
  - `api/src/lib/sessionStore.js` — `saveSession(userId, storageState)` / `loadSession(userId)` (Redis cifrado, TTL 2h).
  - `scraper/auth.js` — `login(page, user, pass)`, `cerrarModal(page)`, `BASE_URL`, `TIMEOUT`, `log`.
- **Gotcha crítico del repo** (CLAUDE.md §3): 2+ browsers del mismo usuario simultáneos hacen que Moodle invalide la sesión. La factory NO cambia eso — la concurrencia la controlan las colas, no este plan.
- `api/src/lib/playwrightSession.js` **no existe** todavía (CLAUDE.md lo confirma — P1 #6 pendiente).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Sintaxis | `node --check api/src/workers/<archivo>.js` (cada tocado) | exit 0 |
| Tests | `npm test` | todos pasan |
| Carga de módulos | `node -e "require('./api/src/worker-entry.js')"` — NO: arranca workers reales. Usar en su lugar: `node --check api/src/worker-entry.js` y el smoke del Step 4 | exit 0 |

## Scope

**In scope**:
- `api/src/lib/playwrightSession.js` (crear)
- Los 11 workers listados arriba (solo reemplazar el bloque de login/sesión por la factory)
- `api/src/lib/playwrightSession.test.js` (crear — tests puros de la lógica de decisión, sin browser)

**Out of scope** (NO tocar):
- `api/src/lib/browserPool.js`, `api/src/lib/sessionStore.js`, `scraper/auth.js` — la factory los compone, no los modifica.
- `matchingIaWorker.js`, `emailMasivoWorker.js`, `autoScanWorker.js`, `mensajesProgramadosWorker.js` — no usan browser.
- La lógica de negocio de cada worker después del login (scan, mensajes, etc.).
- Las opciones de concurrencia de las colas (`api/src/lib/queue.js`).

## Git workflow

- Branch: `advisor/003-playwright-session-factory` (desde `master`).
- Un commit para la factory + un commit por grupo de workers migrados (p.ej. `refactor(workers): migrar config/leerConfig a playwrightSession`). Estilo del repo: prefijo `refactor:`.
- NO push ni PR salvo instrucción del operador.

## Steps

### Step 1: Crear la factory `api/src/lib/playwrightSession.js`

Cabecera docstring en español (CLAUDE.md §5.1). API propuesta:

```js
/**
 * crearSesionAutenticada({ userId, zajunaUserEnc, zajunaPassEnc, opts })
 *   → { ctx, page, relogin }
 *
 * Encapsula el ciclo: loadSession → acquireContext → validar sesión →
 * login fresco si expiró → saveSession. `relogin()` repite el ciclo
 * descartando la sesión guardada (para reconexión a mitad de job).
 *
 * opts: {
 *   timeout = TIMEOUT,             // page.setDefaultTimeout
 *   credencialesMalasEsFatal = true // "Credenciales incorrectas." → UnrecoverableError
 * }
 *
 * El caller SIEMPRE debe hacer releaseContext(ctx) en su finally (igual que hoy).
 */
```

Detalles de implementación:
- Desencriptar credenciales ADENTRO de la factory (`decrypt` de `../lib/crypto`) — los workers dejan de manejar texto plano.
- Chequeo de sesión válida: **unificar al más estricto** (el de evidenciasWorker): navegar a `${BASE_URL}/my/`, `cerrarModal`, y `page.url().includes("/zajuna/") && !page.url().includes("/login")`. Razón: la sesión expirada redirige a la raíz `https://zajuna.sena.edu.co/` que SÍ contiene `zajuna.sena.edu.co` — el chequeo de la Variante B da falsos válidos.
- `UnrecoverableError` (de `bullmq`) cuando `err.message === "Credenciales incorrectas."` y `credencialesMalasEsFatal` (default true — hoy solo evidenciasWorker lo hace, pero es correcto para todos: reintentar con la misma credencial mala no sirve).
- Extraer también la función pura `esSesionValidaUrl(url)` (string → boolean) y exportarla para test.

**Verify**: `node --check api/src/lib/playwrightSession.js` → exit 0.

### Step 2: Test de la lógica pura

`api/src/lib/playwrightSession.test.js` (patrón: `api/src/lib/calificacion.test.js`, `node:test`):
- `esSesionValidaUrl("https://zajuna.sena.edu.co/zajuna/my/")` → true
- `esSesionValidaUrl("https://zajuna.sena.edu.co/")` → false (raíz = login, el falso-válido de la Variante B)
- `esSesionValidaUrl("https://zajuna.sena.edu.co/zajuna/login/index.php")` → false

**Verify**: `npm test` → verde, incluye los 3 nuevos.

### Step 3: Migrar los 11 workers, en 3 tandas

Por cada worker: borrar el bloque inline (o la función local `getPaginaAutenticada`), importar `crearSesionAutenticada`, y conservar EXACTAMENTE el resto (progreso de Job, try/finally con `releaseContext`, lógica de negocio).

- Tanda 1 (bajo riesgo, jobs cortos): `leerConfigEvidenciaWorker`, `leerConfigLoteWorker`, `configWorker`, `cambiarConfigWorker`, `cambiarFechaWorker`.
- Tanda 2: `fichasWorker`, `foroDescubrirWorker`, `syncParticipantesWorker`, `foroRatingWorker`.
- Tanda 3 (los que tienen lógica extra): `evidenciasWorker` (conserva su manejo de UnrecoverableError vía opts default), `mensajeFormativoWorker` (su reconexión a mitad de job pasa a usar `relogin()`).

Cuidados:
- `mensajeFormativoWorker` hace `saveSession(userId, null)` antes de reconectar — `relogin()` debe ignorar la sesión guardada (no hace falta escribir null).
- Algunos workers pasan `locale: "es-CO", timezoneId: "America/Bogota"` — la factory los pone por defecto.
- NO cambiar los timeouts efectivos de cada worker: si uno usaba 45s, pasarle `opts.timeout: 45_000`.

**Verify** (después de cada tanda): `node --check` sobre cada worker tocado → exit 0; `npm test` → verde; `git grep -l "loadSession" api/src/workers/` → solo los workers de las tandas pendientes.

### Step 4: Smoke en vivo (requiere operador)

Con Postgres+Redis arriba y credenciales reales en DB, pedir al operador disparar UN scan de evidencias desde el Dashboard (o `node api/src/worker-entry.js` + encolar). Observar el log del worker: `Sesión expirada, login fresco` o reuso de sesión, y el scan completa.

Si no hay forma de probar en vivo en este entorno: marcar el plan como DONE-PENDING-LIVE en el README y reportarlo — NO inventar una validación.

**Verify**: un job real de la cola `evidencias` y uno de `mensajes` terminan OK con la factory (estado `completed` en BullMQ / Job.status en DB).

## Test plan

- `api/src/lib/playwrightSession.test.js`: los 3 casos de `esSesionValidaUrl` (Step 2). La parte con browser/Redis no se testea unitariamente (sin infra de mocks en el repo) — se cubre con el smoke del Step 4.
- Patrón estructural: `api/src/lib/calificacion.test.js`.
- `npm test` → todo verde.

## Done criteria

- [ ] `api/src/lib/playwrightSession.js` existe con docstring y `esSesionValidaUrl` exportada.
- [ ] `git grep -l "loginZajuna\|loadSession" api/src/workers/` → 0 archivos (todo pasa por la factory). *(Nota: `loadSession` puede seguir apareciendo en `lib/`.)*
- [ ] Los 11 workers usan `crearSesionAutenticada`; `node --check` exit 0 en todos.
- [ ] `npm test` exit 0 (suite previa + 3 nuevos).
- [ ] Smoke en vivo OK, o estado DONE-PENDING-LIVE registrado en `plans/README.md` con el motivo.
- [ ] Ningún archivo fuera del scope modificado (`git status`).

## STOP conditions

Stop and report back (do not improvise) if:

- Algún worker tiene lógica de sesión que NO encaja en la factory (más allá de timeout/relogin) — no forzar un parámetro nuevo sin reportarlo.
- El bloque inline de un worker difiere sustancialmente de las Variantes A/B citadas (drift desde 762970a).
- En el smoke en vivo, el login falla o Moodle invalida la sesión repetidamente — puede ser el gotcha de doble browser (CLAUDE.md §3); reportar, no "arreglar" tocando browserPool.
- Te ves obligado a modificar `browserPool.js`, `sessionStore.js` o `scraper/auth.js`.

## Maintenance notes

- A partir de aquí, cualquier cambio del login SSO de SENA se arregla en UN archivo (`playwrightSession.js` + `scraper/auth.js`).
- Reviewer: verificar que ningún worker perdió su `finally { releaseContext(ctx) }` — fuga de contexts = se agota el semáforo del pool (BROWSER_MAX_CONTEXTS=10) y los jobs quedan encolados para siempre.
- Diferido a propósito: unificar también el patrón de reconexión a mitad de job (hoy solo mensajeFormativoWorker lo tiene); si otro worker empieza a sufrir expulsiones de sesión, copiar el patrón `relogin()`.
- Interacción con plan 006 (migración a fetch): cuando las lecturas salgan de Chromium, varios de estos workers dejarán de necesitar la factory — no es razón para no hacer esto ahora (006 es L y toca solo evidencias).
