# Plan 009 — Estados nuevos de evidencia: "borrador" + "reenviado", y foros "pendiente de revisar"

> **Estado:** EN EJECUCIÓN — probe corrido contra datos reales (29-jun-2026). Decisiones tomadas: **diseño `subestado`** (no inflar `estado`), **`reenviado` EN PAUSA** (el AJAX no trae el dato), alcance = **borrador + foros "pendiente de revisar" + badge A/D**.
>
> **RESULTADO DEL PROBE (`scripts/probe-assign-raw-json.js`, ficha 3186684 / assignid 1016633, 48 participantes):**
> - Claves del participante (24): `submitted`, `requiregrading`, `submissionstatus`, `grantedextension`, `suspended`, datos de perfil… **NO hay `attemptnumber`/`attempt`, NO hay `timemodified`, NO hay `grade`/`gradingstatus`.**
> - `submissionstatus` observado: `new`=11, `submitted`=32, `""`(vacío)=5. (En este assign no había `draft` ni `reopened` vivos ahora.)
> - **Conclusión `reenviado`:** NO derivable del AJAX. El único campo "de intento" es `grantedextension` (prórroga, no reenvío). Detectarlo exigiría DOM por assign (lento, contra §11). → **PAUSA.**
> - **Conclusión `borrador`:** el campo existe y se lee; falta cazar un `draft` real para confirmar empíricamente. El fallback DOM (`revisarEntregas`) sí lee literal "Borrador (no enviado)".
> **Disparador:** los instructores piden dos estados nuevos al calificar evidencias — **borrador** (el aprendiz empezó la entrega pero no la mandó) y **reenviado** (volvió a entregar tras una primera vez). Además, para **foros** no quieren calificar dentro de la app (igual hay que entrar a leer): quieren que **si hay un comentario sin revisar, la evidencia aparezca como "pendiente de revisar"**.
> **App en PRODUCCIÓN con instructores reales** → este plan se ejecuta solo con luz verde, por fases, y la Fase que toca el **motor de actas (GOR-F-084)** es la de mayor cuidado.

---

## 0. Aclaración de base: `estado` ≠ `nota` (dos ejes distintos)

El instructor habló de "tres estados, dos los tenemos: la D y calificado". Eso mezcla dos ejes que en el código están separados:

- **`estado`** (flujo de la entrega) — hoy existen **TRES**, no dos: `sin_entregar`, `pendiente`, `calificado` (`scraper/evidencias.js:598-607`). (Hay además basura defensiva `desconocido`/`no_entregado` que casi no se usa.)
- **`nota`** (calificación) — numérica 0-100 **o** cualitativa **A/D** (`api/src/lib/calificacion.js:23-33`). La "D" es una NOTA, no un estado.

`borrador` y `reenviado` son estados nuevos del **primer eje**. No tocan la escala de notas ni el umbral 70.

### Modelo de datos (verificado en `prisma/schema.prisma`)
- `Entrega.estado` es **`String` libre, NO enum** (línea ~195) → **no hace falta migración de columna** para agregar valores nuevos. El costo está en los **consumidores** (ver blast radius).
- `Evidencia.tipo` (`"assign"`/`"forum"`/`"quiz"`) distingue foro de assign.
- `HistorialEstado` ya registra cualquier transición de estado (sirve para auditar borrador/reenviado).

---

## Fase 0 — Probe en vivo (decidido con el usuario: "probar Moodle primero")

**Por qué:** el AJAX `mod_assign_list_participants` de SENA, según el docstring verificado (`scraper/evidencias.js:587-589`), **NO trae** `grade`, `gradingstatus` ni número de intento — solo `submitted/requiregrading/submissionstatus`. La única señal cercana a "reenviado" es `submissionstatus="reopened"`, pero **"reabierto" ≠ "ya volvió a entregar"**, y mapearlo mal **reintroduce un bug ya documentado** (calificado→reabierto se pegaba en "pendiente", `evidencias.js:592-595`). No podemos diseñar "reenviado" fiable sin ver el JSON crudo.

**Artefacto (ya creado, read-only, no toca prod):** `scripts/probe-assign-raw-json.js`.
- Reusa la sesión Playwright guardada (o login fresco sin guardarla), resuelve `cmid→assignid` y vuelca el **JSON completo** de varios participantes + claves únicas + distribución de `submissionstatus`.
- **No escribe DB ni guarda sesión.**

**Cómo correrlo** (necesita un usuario con credenciales Zajuna y, idealmente, el `cmid` de un assign donde HAYA habido un reenvío/reapertura):
```powershell
node scripts/probe-assign-raw-json.js                         # autodetecta usuario+ficha+assign
node scripts/probe-assign-raw-json.js <email> <courseId> <cmid>   # apuntando a un assign concreto
```

**Qué decide el resultado:**
- ¿Hay `attemptnumber`/`attempt` o `timemodified`? → **SÍ:** "reenviado" es derivable (intento > 1, o modificado después de calificar) → se diseña en Fase 3.
- ¿Solo está `reopened` sin contador de intento? → "reabierto" ≠ "reenviado"; decidir con el usuario si "reabierto" es suficiente como aproximación, o se descarta/posterga.
- ¿Aparece `submissionstatus="draft"` de verdad? → confirma que **Fase 1 (borrador)** es capturable directo del AJAX (si no, se usa el fallback DOM, que sí lee literal "Borrador (no enviado)").

> **Gate:** Fase 3 (reenviado) NO se planifica en detalle hasta tener la salida del probe. Fases 1 y 2 no dependen del probe (pero el probe confirma el dato de borrador).

---

## Fase 1 — Estado `borrador` (DISEÑO: columna `subestado`, NO inflar `estado`)

> **Decisión de diseño (29-jun, alineada con `docs/PLAN_NOTA_Y_PRODUCCION.md` Fase 6):** en vez de meter `borrador` dentro de `estado` (que obliga a tocar el motor de actas, conteos y tipos TS = alto riesgo), se agrega una **columna nueva `Entrega.subestado String?`** que guarda el `submissionstatus` crudo de Moodle (`draft`/`reopened`/`submitted`/`new`/`""`). El `estado` sigue siendo `pendiente`/`calificado`/`sin_entregar` (un borrador sigue siendo `pendiente` para el acta). La UI muestra la etiqueta fina "Borrador" cuando `subestado === "draft"`. **El motor de actas NO se toca.**

### Cambios exactos

**A) Schema — `prisma/schema.prisma` + migración**
- Añadir `subestado String?` al modelo `Entrega` (nullable, sin default). Migración `add_entrega_subestado` (snake_case, regla #6).

**B) Scraper — `scraper/evidencias.js`**
1. `estadoDesdeParticipante` (línea ~598-607): **NO cambiar la lógica de `estado`** (mantener el orden `requiregrading` primero — bug de reabierto, docstring 592-595). Que la función (o el worker) además exponga el `submissionstatus` crudo para guardarlo como `subestado`. Opción simple: el worker lee `p.submissionstatus` directo del participante (ya lo tiene en `evidenciasWorker.js:255-258`).
2. `revisarEntregas` (fallback DOM, ~146-159): capturar también el subestado (lee literal "Borrador (no enviado)"/"Reabierto") → mapear a `draft`/`reopened` para `subestado`, sin cambiar `estado`.

**C) Worker — `api/src/workers/evidenciasWorker.js`**
- Setear `entrega.subestado = p.submissionstatus` (AJAX) / derivado del DOM.
- Persistir `subestado` en el `createMany` (~456-463) y en el `update` (~478-490). Detectar cambio de subestado para el update.
- Overrides CSV (~426) y grader (~444): **dejarlos como están** (siguen fijando `estado="calificado"` si hay nota). El `subestado` es informativo y convive con la nota.
- Conteos (~494-496): NO hace falta cambiarlos (el `estado` sigue siendo 3). Opcional: contar `borradores` aparte para el resumen.

**D) Motor de actas — `api/src/lib/calificacion.js`**: **NO se toca.** (Ése es el punto del diseño `subestado`.)

**E) Frontend — `web/src/components/AprendicesPanel.tsx`**
- La entrega ahora trae `subestado?: string`. Mostrar badge **"Borrador"** (color ámbar, distinto del amarillo "pendiente") cuando `subestado === "draft"`, encima del estado base. El tipo TS de `estado` NO cambia (sigue cerrado a los 3).
- **Badge A/D (Fase 5 de PLAN_NOTA, se incluye aquí):** mostrar la `notaCualitativa` (`A`/`D`) cuando exista — ya se captura en DB, solo falta pintarla.

**F) Conteos de API y mensajes**
- `api/src/routes/evidencias.js`: incluir `subestado` en el payload de `GET /:evidenciaId/entregas` (~250) para que el front lo reciba. Conteos agregados NO cambian.
- `api/src/lib/mensajesMasivos.js`: sin cambios obligatorios (el `estado` sigue igual). Opcional: que `subestado="draft"` cuente como pendiente en filtros.

---

## Fase 2 — Foros: "pendiente de revisar" + quitar calificación en la app

**Decisión del usuario:** quitar los inputs de calificar foro; el foro solo muestra **"pendiente de revisar"** (hay post sin revisar) o **"revisado"**.

**Buena noticia (verificado):** `descubrirCalificacionesPendientesForo` (`scraper/foroRating.js:221-305`) ya marca a un aprendiz **pendiente si tiene ≥1 post sin calificar**. Un comentario nuevo = post nuevo sin rating → el aprendiz **ya aparece pendiente**. La idea del usuario es básicamente el comportamiento actual, reaprovechado. **No requiere scraping nuevo.**
- ⚠️ Límite real: NO se capturan timestamps de posts. "Nuevo *después* de calificar" se infiere por "post sin rating", no por fecha. (Si el usuario quisiera distinguir literalmente "comentó otra vez después de que ya lo califiqué", eso SÍ necesitaría capturar `timemodified` — fuera de alcance de esta fase; anotarlo como futuro.)

### Cambios exactos

**A) Frontend — `web/src/components/AprendicesPanel.tsx`** (el grueso del trabajo)
- Cuando `esForo` (`tipo === "forum"`, línea ~284): **ocultar los inputs de nota y el botón de guardar nota** del foro (~429-473).
- Mostrar etiqueta **"Pendiente de revisar"** (si el aprendiz está en `pendientesMoodle`) o **"Revisado"**, reemplazando el badge actual "Sin nota en Moodle" (~424-428).
- Mantener el botón **"Verificar en Moodle"** (~352-366) que dispara `foroDescubrir` (es lo que alimenta el estado).

**B) Backend (decisión: cuánto desactivar)**
- **Mínimo / recomendado:** dejar intactos el worker `foroRatingWorker.js`, la ruta `PATCH /api/evidencias/:id/foro/calificar` y `scraper/foroRating.js:calificarPostsForo` (no se borran, simplemente el front deja de invocarlos). Menos riesgo, reversible. → Es lo más alineado con "quitar inputs", sin romper nada.
- Opcional (más limpio, más adelante): marcar el endpoint de calificar foro como deprecado.

**C) Estado del foro en el scan**
- Revisar `revisarEntregasForo` (`scraper/evidencias.js:379-398`): hoy pone `calificado`/`pendiente`/`sin_entregar` según el `<select rating>`. Para coherencia visual, evaluar mapear el foro a `pendiente` (= "pendiente de revisar") cuando hay posts sin rating. **Cuidado:** no romper el conteo ni las actas. (Posiblemente la etiqueta "pendiente de revisar" sea puramente de UI sobre el estado `pendiente` ya existente — preferible, menos invasivo. Confirmar al implementar.)

> Nota: "pendiente de revisar" en foros puede ser **solo una etiqueta de UI** sobre el estado `pendiente` que ya existe, sin agregar un cuarto valor de `estado`. Eso reduce el blast radius de esta fase casi a solo-frontend. Decidir al implementar según cómo queden los conteos.

---

## Fase 3 — Estado `reenviado` (EN PAUSA — el probe confirmó que no hay dato)

El probe (29-jun) demostró que `mod_assign_list_participants` en SENA **NO trae** `attemptnumber`, `timemodified` ni `grade`/`gradingstatus`. El único campo "de intento" es `grantedextension` (prórroga, no reenvío). **No se puede detectar "reenviado" de forma fiable con el AJAX.**

Opciones futuras (con su costo):
- **DOM por assign** (`/mod/assign/view.php?id={cmid}&action=grading`): la tabla de grading sí muestra "Reenviado"/nº de intento, pero es una navegación pesada **por cada evidencia** → reintroduce el cuello de botella que §11 eliminó. Solo si el usuario lo prioriza explícitamente.
- **`subestado="reopened"`** (ya capturado en Fase 1): NO es "reenviado", es "reabierto" (el instructor habilitó otro intento). Podría mostrarse como etiqueta informativa "Reabierto" si se quiere, sin prometer que el alumno ya reenvió.

→ No se implementa ahora. Queda como mejora futura documentada.

---

## Blast radius (resumen — todo estado nuevo toca esto)

| Capa | Archivo | Riesgo |
|---|---|---|
| Scraper | `scraper/evidencias.js` (mapeo `estadoDesdeParticipante`, `revisarEntregas`) | bajo |
| Worker escribe + cuenta | `api/src/workers/evidenciasWorker.js:426,444,494-496` | **overrides fuerzan `calificado`; conteos solo cubren 3 estados** |
| **Motor de actas** ⚠️ | `api/src/lib/calificacion.js:35-44` + `calificacion.test.js` | **acta oficial GOR-F-084, crítico en prod** |
| Frontend | `web/src/components/AprendicesPanel.tsx` (tipo TS cerrado, labels, variants, filtros, counts) | medio — TS rompe si no se actualiza el union |
| Conteos API | `api/src/routes/evidencias.js` (3 endpoints) | medio |
| Mensajes / filtros | `api/src/lib/mensajesMasivos.js` | medio |
| (solo foros) | `web/src/components/AprendicesPanel.tsx` rama `esForo`, `scraper/foroRating.js`, `api/src/routes/foroRating.js` | bajo (mayormente UI) |

---

## Orden de ejecución (con luz verde)
1. **Fase 0** — correr `scripts/probe-assign-raw-json.js`, leer la salida, decidir el camino de `reenviado`.
2. **Fase 1 (borrador)** + **Fase 2 (foros)** en ramas separadas (no tocar master directo). `node --check` a los `.js`, `cd web && npm run build` para validar TS.
3. Tests: actualizar `calificacion.test.js`; smoke en browser local (assign con borrador, foro con post sin revisar).
4. **Fase 3 (reenviado)** solo tras el probe.
5. Commits `feat:`/`fix:` por fase. Si la app ya está desplegada en el VPS, recordar **rebuild + redeploy** del front (igual que Plan 008).

## Riesgos / a verificar
- **Actas (GOR-F-084):** cambiar cómo `borrador` cuenta en `esPendiente`/`calcularEstado` puede mover juicios de aprendices. Validar con un acta real antes de mergear.
- **Overrides CSV/grader** pisan el estado del scraper → confirmar la precedencia deseada para borrador (recomendado: la nota del libro manda).
- **Tipo TS cerrado** en AprendicesPanel: olvidar actualizar el union rompe el build del front.
- **Conteos**: los agregados `pendientes/calificados/sinEntregar` en worker y rutas no contemplan estados nuevos → quedarían fuera del resumen si no se tocan.
- **Foros**: preferir "pendiente de revisar" como etiqueta de UI sobre el estado `pendiente` existente, para no inflar el blast radius con un cuarto valor de `estado`.
- **`foroRatingWorker.js`** escribe `estado:"calificado"` directo sin pasar por `HistorialEstado` (inconsistencia preexistente; no la arregla este plan, solo se anota).
- **Reenviado sin dato**: si el probe no encuentra señal de intento, ser honesto: no se puede prometer "reenviado" fiable sin lectura DOM por assign (lenta) — decisión del usuario.
