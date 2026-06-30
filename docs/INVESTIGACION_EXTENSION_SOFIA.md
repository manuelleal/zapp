# Investigación — Evaluación / calificación de la "Extensión Z" y SOFIA Plus

> **Fecha:** 2026-06-21 · **Autor:** agente de investigación (Helper)
> **Pregunta del dueño:** ¿cómo realiza la "Extensión Z" la EVALUACIÓN / calificación,
> en especial lo relacionado con **SOFIA Plus**, y qué necesitaríamos para replicarlo en Helper?
>
> Convención de evidencia (igual que `docs/MOODLE_REFERENCE.md`):
> ✅ verificado en repo · 🔍 inferido del repo · 🌐 conocimiento general de la web (NO verificado) · ❓ desconocido / no hay dato.

---

> ## ⚠️ CORRECCIÓN (2026-06-29) — esta investigación quedó DESACTUALIZADA en lo de SOFIA Plus
>
> Un análisis posterior del **bundle real de la Extensión Z** (`root.PiOpq-8m.js`, que **SÍ está** en el
> repo, en worktrees de agente: `.claude/worktrees/agent-a58e3042986579dd3/root.PiOpq-8m.js`, líneas
> **882 y 887**) demostró que **la conclusión central de abajo es INCORRECTA**:
>
> - ❌ Decía: *"la Extensión Z NO califica en SOFIA Plus; el flujo es 100% manual; el bundle no existe en el repo."*
> - ✅🟣 **Real (verificado en el bundle):** la extensión tiene un módulo **"Evaluación Automática"** que
>   **REGISTRA juicios evaluativos en SOFIA Plus de forma automática**: login propio a SOFIA por **JOSSO
>   SSO** (`authpre.senasofiaplus.edu.co/josso/...`, lee `token` de localStorage, exige rol `value="13"`),
>   genera el reporte de juicios de la ficha (`reporteJuiciosEvaluacion.faces` con `javax.faces.ViewState`),
>   y por cada aprendiz×competencia/RAP hace un **POST JSF** serializando `formBusqueda` y poniendo el
>   `<select>` del juicio en **"A" (Aprobado)** + ViewState; al final reporta *"Guardados: X · Ya aprobados:
>   Y · Omitidos: Z"*. También consume un "archivo de evaluación automática" de entrada.
>
> **Incierto aún (❓):** el formato exacto de ese archivo de entrada, si registra valores distintos a "A"
> (p.ej. "No Aprobado"/"Por Evaluar"), y si la URL `authpre.` es pre-producción o la de prod.
>
> **Implicación para Helper:** es el MISMO patrón que Helper ya usa en Moodle (serializar form + POST
> `x-www-form-urlencoded`). Camino recomendado por valor/riesgo: (1) **exportar** el archivo que SOFIA/la
> extensión consumen [riesgo nulo], (2) **conciliar** el reporte de SOFIA, (3) extraer el contrato exacto
> del bundle, y dejar (4) el **registro automático en SOFIA** como fase final con confirmación humana +
> idempotencia + probe real (JSF/ViewState es frágil, SSO aparte de Zajuna, riesgo académico real).
>
> Lo de abajo se conserva como registro histórico; donde diga "SOFIA es manual / no hay bundle", prevalece esta corrección.

---

## 1. Resumen ejecutivo

- La "Extensión Z" **NO califica en SOFIA Plus**. Toda su evaluación verificable ocurre en **Zajuna (Moodle)**: lee y escribe notas en el *grader report* y en los *rating forms* de foros. ✅
- Para SOFIA Plus el flujo documentado es **100% manual**: el instructor descarga el reporte de juicios evaluativos desde el portal de SOFIA y (en el plan) lo sube a Helper. **No hay API ni automatización implementada ni reverseada.** ✅ (`docs/MOODLE_REFERENCE.md:189-200`)
- En el repo **no existe** `api/src/routes/sofia.js`, ni modelo Prisma de SOFIA, ni endpoint `/api/sofia/upload`, ni el bundle original de la extensión. SOFIA aparece SOLO como pendiente en documentación. ✅
- Helper **hoy** sí lee notas de Moodle (número y cualitativa A/D) y sí escribe notas en foros; sobre esos datos clasifica "juicios" para sus **actas GOR-F-084** (documento Word). Ese "juicio" es interno de Helper, no se sincroniza con SOFIA. ✅
- **La brecha para "evaluar en Sofia" es total**: no hay ni una línea de código que toque SOFIA Plus, y no hay ingeniería inversa de cómo la extensión (si es que lo hace) interactúa con SOFIA. Lo que sí tenemos es la *materia prima* (juicios A/NA por aprendiz) que un futuro puente a SOFIA necesitaría.

---

## 2. Qué hace la extensión al evaluar (según la ingeniería inversa del repo)

Todo lo que el repo sabe de la extensión sale de `docs/MOODLE_REFERENCE.md` (derivado del bundle
`root.PiOpq-8m.js`) y de notas en `HANDOFF.md` / `docs/PLAN_NOTA_Y_PRODUCCION.md`. Resumen de su
comportamiento de **evaluación**, siempre **dentro de Moodle/Zajuna**:

1. **Lee el estado de entrega** por actividad vía AJAX `mod_assign_list_participants` (campos
   `submitted`, `requiregrading`, `submissionstatus`, `isSuspended`). ✅ (`MOODLE_REFERENCE.md:72-112`)
2. **Lee las notas** desde el *grader report* (`/grade/report/grader/index.php?id={courseId}&perpage=0`)
   tomando por celda `input.value || span.gradevalue.textContent` con regex que captura **número O letra
   A/D** (escala cualitativa SENA). ✅ (`MOODLE_REFERENCE.md:144-160`; confirmado también en
   `docs/PLAN_NOTA_Y_PRODUCCION.md:17-19`).
3. **Escribe la calificación de assigns** vía **DOM**, no AJAX: pone el valor en el input
   `grade[{userid}][{itemid}]` de la tabla del grader y guarda con el submit del formulario de la
   página. Escala: **A = Aprobado, D = Desaprobado**. ✅ (`MOODLE_REFERENCE.md:144-165`)
4. **SOFIA Plus:** la extensión/flujo **no automatiza** la evaluación en SOFIA. El reporte de juicios
   se **descarga a mano** del portal SOFIA y se procesa aparte. ✅ (`MOODLE_REFERENCE.md:189-200`)

> ⚠️ **Importante:** el documento describe la calificación de la extensión como vía **DOM**
> (`MOODLE_REFERENCE.md:146` "no via AJAX"). Helper, en cambio, escribe foros vía `fetch` a
> `/rating/rate.php` (ver §5). Para **assigns**, Helper hoy **NO escribe nota** (solo lee). Es una
> diferencia real entre lo documentado de la extensión y lo implementado en Helper.

---

## 3. Mecanismo técnico (SOLO lo verificado del repo)

### 3.1 Extensión Z — endpoints/contratos documentados
- `sesskey`: `window.M.cfg.sesskey` (o input hidden / link de logout como fallback). ✅ `MOODLE_REFERENCE.md:39-55`
- Listar participantes/estado: `POST /lib/ajax/service.php?sesskey={k}&info=mod_assign_list_participants`. ✅ `MOODLE_REFERENCE.md:72-112`
- Notas (lectura): `GET /grade/report/grader/index.php?id={courseId}&perpage=0`. ✅ `MOODLE_REFERENCE.md:144-160`
- Calificar assign (escritura): input `grade[{userid}][{itemid}]` + submit DOM. ✅ `MOODLE_REFERENCE.md:152-160`
- SOFIA Plus: URL de descarga manual `https://senasofiaplus.edu.co/sofia/ejecucionformacion/reportes/reporteJuiciosEvaluacion.faces` + `POST /api/sofia/upload` (este último **NO implementado**). ✅ `MOODLE_REFERENCE.md:189-200`

### 3.2 Estado de implementación que el propio repo declara
`docs/MOODLE_REFERENCE.md:281-293` (tabla "Estado de implementación"):
- `Calificación masiva | scraper/calificacion.js | ⏳ Pendiente`  → **el archivo NO existe** ✅ (no aparece en `scraper/`).
- `Sofía Plus upload | api/src/routes/sofia.js | ⏳ Pendiente` → **el archivo NO existe** ✅ (no aparece en `api/src/routes/`).

> Es decir: el propio doc reconoce que calificación-masiva-de-assigns y SOFIA están **pendientes**.
> Lo que SÍ se implementó después fue la calificación de **foros** (no estaba en esa tabla; ver §5).

---

## 4. SOFIA Plus vs Zajuna (qué se sabe / qué no)

| Aspecto | Zajuna (Moodle/LMS) | SOFIA Plus (sistema académico) |
|---|---|---|
| Qué es | Plataforma de aprendizaje: actividades, entregas, foros, libro de notas | Sistema oficial donde se registran los **juicios evaluativos** (Aprobado/No Aprobado por resultado de aprendizaje) |
| ¿La extensión interactúa? | ✅ Sí, a fondo (AJAX + DOM, lectura y escritura de notas) | ❌ No automatiza nada; descarga manual de reporte |
| ¿Helper interactúa? | ✅ Sí (lee notas, escribe foros, lee config) | ❌ Nada en absoluto |
| Login | SSO federado del portal SENA → Moodle (Playwright obligatorio) ✅ `docs/ARCHITECTURE.md:230-236` | ❓ No estudiado en el repo |
| API conocida | Subconjunto de Moodle WS / AJAX habilitado (ver `MOODLE_REFERENCE.md`) | ❓ Desconocida. El doc dice explícitamente "**No hay API**" `MOODLE_REFERENCE.md:191` |
| Endpoint citado | varios | `…/reporteJuiciosEvaluacion.faces` (un reporte JSF, solo DESCARGA manual) ✅ |

**Lo que NO se sabe / no está en el repo (❓):**
- Si la "Extensión Z" tiene *alguna* función que interactúe con SOFIA (el repo NO tiene el bundle ni evidencia de ello).
- Cómo se autentica SOFIA, qué tecnología usa el formulario de juicios, si hay endpoints POST para *registrar* (no solo descargar) juicios.
- El formato exacto del archivo de "reporte de juicios evaluativos" que se descarga (CSV/XLS/PDF). ❓

---

## 5. Cómo califica Helper hoy (con archivo:línea)

Helper opera **solo contra Zajuna/Moodle**. Dos caminos:

### 5.1 LECTURA de notas (scan) — número y cualitativa A/D
- Navega el grader report UNA vez: `scraper/evidencias.js:264-271` (`navegarAlGrader`, `perpage=5000`).
- Extrae notas por `itemid`: `scraper/evidencias.js:671-677` (`obtenerNotasGrader`, captura número O letra A/D con el mismo enfoque que la extensión).
- Estado de entrega por AJAX (CAPA 2): `scraper/evidencias.js:16-20` y bloque `listarParticipantesBatch` (`mod_assign_list_participants`), resolviendo `cmid→assignId` leyendo `data-*` del grader (`scraper/evidencias.js:560-567`).
- El worker fusiona: el **CSV/libro es la fuente de verdad de la nota numérica**, y luego aplica la nota del grader por `itemid` (número → `notaActual`, letra → `notaCualitativa`):
  `api/src/workers/evidenciasWorker.js:298-301` (override CSV) y `:440-445` (nota del grader → `notaActual`/`notaCualitativa`/`estado="calificado"`).
- Persistencia: `Entrega.notaActual Float?` + `Entrega.notaCualitativa String?` → `prisma/schema.prisma:201`.

### 5.2 ESCRITURA de calificación — SOLO foros (rating)
- Endpoint: `PATCH /api/evidencias/:id/foro/calificar` → `api/src/routes/foroRating.js:14-56` (valida tenant + `tipo==="forum"`, encola job).
- Scraper: `scraper/foroRating.js:95-198` (`calificarPostsForo`): serializa `form.postratingform` (todos los hidden + sesskey + itemid + scaleid), sobreescribe `rating` y hace **`POST /rating/rate.php`** con `application/x-www-form-urlencoded` vía `fetch(..., {credentials:"include"})` dentro del contexto del navegador.
- Descubrir foros sin nota: `scraper/foroRating.js:221-305` (`descubrirCalificacionesPendientesForo`).
- **No hay escritura de nota para assigns/quiz.** No existe `scraper/calificacion.js`. ✅ (confirmado: `scraper/` solo tiene `auth, configEvidencias, configEvidenciasFetch, csvParser, evidencias, extractGuiaRaps, fichas, foroRating, mensajes, seedRapsIngles`).

### 5.3 "Juicio" de Helper (motor de actas) — derivado, interno
- Reglas SENA (umbral 70/100, cualitativa A/D): `api/src/lib/calificacion.js:23-33` (`esAprobada`), `:50-61` (`calcularEstado` por RAP), `:67-72` (`calcularJuicio` global).
- El juicio (`APROBÓ`/`PENDIENTE`/`NO PARTICIPÓ`) se guarda en `ActaParticipante.juicio` → `prisma/schema.prisma:355-366`, y alimenta el **Word GOR-F-084** que el instructor descarga.
- **Este juicio NO se envía a SOFIA.** Es la base del acta en papel/Word; el registro en SOFIA lo hace el instructor a mano. 🔍 (no hay código de sincronización; inferencia directa de la ausencia).

---

## 6. Brecha para replicar la evaluación "en Sofia"

**Brecha = prácticamente todo.** No hay base previa sobre SOFIA en el repo.

Lo que **sí tenemos** (insumo aprovechable):
- El dato evaluativo por aprendiz y por RAP ya calculado (juicio A/NA) — `api/src/lib/calificacion.js` + `ActaParticipante`. ✅
- Patrón de scraping autenticado + sesión cacheada + `fetch` con cookies (reutilizable para otro portal). ✅ (`scraper/auth.js`, `api/src/lib/sessionStore.js`).

Lo que **falta** para evaluar en SOFIA (todo ❓ / sin verificar):
1. **Reverse-engineering de SOFIA Plus**: cómo es el login, si comparte SSO con Zajuna, qué stack usa (parece JSF/`.faces`), y si la pantalla de registro de juicios permite POST programático o exige interacción UI paso a paso.
2. **Mapeo de identidad**: cruzar el aprendiz/RAP de Moodle (moodleUserId, código de evidencia) con la ficha/competencia/resultado-de-aprendizaje tal como los identifica SOFIA (probablemente por documento + código de programa/ficha). El repo deduplica aprendices por documento (`Aprendiz.documento`), lo cual ayuda. 🔍
3. **Decisión de alcance**: replicar el flujo documentado (descargar reporte de SOFIA → subir a Helper → cruzar) **o** ir más allá y *escribir* juicios en SOFIA (mucho más riesgoso/desconocido). El doc actual solo contempla el primero (`MOODLE_REFERENCE.md:196-199`).
4. **Implementación mínima del plan ya escrito**: `api/src/routes/sofia.js` + `POST /api/sofia/upload` + parser del reporte de juicios + reconciliación con DB. Nada de esto existe.

> ⚠️ **No inventar endpoints de SOFIA.** El único dato verificable es una URL de **descarga manual**
> de un reporte JSF (`reporteJuiciosEvaluacion.faces`). Cualquier "endpoint de registro de juicios"
> tendría que ser descubierto con una sesión real; no está en el repo.

---

## 7. Preguntas abiertas / próximos pasos para el dueño

1. **¿La "Extensión Z" realmente evalúa en SOFIA, o solo en Zajuna?** Por todo lo verificable, solo
   Zajuna. Si el dueño cree que la extensión hace algo en SOFIA, hace falta el **bundle original**
   (`root.PiOpq-8m.js`) o una grabación de red de la extensión operando en SOFIA. Hoy ese material
   **no está en el repo**. (❓ a confirmar por el dueño)
2. **¿Qué significa exactamente "evaluar en Sofia" para el negocio?** ¿(a) cruzar el reporte
   descargado de SOFIA con Helper para validar/comparar juicios, o (b) que Helper **registre** los
   juicios A/NA directamente en SOFIA? El esfuerzo y el riesgo son muy distintos.
3. **¿SOFIA comparte el SSO con Zajuna?** Si es el mismo login federado, la sesión cacheada podría
   reutilizarse; si no, hay que estudiar su autenticación aparte. (❓)
4. **Conseguir un ejemplo del archivo de "reporte de juicios"** (formato/columnas) para poder
   construir el parser de `POST /api/sofia/upload` que ya estaba planeado. Este es el **paso más
   barato y seguro** y desbloquea el flujo documentado sin tocar SOFIA en escritura.
5. **Mientras tanto, Helper ya produce el insumo evaluativo** (acta GOR-F-084 con juicios por
   aprendiz). Decidir si eso es suficiente como entregable y dejar el registro en SOFIA como manual,
   o invertir en el reverse-engineering de SOFIA (tarea grande, sin base previa).

---

### Apéndice — Archivos clave consultados (verificados)
- `docs/MOODLE_REFERENCE.md` (extensión + SOFIA, líneas 144-200, 281-293)
- `docs/ARCHITECTURE.md` (login SSO 230-236, modelo de datos)
- `docs/PLAN_NOTA_Y_PRODUCCION.md` (lectura de nota A/D estilo extensión, 17-19)
- `api/src/lib/calificacion.js` (motor de juicio SENA)
- `scraper/foroRating.js` (única ESCRITURA de nota — foros, `/rating/rate.php`)
- `scraper/evidencias.js` (lectura de notas/estado: grader report + AJAX)
- `api/src/workers/evidenciasWorker.js` (fusión CSV/grader → `notaActual`/`notaCualitativa`)
- `api/src/routes/foroRating.js` (endpoint de calificación de foros)
- `prisma/schema.prisma` (`Entrega.notaCualitativa`, `ActaParticipante.juicio`)
- **Ausentes (confirmado):** `scraper/calificacion.js`, `api/src/routes/sofia.js`, modelo SOFIA, bundle `root.PiOpq-8m.js`.
