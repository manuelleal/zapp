# Auditoría de release — Área 2: Workers y Scraping

> Agente 2. Solo lectura del código (sin ejecutar scans). Revisión de
> `api/src/workers/*`, `worker-entry.js`, `scraper/*`, `api/src/lib/{browserPool,
> playwrightSession,userLock,queue,sessionStore,esSesionValida,fetchWithRetry}.js`
> y `scraper/configEvidenciasFetch.js`.
> Nota operativa: en esta sesión no tuve permiso para `node --check` (Bash y
> PowerShell denegados); la revisión es estática por lectura. Recomiendo correr
> `node --check` sobre los archivos tocados antes del release.

## Resumen ejecutivo

El área está en **muy buen estado para producción**. Los cinco fixes P0 del
proceso (split API/workers, browser compartido, bloqueo de recursos, semáforo de
contexts, rate-limit) están aplicados y se verifican en el código. Las dos piezas
estrella del post-mortem también están presentes y bien implementadas:

- **Candado por-usuario (P0.1)** en `userLock.js`, integrado en la factory
  `crearSesionAutenticada` → **todos** los workers que tocan la sesión Moodle lo
  adquieren antes de loguear y lo liberan en `release()`. Serializa el trabajo de
  un mismo usuario entre TODAS las colas. Lock distribuido correcto (SET NX PX,
  token único, release con check-and-del en Lua, heartbeat con `unref`).
- **Validación de sesión robusta** (`esSesionValida.js` + `configEvidenciasFetch.
  obtenerFormFetch`): el chequeo es "¿seguí en /my/ (o en modedit)?", NO "¿no
  estoy en /login?". Esto corrige de raíz el falso positivo conocido (SENA rebota
  la sesión expirada al portal raíz, no a /login).

Los **16** workers (`worker-entry.js` lista 16; el log decía 15 históricamente)
migraron a la factory de sesión + `browserPool`. **Ninguno** hace
`chromium.launch()` ni `browser.close()` propios en la ruta de worker (los
`chromium.launch()` que existen están en CLI `main()` de `scraper/fichas.js` y en
`scraper/probes/*`, fuera del runtime de workers).

**Único hallazgo de severidad media** que sigue abierto: la **idempotencia de
`foroRatingWorker`** (puede recalificar en un retry). Es un riesgo conocido y
documentado, pero a diferencia de `mensajeFormativoWorker` (que sí resolvió su
idempotencia con `job.progress`), `foroRating` sigue con `attempts:3` y sin guarda.

## Tabla de hallazgos

| Sev | Archivo:línea | Problema | Fix sugerido |
|-----|---------------|----------|--------------|
| **P1** | `api/src/lib/queue.js:22` + `api/src/workers/foroRatingWorker.js:71` + `scraper/foroRating.js:138` | **Doble calificación en retry.** La cola `foroRating` usa `retryOpts` (`attempts:3`). `calificarPostsForo` hace POST a `/rating/rate.php` por **cada** rating sin mirar si el post ya estaba calificado (`recolectarFormsRating` ya expone `ratingActual`/`yaCalificado` pero el bucle de POST no los usa). Si Moodle responde lento y el POST llega pero la respuesta no, BullMQ marca stalled→retry y vuelve a calificar. El scraper ya extrae `yaCalificado`, así que el dato existe pero se ignora. | Mínimo: bajar `foroRating` a `attempts:1` (igual que `cambiarFecha`/`cambiarConfig`). Mejor: replicar el patrón de `mensajeFormativoWorker` (persistir `job.updateProgress({ ratedMoodleIds })` tras cada POST OK y filtrar al reintentar), o saltar el POST cuando `form.yaCalificado` y la nota deseada coincide con `ratingActual`. |
| **P1** | `api/src/lib/queue.js:35-38` | **autoScan sin fail-safe si Redis cae al boot.** El registro del repetible está en un `.then().catch()` que solo loguea; si Redis no está listo en el arranque del proceso de workers, el cron de 3h no se registra y nadie lo reintenta. Igual aplica al tick de `mensajesProgramados` (línea 43-46). | Re-registrar el repeatable al reconectar Redis (listener `connection.on("ready", ...)`) o un pequeño retry con backoff. Documentado en CLAUDE.md §11.3 P1 #9 — sigue pendiente. |
| **P2** | `api/src/lib/userLock.js:26` (`ACQUIRE_TIMEOUT_MS = 5min`) vs workers de lote (`cambiarFechaWorker`, `cambiarConfigWorker`, `leerConfigLoteWorker`) | **Posible timeout del candado en lotes grandes.** Un lote de muchas evidencias puede tardar >5 min con el lock tomado; un segundo job del MISMO usuario esperando lanza "Otra tarea del mismo usuario está usando la sesión..." y falla (con `attempts:1` no reintenta). Es correcto por diseño (serializa), pero el mensaje llega como error del job, no como reintento. El heartbeat renueva el TTL del lock (bien), así que el dueño no se queda sin lock; el problema es solo el que ESPERA. | Subir `ACQUIRE_TIMEOUT_MS` para colas de lote, o que la UI/route encole con backoff y muestre "en cola tras otra tarea" en vez de error. Bajo impacto con un instructor a la vez. |
| **P2** | `api/src/workers/foroRatingWorker.js:39-51` | Tras calificar, marca `entrega.estado="calificado"` por `updateMany` filtrando `fichaId`+`moodleId` — multi-tenant OK (la evidencia/ficha cuelga del userId). Pero **no setea `notaActual`/`notaCualitativa`** con la nota recién puesta; el estado visual queda "calificado" sin la nota hasta el próximo scan. | Persistir también la nota aplicada (`r.nota`) en la entrega para feedback inmediato. Cosmético. |
| **P2** | `api/src/workers/emailMasivoWorker.js:122-142` | El envío SMTP **no es idempotente** ante retry, pero la cola es `attempts:1` (`queue.js:28`) → sin retry, no recalifica/reenvía. OK mientras `attempts` siga en 1. Anotarlo para que nadie suba `attempts` sin agregar guarda (como la de `mensajeFormativoWorker`). | Comentario de advertencia "no subir attempts sin idempotencia". |
| **P2 (informativo)** | `api/src/lib/fetchWithRetry.js` | Helper de retry de red existe pero **no se importa en ningún worker** (cableado a medias, ya señalado en CLAUDE.md §11.2). No es bug; es código aún no usado de la migración a fetch (P1 #7). | Usarlo cuando se migre la lectura a Node fetch, o borrarlo si no se usará. |

## Verificación por punto del encargo

**1. Robustez de sesión SSO — OK.**
`esSesionValida.js` valida por permanencia en `/my` (no por ausencia de `/login`).
`playwrightSession.entrar()` revalida la sesión cacheada navegando a `/my/` y
hace login fresco si rebotó. `configEvidenciasFetch.obtenerFormFetch` detecta el
rebote por `finalUrl` fuera de `modedit.php` y lanza error claro → BullMQ
reintenta con login fresco. `auth.login` además detecta credenciales malas por el
redirect `?error=` del portal SENA (no por los selectores nativos de Moodle) y la
factory lo eleva a `UnrecoverableError` (no reintenta con clave vieja). Sólido.

**2. Idempotencia — un gap real (`foroRating`, ver tabla P1).**
`mensajeFormativoWorker` está bien resuelto (persistencia de `enviadosMoodleIds` en
`job.progress` + `destinatariosPendientes`). `mensajesProgramadosWorker` reclama
con optimistic lock (`updateMany` condicionado a `proximaEjecucion`) — idempotente
aunque el tick corra dos veces. `cambiarFecha`/`cambiarConfig`/`leerConfigLote` van
con `attempts:1`. El único con `attempts>1` y efecto colateral sin guarda es
`foroRating`.

**3. Factory + browserPool — OK.**
Los 16 workers que tocan Moodle usan `crearSesionAutenticada`. `browserPool` tiene
singleton con auto-relanzamiento, semáforo `BROWSER_MAX_CONTEXTS` (default 10,
espera con backoff si se llena), bloqueo de recursos (`image/stylesheet/font/media/
other` abortados; `document/script/xhr/fetch` pasan) con kill-switch
`BROWSER_BLOCK_RESOURCES=0`. `acquireContext` libera el cupo del semáforo si falla
al preparar el context (no hay leak del contador). Ningún worker llama
`browser.close()`. `leerConfigLoteWorker` libera el browser tras el login
(`releaseBrowser`) y conserva el candado durante el loop de fetch — patrón correcto.

**4. Candado por-usuario (mutex P0.1) — OK.**
Adquirido dentro de la factory ANTES de cargar/tocar la sesión, liberado en
`release()` (idempotente). En el camino de error de la factory, libera context y
lock siempre. Heartbeat con `unref()` no mantiene vivo el proceso. Release con
check-and-del por token (no borra el lock de otro).

**5. Fugas de recursos — sin leaks evidentes.**
Todos los workers liberan en `finally { await sesion.release() }`. El semáforo se
decrementa en éxito y en error. Timeouts razonables por worker (30-90 s). No vi
`page`/`context` huérfanos.

**6. Manejo de fallos — un gap (autoScan fail-safe, ver tabla P1).**
Errores de DB en los handlers `failed` van con `.catch(()=>{})` para no enmascarar
el error original (correcto). `mensajesProgramados` no re-lanza por corrida rota
(una no frena las demás). Pendiente: re-registro del repeatable si Redis cae al
boot.

**7. Multi-tenant — OK.**
Los writes filtran por `fichaId`/`userId` derivado de la entidad del usuario.
`cambiarFecha`/`cambiarConfig` verifican `ev.ficha.userId === userId` antes de
tocar cada evidencia. `syncParticipantes` deriva el `userId` de la ficha para el
candado. `mensajesProgramados` cuelga todo de la ficha del user. Sin fugas
detectadas.

## Veredicto de robustez para producción

**APTO para release con una salvedad P1 recomendada de cerrar antes:** la
idempotencia de `foroRatingWorker`. Es la única vía por la que un retry puede
producir un efecto no deseado y visible para el instructor (recalificación de un
foro). El fix más barato y seguro es bajar la cola `foroRating` a `attempts:1`
(consistente con las otras colas de escritura); el fix ideal es saltar el POST
cuando el post ya tiene la nota deseada (`form.yaCalificado`/`ratingActual`).

El resto (autoScan fail-safe, timeout del lock en lotes, persistir nota tras
calificar foro) son mejoras de resiliencia/UX que no bloquean el release con el
volumen actual (~1 instructor activo a la vez por cuenta, gracias al candado).
