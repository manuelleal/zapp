# HANDOFF-ACTAS.md — Sprint Actas v2

> Documento de sprint para el módulo de Actas de Seguimiento institucionales.
> **Última actualización: 19 mayo 2026 — Sprint v2 COMPLETO + auto-poblar v2 mergeado.**

---

## Estado actual

- **Rama activa:** `feat/frontend-resilience-e2e`
- **Sprint v2:** ✅ completo y mergeado
- **Auto-poblar v2:** ✅ mergeado (fix/actas-autopoblar-v2, commit 3f01fea)
- **Pruebas en curso:** instructor probando en producción local

---

## Lo que está implementado y funcionando

| Feature | Estado |
|---------|--------|
| CRUD actas (crear, editar, eliminar, archivar) | ✅ |
| DELETE /api/actas/:id (cascade participantes) | ✅ |
| DELETE /api/actas/:id/participantes/:id | ✅ |
| PATCH archivada + notas | ✅ |
| GET /api/actas con filtro archivadaAt | ✅ |
| Auto-poblar v1 (per-RAP / global-fallback) | ✅ |
| rapStatus por RAP en ActaParticipante | ✅ |
| hasUngraded badge en tabla | ✅ |
| Descarga GOR-F-084 Word | ✅ |
| Import CSV (actasImport.js) | ✅ backend — sin botón UI (desactivado) |

### Auto-poblar v2 — mejoras mergeadas (19 mayo 2026)

| Mejora | Detalle |
|--------|---------|
| `esNombreValido` Rule 5 | Detecta prefijos de iniciales pegadas en nombres con espacio (ACADRIAN, JBJESSICA, MMMAURICIO) |
| Dedup por clave canónica | Agrupa duplicados (ACADRIAN = ADRIAN) por núcleo del primer token + apellidos. Gana quien tiene más entregas |
| `calcularEstado` fix | `sin_entregar` → NO PARTICIPÓ (antes era PENDIENTE — bug corregido) |
| Modo `per-rap-inferido` | Cuando RapEvidenciaRel está vacío, infiere GA{N} → RAP 240202501-0{N} por nombre de evidencia |

**Smoke test (ficha 3186683):** 8 APROBÓ / 48 NO PARTICIPÓ / 78 filtrados / 6 evidencias vinculadas / modo=per-rap-inferido ✅

---

## Decisiones de diseño vigentes

### Estados — 3 exactos
| Estado | Condición |
|--------|-----------|
| `APROBÓ` | `notaActual > 0` o `estado ∈ {calificado, aprobad*, a}` en al menos una entrega del RAP |
| `PENDIENTE` | `estado = "pendiente"` (entregó, instructor no calificó aún) |
| `NO PARTICIPÓ` | Sin entregas, o `sin_entregar`, o `estado ∈ {d, desaprobad*}` |

### rapStatus — JSON por RAP, editable celda por celda
```json
{ "240202501-04": "APROBÓ", "240202501-05": "PENDIENTE", "240202501-06": "NO PARTICIPÓ" }
```

### Modos de auto-poblar (en orden de prioridad)
1. `per-rap` — RapEvidenciaRel tiene datos explícitos
2. `per-rap-inferido` — RapEvidenciaRel vacío, se infiere por GA{N} en nombre de evidencia
3. `global-fallback` — sin evidencias vinculadas ni inferibles (caso degenerado)

---

## Problemas conocidos / pendientes

### Cuentas suspendidas en actas
**Síntoma:** Aprendices como "KAREN YULIETH HERRERA JARAMILLO" aparecen en el acta pero no en Extension Z.
**Causa:** Están suspendidas en Moodle. Extension Z excluye suspendidos; nosotros no filtramos en `obtenerMatriculados`.
**Fix pendiente:** En `scraper/evidencias.js → obtenerMatriculados`, agregar:
```js
if (row.querySelector('th.usersuspended')) return null;
```
**Rama sugerida:** `fix/skip-suspended-users` | Modelo: Haiku

### Template variables sin reemplazar en mensajes
**Síntoma:** Mensaje llega con `{{nombre}}`, `{{ficha}}`, `{{instructor}}` literales.
**Causa:** `mensajeFormativoWorker.js` y `emailMasivoWorker.js` envían `cuerpo` tal cual sin interpolar.
**Fix pendiente:** Antes de enviar a cada `dest`, reemplazar:
- `{{nombre}}` → `dest.nombre`
- `{{ficha}}` → ficha.codigo (join con Ficha por fichaId del MensajeFormativo)
- `{{instructor}}` → User.nombre (join por userId)
**Rama sugerida:** `fix/mensaje-template-vars` | Modelo: Sonnet

---

## Próxima mejora grande — CSV export Zajuna

**Descubrimiento (19 mayo 2026):** El endpoint de exportación del grade report de Moodle entrega un CSV limpio:
```
Nombre(s), Apellido(s), Nombre de usuario (cédula+cc), Correo electrónico, Evidencia:... (Letra)
```
Con opción "Excluir usuarios suspendidos" → elimina todos los nombres sucios en el origen.

**URL del form:** `/grade/export/txt/index.php?id={courseId}`
**Archivo a modificar:** `scraper/evidencias.js → obtenerMatriculados` + `syncParticipantesWorker.js`

**Qué resuelve:**
- Nombres limpios sin regex (Moodle los filtra)
- Cédula directa → dedup exacto (`documento` ya existe en `Aprendiz`)
- Email sin scraping HTML
- Calificaciones A/- por evidencia (complemento del auto-poblar)

**Nota:** `-` en el CSV no distingue "no entregó" de "entregó sin calificar". Para eso seguimos necesitando el scraping de entregas o `mod_assign_list_participants` AJAX (P1-2).

**Prioridad:** Después de confirmar estabilidad de actas en producción.
**Rama sugerida:** `feat/csv-export-sync` | Modelo: Sonnet

---

## Smoke test checklist

```
[ ] Auto-poblar → modo en respuesta (per-rap / per-rap-inferido / global-fallback)
[ ] Nombres sucios no aparecen en tabla de participantes
[ ] Duplicados (ACADRIAN = ADRIAN) → solo uno aparece
[ ] Estado PENDIENTE solo para quien entregó sin calificar
[ ] Estado NO PARTICIPÓ para sin_entregar / desaprobados
[ ] Cuentas suspendidas (KAREN) → aparecen todavía (fix pendiente)
[ ] Badge ⚠ en aprendices con hasUngraded
[ ] Celda RAP editable → persiste en DB
[ ] Download GOR-F-084 → columna Estado refleja rapStatus
[ ] DELETE participante → desaparece de tabla
[ ] Archivar acta → no aparece en lista principal
```
