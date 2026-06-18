# Plan 004: Evitar el doble envío de mensajes cuando BullMQ reintenta un job a mitad de loop

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 762970a..HEAD -- api/src/workers/mensajeFormativoWorker.js api/src/workers/emailMasivoWorker.js api/src/lib/queue.js prisma/schema.prisma`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none (si el plan 003 ya se ejecutó, el bloque de login del worker será distinto al excerpt — eso NO es drift bloqueante para ESTE plan, que toca el loop de envío)
- **Category**: bug
- **Planned at**: commit `762970a`, 2026-06-10

## Why this matters

La cola `mensajes` tiene `attempts: 2` (`api/src/lib/queue.js:26`) y el worker envía mensajes de Moodle en un loop por destinatario **sin registrar cuáles ya envió**. Si el proceso de workers muere a mitad del loop (escenario real en este repo: `taskkill /F /IM node.exe` es parte del flujo de desarrollo documentado en CLAUDE.md §3, más OOM/redeploys), BullMQ marca el job como *stalled* y lo reintenta desde cero → **los aprendices que ya recibieron el mensaje lo reciben otra vez**. Con los mensajes programados/recurrentes recién agregados (commit `762970a`), el volumen de envíos automáticos sube y este hueco pasa de teórico a probable. CLAUDE.md §14.6 pide explícitamente: "respetar idempotencia (no doble envío si el worker reintenta)".

## Current state

- `api/src/lib/queue.js:26` — `const mensajesQueue = new Queue("mensajes", { connection, defaultJobOptions: { attempts: 2, removeOnComplete: 50, removeOnFail: 20 } });`
- `api/src/workers/mensajeFormativoWorker.js` — worker de la cola `mensajes`. Loop de envío (líneas 134-184):
  ```js
  let enviados  = 0;
  let fallidos  = 0;
  try {
    for (const dest of destinatarios) {
      if (!dest.moodleId) { ...; fallidos++; continue; }
      try {
        const cuerpoPersonalizado = personalizarCuerpo(cuerpo, dest, fichaCode, instructorNombre);
        const resultado = await enviarMensajeMoodle(page, dest.moodleId, cuerpoPersonalizado);
        if (resultado.ok) { enviados++; } else { ...fallidos++; ... }
      } catch (errDest) { ...fallidos++; ... }
    }
  ```
  Los contadores viven solo en variables locales — un retry arranca con `enviados=0` y reenvía a todos.
  Los errores POR destinatario ya se capturan (no relanzan), así que el vector real de retry es: (a) crash/stall del proceso a mitad de loop, (b) excepción fuera del try interno (p.ej. el `prisma.mensajeFormativo.update` final, o el login inicial — este último es inocuo porque aún no envió nada).
- `prisma/schema.prisma` — modelo `MensajeFormativo` (línea ~331): tiene `destinatarios Json`, `estado`, `errorMsg`, `enviadoAt`. **No tiene** campo de progreso por destinatario.
- BullMQ: `job.updateProgress(value)` persiste en Redis y **sobrevive al retry** (`job.progress` se conserva entre attempts del mismo job). Esta es la pieza clave del fix.
- `api/src/workers/emailMasivoWorker.js` — canal email; su cola tiene `attempts: 1` (`queue.js:28`), así que NO tiene este problema. Revisarlo solo para confirmar (no tocarlo si attempts sigue en 1).
- Convenciones: comentarios en español, docstring de cabecera actualizado si cambia el contrato del worker (CLAUDE.md §5.1).

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Sintaxis | `node --check api/src/workers/mensajeFormativoWorker.js` | exit 0 |
| Tests | `npm test` | todos pasan |

## Scope

**In scope**:
- `api/src/workers/mensajeFormativoWorker.js`
- `api/src/workers/mensajeFormativoWorker.test.js` (crear — tests de la función pura de partición)

**Out of scope** (NO tocar):
- `api/src/lib/queue.js` — NO bajar attempts a 1: el retry es valioso para el caso "login falló a la primera" (no se había enviado nada). El fix correcto es reanudar, no dejar de reintentar.
- `prisma/schema.prisma` — no hace falta migración: el progreso vive en Redis vía `job.updateProgress`.
- `api/src/workers/mensajesProgramadosWorker.js` y `emailMasivoWorker.js` — el programado delega el envío en esta misma cola, así que hereda el fix.
- `scraper/mensajes.js` — el envío unitario a Moodle no cambia.

## Git workflow

- Branch: `advisor/004-mensajes-idempotencia` (desde `master`).
- Commit estilo repo: `fix(mensajes): reanudar envio masivo en retry sin duplicar destinatarios`.
- NO push ni PR salvo instrucción del operador.

## Steps

### Step 1: Registrar el progreso por destinatario en el job

En `mensajeFormativoWorker.js`:

1. Al inicio del handler, leer el progreso previo: `const yaEnviados = new Set(Array.isArray(job.progress?.enviadosMoodleIds) ? job.progress.enviadosMoodleIds : []);` (en BullMQ v5, `job.progress` contiene el último valor pasado a `updateProgress`; en el primer attempt es `0` → Set vacío).
2. En el loop, ANTES de enviar: `if (yaEnviados.has(String(dest.moodleId))) { enviados++; continue; }` — con un log `[mensajeFormativoWorker] retry: saltando moodleId=... (ya enviado en attempt anterior)`.
3. Tras cada envío `resultado.ok`: agregar el moodleId al Set y persistir: `await job.updateProgress({ enviadosMoodleIds: [...yaEnviados] });`. (Es 1 write a Redis por destinatario — aceptable: el envío Moodle tarda segundos; si se quiere, persistir cada N=5.)
4. Actualizar el docstring de cabecera del archivo: documentar el campo de progreso y el comportamiento en retry.

**Verify**: `node --check api/src/workers/mensajeFormativoWorker.js` → exit 0; `npm test` → verde.

### Step 2: Extraer y testear la decisión de "saltar o enviar"

Extraer una función pura exportada (en el mismo archivo, junto a `nombresDeEvidencias`/`formatearEvidencias` que ya son helpers locales):

```js
/** Filtra los destinatarios que faltan por enviar dado el progreso persistido del job. */
function destinatariosPendientes(destinatarios, enviadosMoodleIds) { ... }
```

y usarla en el loop. Exportarla: el archivo hoy hace `module.exports = worker;` — cambiar a `module.exports = worker; module.exports.destinatariosPendientes = destinatariosPendientes;` (sin romper el import de `worker-entry.js`, que usa el default).

Crear `api/src/workers/mensajeFormativoWorker.test.js`. **OJO**: requerir el worker arranca un Worker de BullMQ real → NO importar el archivo entero en el test si eso conecta a Redis. Verificar primero: si `require` del worker intenta conectar, mover `destinatariosPendientes` a `api/src/lib/mensajesMasivos.js` (que es lib pura ya importada por la ruta y el worker) y testearla allí. Casos:
1. Progreso vacío → devuelve todos.
2. Progreso con 2 de 5 moodleIds → devuelve los 3 restantes.
3. Destinatario sin moodleId → siempre incluido (lo salta el chequeo existente del loop, no este filtro).

**Verify**: `npm test` → verde con los 3 casos nuevos; `node --check` en los archivos tocados.

### Step 3: Verificación del contador final

Asegurar que el `prisma.mensajeFormativo.update` final (estado `enviado`/`error` con `"${enviados}/${total} enviados"`) cuenta los saltados-por-retry como enviados (paso 1.2 ya hace `enviados++`). Revisar que el handler `worker.on("failed")` (líneas 215-222) siga marcando `estado: "error"` solo cuando se agotan los attempts — en BullMQ el evento `failed` se emite por attempt fallido; si esto marca `error` en el attempt 1 y luego el attempt 2 termina OK y marca `enviado`, el orden final es correcto (el update del attempt 2 gana). Documentarlo en un comentario si se confirma; si se descubre que el evento pisa el estado DESPUÉS del éxito, reportar como STOP.

**Verify**: lectura + comentario; `npm test` verde.

## Test plan

- `destinatariosPendientes`: 3 casos del Step 2 (patrón: `api/src/lib/calificacion.test.js`, `node:test` + `assert/strict`).
- Verificación manual opcional (si hay entorno vivo): encolar un envío a 3+ destinatarios de prueba, matar el proceso worker tras el primer envío, relanzar `node api/src/worker-entry.js`, y confirmar en los logs que el retry salta al primero.

## Done criteria

- [ ] `npm test` exit 0 con los 3 tests nuevos.
- [ ] `node --check` exit 0 en los archivos tocados.
- [ ] El loop de envío consulta el progreso del job antes de cada envío y lo persiste tras cada éxito (visible en el diff).
- [ ] Docstring del worker actualizado (campo de progreso + comportamiento en retry).
- [ ] Ningún archivo fuera del scope modificado (`git status`).
- [ ] Fila actualizada en `plans/README.md`.

## STOP conditions

Stop and report back (do not improvise) if:

- `job.progress` NO sobrevive entre attempts en la versión de BullMQ instalada (verificarlo en `node_modules/bullmq` docs/código si hay duda) — en ese caso la alternativa es persistir el Set en el row `MensajeFormativo` (campo Json nuevo → requiere migración → fuera de scope, reportar).
- Importar el worker en un test conecta a Redis y no se puede evitar moviendo el helper a `lib/mensajesMasivos.js`.
- Descubres que `worker.on("failed")` pisa el estado `enviado` después de un retry exitoso (Step 3).
- El loop de envío ya no coincide con el excerpt (drift — p.ej. el plan 003 no debería tocarlo, pero verifica).

## Maintenance notes

- Si algún día `mensajesQueue` sube de `attempts: 2`, este mecanismo ya lo cubre.
- El mismo patrón aplica a `foroRatingWorker` (cola con attempts:3, POSTs de rating): los ratings son *set absoluto* (re-postear el mismo valor es inocuo), así que allí NO es urgente — documentado como rechazado en `plans/README.md`.
- Reviewer: cuidado con `updateProgress` dentro del catch de reconexión — solo persistir tras envíos confirmados (`resultado.ok`).
- Los mensajes programados (`mensajesProgramadosWorker`) delegan en esta cola → heredan el fix sin cambios.
