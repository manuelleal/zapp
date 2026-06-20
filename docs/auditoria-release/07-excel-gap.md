# 07 — Brecha del reporte Excel vs. el Excel "bonito" (Extensión Z)

> Auditoría SOLO LECTURA (19 jun 2026). Objetivo: entender por qué el instructor
> dice que el Excel "NO descarga como el de la Extensión Z, con todas las cosas
> bonitas" y producir un plan de mejora. **No se modificó código.**

Fuentes verificadas:
- `api/src/routes/fichas.js` líneas 187–372 (ruta `GET /api/fichas/:id/reporte-excel`)
- `web/src/pages/Fichas.tsx` líneas 136–334 (`descargarReporte` + `ExcelModal`)
- `docs/MOODLE_REFERENCE.md` (ingeniería inversa de la Extensión Z)
- `prisma/schema.prisma` líneas 141–178 (modelos `Aprendiz` / `Entrega`)
- Muestra `.xlsx` encontrada en la raíz del repo: `C:\zajuna\3118532 - 10 de marzo de 2026.xlsx` (no abierta como binario)
- Memoria `project_excel_report.md`

---

## (a) Qué estilos/formato tiene HOY el Excel — con archivo:línea

Todo vive en `api/src/routes/fichas.js` dentro de la ruta `reporte-excel`. La generación es real y bastante completa; **NO es un Excel pelado**. Resumen exacto de lo que aplica:

**Estructura de la hoja "Reporte Zajuna"**
- 2 filas de cabecera + N columnas de evidencia:
  - **Fila 1 (RAPs):** `fichas.js:251-257` — fila "Resultados de Aprendizaje (RAP)", una celda por evidencia con los códigos de RAP vinculados (`ev.rapRels`), fondo indigo `FF4F46E5`, texto blanco bold size 9, centrado + `wrapText`.
  - **Fila 2 (encabezados):** `fichas.js:260-272` — `Aprendiz | Documento | <evidencias…> | Aprobadas`. Cada columna de evidencia se colorea **por tipo**: assign azul `FFE0E7FF`, quiz rosa `FFFCE7F3`, forum verde `FFD1FAE5` (`fichas.js:265-271`). Altura de fila fija 46 px, bold, `wrapText`.
- **Anchos de columna** (`fichas.js:274-277`): col 1 (Aprendiz)=32, col 2 (Documento)=16, evidencias=13 cada una, "Aprobadas"=11. **Fijos, no auto-ajustados al contenido.**
- **Freeze panes** (`fichas.js:278`): `xSplit:2, ySplit:2` → congela las 2 primeras columnas y las 2 primeras filas. ✅ Ya existe.
- **AutoFilter** (`fichas.js:279`): activado de fila 2, col 1 → col "Aprobadas". ✅
- **Bordes**: `borde` thin en las 4 caras, aplicado celda a celda en cabeceras y datos (`fichas.js:235`, usado en todo).

**Celdas de datos (por aprendiz × evidencia)** — `fichas.js:285-335`
- Lógica de estado con paleta propia (`fichas.js:227-234`):
  - **Sin entregar → "SE"**, fondo gris `FFE5E7EB`, texto gris.
  - **Por calificar → "PC ▸"** con **hipervínculo** al grader de Moodle (`fichas.js:312-314`), fondo amarillo `FFFEF08A`, texto azul subrayado. Si no hay cmid, "PC" sin link.
  - **Calificado**: muestra la cualitativa `A`/`D` o el número; fondo verde `FFBBF7D0` si aprueba (A o ≥70), rojo `FFFECACA` si no (`fichas.js:319-324`). El número se escribe **como número** (no texto) para que el COUNTIF funcione.
- **Hipervínculos al grader** (`urlCalificar`, `fichas.js:238-245`): construye URL por tipo (quiz→`report.php?mode=grading`, forum→`view.php`, assign→`view.php?action=grader&userid=`). **Esto la Extensión Z no lo tiene** (la Z opera en vivo dentro del navegador).

**Columna "Aprobadas" (resumen por fila)** — `fichas.js:327-334`
- Fórmula viva por aprendiz: `COUNTIF(rango,"A")+COUNTIF(rango,">=70")`. Cuenta cuántas evidencias aprobó. ✅ Hay resumen por aprendiz.

**Hoja "Leyenda"** — `fichas.js:337-363`
- Segunda hoja con tabla código→significado (A, D, 0-100, PC ▸, SE) coloreada igual que el reporte.
- "Última actualización de los datos" = `max(fechaScan)` de todas las entregas (`fichas.js:353-361`).
- Nota de colores por tipo y pie "Generado por Zajuna App + fecha".

**Nombre de archivo** (`fichas.js:366`): `Reporte_Avanzado_{codigo}_{YYYY-MM-DD}.xlsx`.

### Lo que HOY NO tiene (verificado por ausencia en el código)
- **Logo / marca SENA o "Helper"** embebido (sin `workbook.addImage`/`worksheet.addImage` en el archivo).
- **Anchos auto-ajustados** al contenido (son fijos; nombres largos de aprendiz/evidencia se truncan o desbordan).
- **Fila/columna de TOTALES o % de avance global** (hay "Aprobadas" por aprendiz, pero no una fila de totales por evidencia ni un % de avance del grupo).
- **Marca de aprendices suspendidos**: imposible hoy — el modelo `Aprendiz` (`schema.prisma:141-156`) **no tiene** campo de suspensión (`isSuspended`/`suspendedAt`). El dato existe en Moodle (`mod_assign_list_participants.isSuspended`, ver `MOODLE_REFERENCE.md:112`) pero **no se persiste**.
- **Conditional formatting nativo de Excel** (data bars / color scales): el coloreo es manual celda-a-celda, no `worksheet.addConditionalFormatting`. Funciona, pero no se recolorea si el usuario edita.
- **Título/banner superior** con nombre de ficha, programa e instructor (la hoja arranca directo en la fila de RAPs; no hay encabezado de documento institucional).
- **Filtro de suspendidos** en el reporte (config `includeSuspendedStudents` de la Z, `MOODLE_REFERENCE.md:112,270`).
- **Merge de celdas** para títulos de sección/agrupación visual por Guía dentro de la hoja (las evidencias van seguidas; solo se distinguen por color de tipo, no por bloque GA).

---

## (b) ¿La DESCARGA funciona o falla? — y por qué

**La descarga funciona; NO hay bug de descarga en el código actual.** Cadena verificada:

1. **Backend** (`fichas.js:365-371`): genera `workbook.xlsx.writeBuffer()` y responde con
   `Content-Disposition: attachment; filename=...` + `Content-Type:
   application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`. Correcto.
2. **Frontend** (`Fichas.tsx:139-158`): `descargarReporte` hace `fetch` con `Authorization: Bearer`,
   convierte a `res.blob()`, crea `URL.createObjectURL`, dispara `<a download>.click()` y revoca la
   URL. Patrón blob estándar y correcto (no usa `window.open`, así que el header Auth viaja bien).
   Maneja error con toast si `!res.ok`.

**Único modo de fallo conocido (no es bug de lógica):** la memoria `project_excel_report.md`
documenta que `exceljs` se cayó de `node_modules` en saltos de rama → el endpoint daba 500
`MODULE_NOT_FOUND` y el usuario interpretó "no me deja descargar". Mitigación: `npm install`.
No es un defecto del código del reporte.

**Conclusión (b):** la queja del instructor **no es un bug de descarga**, es **percepción de
diseño visual** ("se ve pobre vs. el de la Z"). Coincide con la memoria: "NO es bug de datos…
funciona. Falta PULIDO VISUAL".

---

## (c) Lista priorizada de "cosas bonitas" que faltan + CÓMO en exceljs

### P0 — Alto impacto visual, bajo esfuerzo (1–3 h)

1. **Banner/título institucional superior** (nombre ficha, programa, instructor, fecha).
   - `sheet.insertRow(1, [...])` o construir antes de las cabeceras; `sheet.mergeCells('A1:<lastCol>1')`,
     `cell.value`, `cell.font={bold,size:14,color blanco}`, `cell.fill=fill(C.rap)`, `alignment center`.
   - Ajustar luego los `ySplit`/índices de fila (hoy 2 → pasarían a 3-4). Cuidar los rangos de COUNTIF.

2. **Anchos auto-ajustados (autosize) en vez de fijos** (`fichas.js:274-277`).
   - exceljs no tiene autosize nativo; calcular el ancho como
     `Math.min(maxLen+2, 40)` recorriendo `column.eachCell(c => len = String(c.value).length)`.
   - Mantener mínimo 13 para evidencias; col Aprendiz hasta ~40. Quita el desborde de nombres largos.

3. **Fila de TOTALES por evidencia (resumen del grupo)** al final.
   - Última fila: por cada columna de evidencia, `{ formula: 'COUNTIF(C3:C<last>,"A")+COUNTIF(C3:C<last>,">=70")' }`
     y/o `% aprobado = aprobados/total`. Fondo `C.hdrFijo`, bold. Da el "avance del grupo" que pide la memoria.
   - Añadir también celda de **% avance global** del grupo (aprobadas / total celdas).

4. **Encabezados de evidencia más legibles**: hoy size 9 y wrap en 13 de ancho → apretados.
   - Subir altura de fila (ya 46) + considerar `textRotation: 45` en `headerEvi.alignment` para que
     los nombres largos quepan en columnas angostas (truco clásico de matrices anchas).

### P1 — Profesionalismo / marca (medio esfuerzo, 2–4 h)

5. **Logo SENA / "Helper" en el banner.**
   - `const id = workbook.addImage({ buffer: fs.readFileSync(logoPath), extension:'png' })` y
     `sheet.addImage(id, { tl:{col:0,row:0}, ext:{width:120,height:40} })`.
   - Requiere agregar un asset PNG al repo (p. ej. `web/public/logo.png` o `docs/assets/`). Decisión de producto.

6. **Agrupación visual por Guía (GA) con fila de sección o merge.**
   - Hoy las evidencias van seguidas distinguidas solo por color de tipo. Insertar una fila/celda
     "Guía N — <competencia>" con `mergeCells` sobre las columnas de esa guía, fondo `C.hdrFijo`.
   - Alternativa más barata: **column grouping/outline** — `sheet.getColumn(i).outlineLevel = 1` por guía
     para colapsar/expandir bloques (`sheet.properties.outlineLevelCol`).

7. **Conditional formatting nativo (se mantiene al editar).**
   - `sheet.addConditionalFormatting({ ref:'C3:<last>', rules:[{ type:'cellIs', operator:'greaterThanOrEqual', formulae:[70], style:{ fill: fill(C.okBg) } }, …] })`.
   - Complementa (no reemplaza) el coloreo manual; útil si el instructor edita notas en el archivo.

8. **`workbook` metadata** (creator, title, company) — `workbook.creator='Helper'; workbook.title=...`.
   Pulido invisible pero profesional (aparece en Propiedades del archivo).

### P2 — Requiere cambio de datos / schema (alto esfuerzo)

9. **Marca de aprendices suspendidos** (paridad real con la config `includeSuspendedStudents` de la Z).
   - **Bloqueado por schema**: `Aprendiz` no guarda suspensión (`schema.prisma:141-156`). Hay que:
     a) añadir `suspendidoAt DateTime?` (soft-state, regla #4) o `isSuspended Boolean`;
     b) poblarlo en el scan desde `mod_assign_list_participants.isSuspended` (el worker ya consume ese AJAX);
     c) en el Excel, tachar/atenuar la fila (`row.font={strike:true, color gris}`) o badge "Suspendido".
   - Hasta que (a)+(b) existan, esta "cosa bonita" NO se puede hacer. Documentar como dependencia.

10. **Hoja "Resumen" con gráficos.** exceljs **no genera charts nativos** (limitación de la librería).
    Si se quiere gráfico de barras de avance habría que migrar a otra lib o pre-renderizar imagen. Diferir.

---

## (d) Veredicto

- **NO hay bug de descarga.** El backend emite el buffer xlsx con headers correctos y el front lo
  baja por blob correctamente (`Fichas.tsx:139-158`, `fichas.js:365-371`). El único fallo histórico
  fue `exceljs` ausente de `node_modules` tras saltos de rama (→ 500), que se resuelve con `npm install`.
- **Es 100% pulido visual / percepción.** El reporte ya tiene mucho de lo "bonito" (paleta, freeze,
  autofilter, RAPs, colores por tipo, COUNTIF, hipervínculos al grader, hoja Leyenda — varias cosas
  que la Extensión Z **no** tiene). Lo que falta para que "se vea profesional" es: **banner/título +
  logo, anchos auto, fila de totales/% avance, y agrupación visual por guía** (P0–P1, todo en exceljs
  sin tocar datos). La única mejora bloqueada por datos es **marcar suspendidos** (P2, requiere campo
  nuevo en `Aprendiz` + poblarlo en el scan).
- **Recomendación de secuencia:** P0 (#1–#4) primero — máximo impacto visual por hora. Luego P1 (#5–#7).
  Dejar suspendidos (#9) para cuando se toque el schema/scan. Antes de cualquier cambio, conviene
  abrir la muestra `C:\zajuna\3118532 - 10 de marzo de 2026.xlsx` (es el formato de referencia que el
  instructor considera "bonito") para copiar su layout exacto — no se inspeccionó aquí por ser binario.

### Nota sobre `C:\zajuna-excel\` (§12 de CLAUDE.md)
No fue accesible en esta sesión (Bash/PowerShell denegados para inspeccionar git fuera del cwd).
Según CLAUDE.md §12 y §14.4 (verificado por el equipo el 9-jun): el commit "Z-Mejorado" `21205cb`
de ese checkout está **DETRÁS** de master — master ya contiene y supera ese Excel. **No hay nada que
mergear** de `zajuna-excel` respecto al reporte. El código auditado aquí (`fichas.js`) es la versión
buena, ya en master.
