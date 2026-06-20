# Implementation Plans

Generados por el skill `improve` el 2026-06-10 (commit base `762970a`, rama `master`).
Ejecutar en el orden de abajo salvo que las dependencias digan otra cosa. Cada ejecutor:
leer el plan completo antes de empezar, respetar sus STOP conditions, y actualizar su
fila al terminar.

Contexto del repo para ejecutores: CLAUDE.md es la fuente de verdad (reglas §5,
estilo de código §5.1, comandos de dev §3). Commits en español con prefijo
(`fix:`/`feat:`/`perf:`/`refactor:`/`chore:`/`test:`/`ci:`). `node --check` a todo
`.js` tocado. El working tree es compartido entre sesiones de agentes — no hacer
`checkout`/`reset --hard`/`stash` sobre trabajo ajeno.

## Execution order & status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001 | Eliminar vulnerabilidades críticas de deps (fast-jwt, @fastify/static, tar) | P1 | S | — | ✅ MERGED A MASTER (release 18 jun, commit `f1e2042`) |
| 007 | esAprobada lee la cualitativa A/D (60 entregas mal juzgadas en actas) | P1 | S | — (antes de 002) | ✅ MERGED A MASTER (release 18 jun) |
| 002 | Baseline de verificación (CI + tests de actas + e2e ejecutable) | P1 | M | — (mejor tras 001 y 007) | ✅ MERGED A MASTER (release 18 jun, 50/50 tests) |
| 003 | Factory única de sesión Playwright (11 workers) | P2 | M | 002 | 🟡 TODO — P1 #6 en CLAUDE.md §11.3. Sería `api/src/lib/playwrightSession.js`. |
| 004 | Idempotencia del envío masivo de mensajes en retry | P2 | S–M | — | ✅ MERGED A MASTER (release 18 jun) |
| 005 | Higiene: .env.example, fallback superadmin, deps muertas | P3 | S | — | ✅ PARCIAL — `.env.example` creado (commit `9af3ada`), fallback superadmin removido. Deps muertas pendientes. |
| 006 | SPIKE: migración de lecturas del scan a fetch+cheerio | P3 | M (spike) | 003 | 🟡 TODO — P1 #7 en CLAUDE.md §11.3. Requiere plan 003 primero. |

Status values: TODO | IN PROGRESS | DONE | BLOCKED (con motivo de una línea) | REJECTED (con justificación de una línea)

## Dependency notes

- **002 después de 001**: el CI nace corriendo contra dependencias ya parcheadas (no es bloqueante, es orden sensato).
- **003 requiere 002**: el refactor toca 11 workers auth-críticos; el CI de 002 atrapa regresiones de sintaxis/tests en cada tanda.
- **006 requiere 003**: tocan los mismos workers; además la factory de 003 es donde se cableará el modo "solo cookies" cuando se ejecute la migración (plan 007, que es OUTPUT del spike 006).
- **004 es independiente** pero su excerpt del worker puede driftar si 003 se ejecuta antes — su drift check ya lo contempla.

## Findings considered and rejected

Registrados para que nadie los re-audite (auditoría del 2026-06-10, hallazgos de subagentes verificados a mano contra el código):

- **"foroRating nunca envía el rating (variable shadowing)"**: FALSO. `scraper/foroRating.js:172` pasa `{ action, fields: body }` donde `body` (línea 156) ya incluye `rating: notaStr`. El rating sí viaja en el POST.
- **"Race conditions en el semáforo de browserPool"**: FALSO. Node es single-thread y en `api/src/lib/browserPool.js:71-75` no hay `await` entre la salida del while y el `activeContexts++` — el check+incremento es atómico por turno de event loop. El incremento antes de crear el context es reserva intencional de cupo.
- **"IDOR en GET /api/mensajes vía fichaId/actaId"**: FALSO. `api/src/routes/mensajes.js` arma `where = { userId: req.user.id }` primero; los query params solo componen encima.
- **"IDOR vía evidenciaIds en enviar-masivo"**: FALSO. `api/src/lib/mensajesMasivos.js:39` siempre incluye `fichaId` (ya verificado contra el userId) en el where — ids ajenos no matchean nada.
- **"N+1 en GET /api/actas/:id"**: FALSO. `api/src/routes/actas.js:136-162` es un único `findUnique` con `include` anidado — Prisma lo resuelve en ~3 queries, no 1+N.
- **"Falta índice en ActaParticipante.actaId"**: innecesario — `@@unique([actaId, aprendizId])` sirve como índice por prefijo izquierdo. Los índices compuestos extra propuestos (ActaSeguimiento `[userId, fichaId]`, ActaParticipante `[aprendizId]`) no valen la pena con los volúmenes actuales y sin un query que los pida.
- **"estado=calificado sin nota puede aprobar"**: ya guardado — regla §5.11 implementada en `esAprobada` y cubierta por test de regresión (`api/src/lib/calificacion.test.js:54-57`).
- **Comparación de year sin normalizar en la verificación de `configEvidenciasFetch`**: no vale la pena — ambos lados vienen del mismo form de Moodle con el mismo formato; `norm()` ya cubre month/day/hour/minute.
- **Idempotencia de foroRating (attempts:3)**: descartado como urgente — el rating es un *set absoluto*: re-postear el mismo valor es inocuo. El caso real de doble efecto es mensajes (plan 004).
- **CSRF**: mitigado por diseño — JWT viaja en header Authorization (no cookie); same-origin policy protege. Re-evaluar SOLO si alguien mueve el JWT a cookie.
- **`rejectUnauthorized:false` hacia Zajuna**: decisión documentada (CLAUDE.md §11.6) — cadena TLS incompleta de Zajuna; el dispatcher es local a esos fetch, no global. No tocar.
- **ENCRYPTION_KEY en process.env**: patrón estándar para self-hosted single-box; un secret manager es sobreingeniería al tamaño actual. Documentar rotación antes de vender (ya anotado en CLAUDE.md §9.4).
- **uuid moderate vía exceljs**: el "fix" de npm haría downgrade de exceljs 4→3 (rompe reportes). Riesgo aceptado: exceljs solo genera archivos, no parsea input no confiable. Re-evaluar cuando exceljs actualice uuid.
- **Binarios/logs tracked en root**: ya resuelto — `.gitignore` actual los cubre y `git ls-files` no muestra ninguno (la limpieza del CLEANUP_AUDIT ya se hizo).
- **Mensajes programados / filtros de destinatarios / selector de evidencias (direction)**: ya construidos en `928444e` y `762970a` (§14.6) durante esta misma auditoría.
- **Foro serial (rating y discussions una a una)**: real pero no planificado — MED confianza en que Moodle tolere concurrencia con el mismo sesskey, volumen bajo. Re-auditar si los foros se vuelven cuello de botella visible.

## Direcciones registradas sin plan

- **Bandeja de mensajes entrantes del instructor** — asimetría natural ahora que el envío está completo (backlog CLAUDE.md §7). Pedir un plan con `improve plan` cuando se priorice.
- **Notas numéricas reales del grader report** — ya existe `docs/PLAN_NOTA_Y_PRODUCCION.md` (5 fases); no necesita plan nuevo, solo ejecución.
