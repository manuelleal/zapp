# Post-mortem de fallos — Zajuna App

> Generado el 18 jun 2026 a partir de 3 investigaciones (concurrencia/sesión, UI/seguimiento de jobs, integridad/idempotencia). Enfoque: **instructor haciendo varias cosas a la vez (escanear + guardar fechas + calificar + mensajes) mientras navega.** Todas las ubicaciones son `file:line` verificadas por los agentes; re-verificar antes de implementar.

## Resumen en una frase

El trabajo pesado corre en workers del backend (no se muere al navegar), pero hay **una falla raíz que lo contamina todo cuando el instructor hace varias cosas a la vez: no existe un candado por-usuario**, y la sesión Moodle es única por cuenta → dos acciones simultáneas se pisan la sesión y una termina guardando **datos basura sin avisar**. Encima, la UI **pierde de vista** los trabajos al cambiar de página.

---

## 🔴 P0 — Crítico (corrompe datos; arreglar antes de multi-usuario real)

### P0.1 — No hay candado por-usuario → sesiones que se pisan (LA FALLA RAÍZ)
- **Qué:** Zajuna invalida sesiones paralelas de la misma cuenta. Dos jobs del mismo `userId` en **colas distintas** (ej. `evidenciasWorker` concurrency 3 escaneando + `cambiarFechaWorker` guardando) hacen login a la vez → el segundo **expulsa** al primero → el primero sigue navegando con sesión muerta.
- **Dónde:** `api/src/lib/sessionStore.js` (es un K/V sin mutex); workers en `api/src/workers/*` sin coordinación entre colas. `configWorker.js:130-132` ya documenta el problema pero solo lo mitigó con `concurrency:1` *dentro* de cada cola, no *entre* colas.
- **Impacto:** Scan guarda entregas en estado falso ("sin entregar"), notas en blanco, conteos malos. El job reporta **"done"**. Corrupción silenciosa.
- **Fix:** Mutex en Redis por `userId` (`SET lock:user:{id} NX EX 300`). Todo worker que vaya a hacer `login()`/usar la sesión adquiere el lock primero; lo libera al terminar. Es la pieza clave que además resuelve P0.2 parcialmente, la colisión de autoScan y reduce el daño de los clics apilados.

### P0.2 — No se re-valida la sesión a mitad de operación
- **Qué:** Los workers validan la sesión **solo al inicio**. Si se expulsa dentro de un loop largo (escaneo de N evidencias, calificación de N posts), siguen con DOM/sesión inválida.
- **Dónde:** loops en `evidenciasWorker.js:260+`, `cambiarFechaWorker.js:94+`, `foroRatingWorker.js:66+`. Único que reintenta bien: `leerConfigEvidenciaWorker.js:80-127` (borra sesión + relogin + 1 retry) — usar como patrón.
- **Impacto:** corrupción silenciosa (job "done" con datos parciales).
- **Fix:** detectar el rebote (redirect fuera de la página esperada / a portal raíz — mismo criterio del fix de hoy) y re-loguear + reintatar, al menos cada N iteraciones en loops largos.

### P0.3 — `foroRatingWorker`: doble calificación
- **Qué:** `attempts:3` + sin idempotencia. Si Moodle no responde tras el POST de nota y el job reintenta, **re-califica**.
- **Dónde:** `foroRatingWorker.js:66-86`, `queue.js` (foroRating attempts:3). El propio archivo reconoce el riesgo (P1 #10).
- **Impacto:** integridad de datos académicos.
- **Fix:** trackear `moodleUserId` ya posteados en `Job.resultado` y saltarlos en el retry; o bajar a `attempts:1`.

---

## 🟠 P1 — Alto (visibilidad / duplicación; el dolor diario del instructor)

### P1.1 — La UI pierde el trabajo al navegar / cerrar pestaña (lo que reportó el usuario)
- **Qué:** El job sigue en el backend, pero el seguimiento (progreso, "✓ guardado", toast) vive en el estado del componente. Al navegar se desmonta y se pierde; al volver, la tabla no sabe qué jobs había en vuelo.
- **Dónde:** `web/src/hooks/usePollJob.ts` (jobId no se persiste), `web/src/components/ConfigTabla.tsx:82-89` (estado volátil), `EvidenciasConfig.tsx` (al re-montar solo lee `configCache`, no jobs pendientes), `api/src/routes/jobs.js:4-16` (solo job por id; no hay `/jobs/pending` por usuario).
- **Modelo a copiar:** el **scan SÍ sobrevive** porque tiene estado durable + polling global: `Dashboard.tsx` ↔ `/api/scan/progress` y `/api/scan/status` (`scan.js:36-39`).
- **Fix:** (a) endpoint `GET /api/jobs/pending` (jobs `queued|running` del userId — la tabla `Job` ya existe, `schema.prisma:196`); (b) indicador **global** de "tareas en curso" que sobreviva a la navegación (chip arriba, como el scan); (c) al montar `ConfigTabla`, reenganchar el seguimiento de los jobs pendientes de esa ficha.

### P1.2 — Clics repetidos crean jobs duplicados (lo vimos hoy)
- **Qué:** sin debounce/guard real; `disabled={saving}` tiene race. Cada clic encola otra lectura/guardado completo → se apilan (concurrency 1 los serializa, el usuario ve "0%").
- **Dónde:** `ConfigTabla.tsx:333-336` (botón), `configEvidencias.js:232-247` (crea job nuevo siempre, sin dedup).
- **Fix:** guard con `useRef` (no solo estado), y dedup en backend por `{userId, fichaId, tipo}` en curso (BullMQ `jobId` determinista o chequear job activo antes de encolar).

### P1.3 — `acquireContext()` espera infinito si el pool se satura
- **Dónde:** `browserPool.js:71-74` (busy-wait `sleep(500)` sin timeout).
- **Fix:** timeout (ej. 60s) que lance error en vez de colgar el job.

### P1.4 — Lotes con fallo parcial no son idempotentes → reintento re-hace lo ya hecho
- **Qué:** si el instructor reintenta un lote que falló a mitad, se re-envían mensajes ya enviados / se re-aplican cambios ya aplicados (auditoría sucia, doble mensaje).
- **Dónde:** `mensajeFormativoWorker.js:137-204`, `emailMasivoWorker.js:122-156`, `cambiarFechaWorker.js:93-239`, `cambiarConfigWorker.js:81-140`. Bueno como referencia: `leerConfigLoteWorker.js:89-134` (detalle granular).
- **Fix:** trackear destinatarios/evidencias ya procesados en `resultado` y saltarlos en reintento.

---

## 🟡 P2 — Medio/Bajo (higiene / casos de borde)

- **P2.1 — Jobs "stalled" quedan "running" para siempre en DB** si el proceso worker muere a mitad (lo provocamos hoy con `taskkill`). No hay handler `stalled` ni limpieza. `queue.js` sin `maxStalledCount`/cleanup. Fix: handler + cron que cierre jobs `running` > X horas.
- **P2.2 — autoScan no se re-registra si Redis está caído al boot** (`queue.js:34-46`, solo loguea). Fix: reintento con backoff.
- **P2.3 — Micro-fuga multi-tenant** en `GET /api/mensajes/sync-emails/:jobId` (`mensajes.js:218-225`): no valida `job.data.userId === req.user.id`. Fix: validar dueño.
- **P2.4 — Tabla `Job` nunca se limpia** en Postgres (crece indefinidamente). Fix: cron de archivado/borrado.

> Multi-tenant en rutas principales (evidencias, config, mensajes): **bien** — verifican `userId`/`ficha.userId` antes de operar. Solo la fuga P2.3.

---

## Plan de ataque sugerido (orden)

1. **P0.1 (mutex por-usuario)** — keystone; desbloquea el escenario "varias cosas a la vez" sin corrupción. Tocar `sessionStore.js` + un helper de lock + envolver el login en todos los workers (ojo: boilerplate duplicado, ideal extraer factory `playwrightSession.js` que CLAUDE §P1 #6 ya pedía).
2. **P0.2 + P0.3** — re-validación mid-job + idempotencia de foroRating.
3. **P1.1 (seguimiento global de jobs)** — lo que pidió el usuario; copiar el patrón del scan. + **P1.2 (dedup de clics)**.
4. **P1.3, P1.4** — timeout de pool + idempotencia de lotes.
5. **P2.\*** — higiene cuando haya tiempo.

> Recomendación de ejecución: **planear aquí, implementar en ramas separadas** (working tree compartido). P0.1 toca muchos workers → hacerla sola en su rama. P1.1 es casi todo frontend + 1 endpoint → puede ir en paralelo en otra rama sin chocar con P0.1.
