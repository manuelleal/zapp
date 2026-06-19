# Auditoría de Release — AGENTE 1: Backend HTTP (`api/src/routes/*`, `api/src/lib/*`, `server.js`)

Fecha: 2026-06-19 · App "Helper" (Zajuna) · Rama `master`
Alcance: rutas HTTP, libs de soporte, middleware de auth/JWT. Incluye trabajo SIN commitear en `actas.js` y `lib/actaSaneado.js`. **Solo lectura.**

---

## Resumen ejecutivo

El backend HTTP está **mayormente sólido en multi-tenant**: casi todas las rutas que tocan recursos del usuario verifican pertenencia (`ficha.userId === req.user.id`, helpers `verificarFichaDelUsuario`/`verificarActaDelUsuario`, o `count`/`findMany` filtrado por `userId`). La autenticación JWT está bien cableada (`fastify.authenticate` en todos los endpoints de datos; los públicos son solo `/api/auth/*` y `/api/health`). El motor de calificación (`lib/calificacion.js`) respeta fielmente las reglas SENA (umbral 70, A/D, cierre manual, IA no decide notas).

**Sin embargo, hay un IDOR real (P0) en `POST /api/actas/confirm-native`** que permite inyectar `aprendizId` de otra ficha/tenant en un acta, filtrando nombres de aprendices ajenos al Word generado. Y un **IDOR P1 en `POST /api/matching/iniciar`** que no valida pertenencia de los `evidenciaIds` recibidos. Hay además varias debilidades P1/P2 (validación de input incompleta, rate-limit en memoria por-proceso, posibles errores 500 sin try/catch que filtran stack).

**Veredicto:** NO listo para producción tal cual. Corregir el P0 de `confirm-native` es bloqueante (es la función estrella del producto y filtra datos personales protegidos por Ley 1581). Los P1 deben resolverse antes de exponer a >1 instructor real. Tras eso, el backend HTTP es apto para un piloto controlado.

---

## Tabla de hallazgos

| Sev | Archivo:línea | Problema | Fix sugerido |
|-----|---------------|----------|--------------|
| **P0** | `routes/actas.js:1455-1463` (`confirm-native`) | **IDOR cross-tenant.** El endpoint hace `actaParticipante.createMany` con `aprendizId` tomado directo del body del cliente, sin verificar que esos aprendices pertenezcan a `acta.fichaId`. El FK de `ActaParticipante.aprendizId` (schema.prisma:322) solo exige que el aprendiz exista — no que sea de la ficha del usuario. Un atacante puede adjuntar aprendices de OTRO instructor/ficha al acta; sus nombres+documentos salen en el Word (`download`/`gor-f-084`). Viola regla #1 y expone datos personales (Ley 1581 citada en el propio acta). | Antes del `createMany`, cargar `prisma.aprendiz.findMany({ where: { id: { in: aprendizIds }, fichaId: ficha.id }, select:{id:true} })` y rechazar (400/403) si algún `aprendizId` del body no está en ese set. |
| **P1** | `routes/matchingIa.js:18-26` (`/matching/iniciar`) | IDOR parcial: cuando llegan `evidenciaIds`, calcula `total` con `where:{ id:{in:evidenciaIds}, ficha:{userId} }` (bien), pero **encola el job con los `evidenciaIds` crudos del body** (línea 41) sin filtrar los que no son del usuario. Si el `matchingIaWorker` no re-valida pertenencia, se corre matching sobre evidencias ajenas. | Resolver el set válido (`evidencia.findMany filtrado por userId`) y encolar SOLO esos ids, o validar que `total === evidenciaIds.length` y rechazar si difieren. |
| **P1** | `routes/auth.js:11-31` | Rate-limit de login/register es un `Map` en memoria **por proceso**. Con la API en modo cluster (ecosystem `api` puede ir cluster, §11.4) o varios workers, el límite se multiplica por nº de procesos y no sobrevive reinicios. Ya documentado como P1 #8 pero sigue activo. | Migrar a Redis (ya hay `ioredis`/`connection` en `lib/queue`). Clave `ratelimit:{ip}` con `INCR`+`EXPIRE`. |
| **P1** | `routes/actas.js` y varias rutas | Múltiples handlers `async` sin `try/catch` ejecutan queries Prisma directas (p.ej. `auto-poblar`, `preview-native`, `confirm-native`, los `download`). Un fallo de DB/Prisma se propaga al error handler por defecto de Fastify, que en `NODE_ENV` no-producción puede **devolver el stack/mensaje** al cliente. No hay `setErrorHandler` global en `server.js`. | Agregar `fastify.setErrorHandler` que loguee el error y responda `{error:"Error interno"}` con 500 genérico, sin filtrar stack ni `err.message` de Prisma. |
| **P1** | `routes/actas.js:1266-1419` (`preview-native`) y `auto-poblar` | El bloque de dedup de aprendices (`nucleoPrimerToken`/`claveNombre`/orden por `_count.entregas`) está **duplicado literal** entre `auto-poblar` (351-404) y `preview-native` (1298-1337). Riesgo: divergen al editar uno solo (ya pasó con otras reglas). No es bug funcional pero sí deuda que puede introducir bugs de consistencia entre preview y confirm. | Extraer a un helper puro en `actas.helpers.js` (`dedupAprendices(aprendicesRaw)`), testeable, usado por ambos. |
| **P1** | `routes/mensajes.js:34-113` (`POST /api/mensajes`) y `enviar-masivo:261-272` | Los `destinatarios` del body se confían parcialmente: en canal `manual` se persiste `destinatarios` crudo sin verificar que los `aprendizId` sean de la ficha; en `enviar-masivo`, `d.nombre`/`d.email`/`d.ficha`/`d.instructor` vienen del cliente y se usan tal cual (interpolación en mensaje). No es cross-tenant grave (el envío real por zajuna re-filtra por `fichaId` en línea 69-72), pero permite inyectar nombres/emails arbitrarios en el historial y en el correo enviado. | Para canal email/zajuna, derivar `nombre`/`email`/`moodleId` SIEMPRE de DB (filtrado por `fichaId`) e ignorar los del cliente; validar que todo `aprendizId` pertenezca a la ficha. |
| **P2** | `routes/actasImport.js:42-53` y `actas.js:852-862` | `$queryRaw` con interpolación de template tag (parametrizado por Prisma, seguro contra inyección) — OK. Pero ambos hacen `JOIN "Aprendiz" a ON a.id = elem->>'aprendizId'` confiando en JSON `destinatarios` posiblemente sucio; el `try/catch` lo traga en silencio (`catch(_){}`), dejando `warningCount=0` sin señal. Aceptable funcionalmente pero enmascara errores reales. | Loguear el error en el catch (no romper la respuesta) para diagnóstico. |
| **P2** | `routes/scan.js:6-15` (`/scan/full`, `/scan/auto`) | No validan nada del body ni dedup de jobs: cada POST encola un `autoScanQueue.add` sin guard de idempotencia. Un cliente puede spamear scans (cada uno lanza Chromium). No es IDOR (usa `req.user.id`), pero permite agotar el pool de browsers de un tenant. | Guard: rechazar si ya hay un autoScan `queued/running` reciente del mismo userId (consultar BullMQ o un flag en `User.lastAutoScanAt`). |
| **P2** | `routes/configEvidencias.js:232-247` (`PATCH /:id/config`) | `intentos` y campos de fecha del body se pasan al worker sin validar tipo/rango (`abrirFecha` formato, `intentos` numérico ≥0). El worker podría POSTear basura a Moodle. Validación parcial existe en `batchConfig.js` pero no aquí. | Validar formato fecha `YYYY-MM-DD`, hora `HH:mm`, `intentos` entero en rango, antes de encolar. |
| **P2** | `server.js:15-18` (CORS) | `origin` cae a `http://localhost:5173` si no hay `ALLOWED_ORIGIN`. En producción sin esa env, CORS quedaría abierto solo a localhost (rompe), pero si se setea mal a `*` con credenciales sería riesgo. Hoy no permite credenciales explícitas, riesgo bajo. | Documentar `ALLOWED_ORIGIN` como obligatoria en prod; considerar rechazar arranque si falta en `NODE_ENV=production`. |
| **P2** | `routes/auth.js:67,85` | El JWT se firma con `expiresIn: "7d"` y NO hay refresh ni revocación. Si se compromete un token, vale 7 días (ya anotado en §9.4). El payload incluye `email`/`nombre` (no sensible). | Aceptable para piloto; documentar. A futuro: refresh token + lista de revocación en Redis. |
| **P2** | `lib/crypto.js:3` | `Buffer.from(process.env.ENCRYPTION_KEY, "hex")` se evalúa al `require`. Si la env falta o no es hex de 32 bytes, el proceso revienta con error poco claro al primer uso, no al boot. | Validar en boot: longitud de KEY === 32 bytes, fallar rápido con mensaje claro. |
| Info | `routes/fichas.js` vs `routes/archivar.js` | Ambos archivos definen rutas sobre `/api/fichas/:id` pero con **métodos distintos** (fichas: POST/PUT/DELETE/GET; archivar: PATCH). No hay colisión en Fastify (la clave es método+path). Verificado: sin choque. | Ninguno. |

---

## Notas de lo que está BIEN (para no re-tocar)

- **Multi-tenant consistente** en: `fichas.js`, `evidencias.js` (incluye el IDOR check explícito en `activar/bulk:169-172`), `configEvidencias.js` (helper `getEvidenciaConAcceso`), `batchConfig.js`, `archivar.js`, `foroRating.js`, `raps.js` (doble check: competencia del usuario + ficha del usuario en asociaciones), `jobs.js`, `matchingIa.js` (las propuestas sí validan `userId`), `mensajes.js` (programados y GET/sync validan ficha).
- **`lib/calificacion.js`** respeta las reglas SENA al pie: umbral 70 (`UMBRAL_SENA`), A/D cualitativa, `calificado` sin nota no aprueba, `every()` estricto por RAP, virtuales `sin_entregar`. Coherente con CLAUDE.md §5.10/§5.11.
- **`lib/actaSaneado.js`** (sin commitear): la IA solo limpia TEXTO, nunca toca juicios (regla #8); `sanearActa` nunca lanza (fallback determinista + timeout duro + cache). Reconciliación anti-alucinación de RAPs por código. Sólido.
- **`lib/crypto.js`** AES-256-GCM con IV aleatorio + authTag — correcto.
- **Superadmin** (`ajustes.js`) restringe por `req.user.email === SUPERADMIN` en los 3 endpoints sensibles (`/competencias`, `descubrir-competencias`, `simular-competencia`). El email del superadmin sale de env con fallback hardcodeado (anotado en CLAUDE.md §13.5, no re-reporto).
- **Validación de juicios** en `actas.js:257-263` (lista blanca `JUICIOS_VALIDOS`) y schemas Fastify en `POST /api/actas`, `ajustes` correo/zajuna/simular, `actas import-csv` — buena práctica donde existe.

---

## Hallazgos más graves (para el orquestador)

1. **P0 — IDOR cross-tenant en `POST /api/actas/confirm-native`** (`actas.js:1455`): acepta `aprendizId` arbitrarios del body sin verificar que sean de la ficha del acta. Filtra nombres/documentos de aprendices de otros instructores al Word generado. **Bloqueante.** Fix de ~5 líneas: validar el set de `aprendizId` contra `fichaId` antes del `createMany`.
2. **P1 — IDOR en `POST /api/matching/iniciar`** (`matchingIa.js:41`): encola `evidenciaIds` crudos del cliente sin filtrar por `userId` (solo los usa para contar). Depende de que el worker re-valide; si no, corre IA sobre evidencias ajenas.
3. **P1 — Sin `setErrorHandler` global** (`server.js`): handlers sin try/catch pueden filtrar stack/mensajes de Prisma al cliente en 500.
4. **P1 — Rate-limit de auth en memoria por-proceso** (`auth.js`): inefectivo con cluster/reinicios.
5. **P1 — Confianza parcial en `destinatarios` del cliente** (`mensajes.js`): derivar siempre de DB filtrado por ficha.

El resto (P2) es endurecimiento recomendable pero no bloqueante para un piloto.
