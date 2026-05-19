# Handoff — Ingeniería inversa Extension Z + Plan de implementación

## Estado: ✅ Análisis completo | ✅ Fase 1 implementada | 🔧 Fase 2 pendiente

---

## Qué encontramos (resumen ejecutivo)

Extension Z tiene su propio backend SaaS en `https://extensiont.tuyweb.com`.
Si ese servidor cae, la extensión deja de funcionar. **Nuestro proyecto no tiene esa dependencia.**

Reportes completos en `output/`:
- `output/agent1/FEATURE_MAP.md` — 11 features mapeadas al código fuente
- `output/agent2/REPORTE_V2_FLOW.md` — flujo completo del reporte V2 (9 pasos)
- `output/agent2/DATA_STRUCTURES.md` — esquemas de datos exactos
- `output/agent3/GAP_TABLE.md` — comparación feature × feature vs nuestro proyecto
- `output/agent3/SPRINT_BACKLOG.md` — backlog priorizado
- `output/agent3/REUSE.md` — selectores DOM + payloads AJAX listos para copiar

---

## Estado por rama (19 mayo 2026)

| Rama | Estado |
|---|---|
| `fix/hide-ia-matching` | ✅ mergeada — IA Matching comentado en Layout.tsx |
| `fix/mensajes-bugs` | ✅ mergeada |
| `fix/actas-autopoblar` | ✅ mergeada |
| `fix/email-grade-report` | ✅ mergeada — `obtenerMatriculados` usa grade report |
| `fix/grade-avsd` | ✅ mergeada — `esDesaprobada()` implementado |
| `fix/actas-autopoblar-v2` | ✅ mergeada — Rule 5, dedup, calcularEstado, per-rap-inferido |

---

## Hallazgo nuevo — CSV export Moodle (19 mayo 2026)

**Extension Z genera su Excel así:**
1. Scraping HTML del grade report → nombre + cédula + email + calificaciones (A/D/-)
2. Para celdas vacías (`-`): llama `mod_assign_list_participants` AJAX → distingue SC/SN/RV/BR
3. Mapea a colores Excel: verde=A, rojo=D/SC, amarillo=SN/RV/BR
4. Genera Excel client-side (en el browser del instructor)

**Nosotros podemos hacerlo mejor:** Moodle tiene un endpoint de exportación CSV oficial:
```
GET /grade/export/txt/index.php?id={courseId}
```
CSV incluye: `Nombre(s)`, `Apellido(s)`, `Nombre de usuario` (cédula+cc), `Correo electrónico`, calificación por evidencia (A/-).
**Opciones clave:** ✅ "Excluir usuarios suspendidos" | ✅ "Mostrar tipo: Letra"

**Formato real del CSV (confirmado en Zajuna, courseId=16327):**
```
Nombre(s),Apellido(s),"Nombre de usuario",Institución,Departamento,"Correo electrónico","Evidencia:... (Letra)"
"ESTEBAN ANDRES","BEDOYA ORDOÑEZ ",1096189936cc,,,bedoyaesteban201@gmail.com,A
```

**Ventaja sobre scraping HTML:** Un fetch autenticado reemplaza toda la lógica de `obtenerMatriculados`. Sin selectores frágiles. Sin nombres sucios. Cédula directa.

**Limitación:** `-` no distingue "no entregó" de "entregó sin calificar" → para eso sigue siendo necesario `mod_assign_list_participants` (P1-2).

---

## Cuentas suspendidas — causa raíz de nombres sucios

Extension Z excluye suspendidos en la exportación. Nosotros no lo hacemos en `obtenerMatriculados`.
Consecuencia: aprendices como "KAREN YULIETH HERRERA JARAMILLO" (suspendida) aparecen en nuestras actas pero no en el Excel de Extension Z.

**Fix inmediato** (una línea, rama `fix/skip-suspended-users`):
```js
// En obtenerMatriculados → page.evaluate() → loop de userRows:
if (row.querySelector('th.usersuspended')) return null;
```

---

## Plan de implementación actualizado

### ✅ Fase 1 — Completada

| Item | Estado |
|---|---|
| P1-4 — Fix email scraper (grade report) | ✅ |
| P1-1 — Distinguir A vs D | ✅ |
| fix/actas-autopoblar-v2 — nombres, dedup, estados | ✅ |
| syncParticipantesWorker — fallback por nombre, escribe moodleId | ✅ |
| canal=zajuna mensajes internos funcionando | ✅ |

### 🔧 Pendientes inmediatos (esta semana)

**fix/skip-suspended-users** | Esfuerzo: XS | Modelo: Haiku
- Una línea en `obtenerMatriculados`: saltar filas con `th.usersuspended`
- Elimina cuentas suspendidas antes de que entren a DB

**fix/mensaje-template-vars** | Esfuerzo: S | Modelo: Sonnet
- `mensajeFormativoWorker.js` + `emailMasivoWorker.js`
- Reemplazar `{{nombre}}`, `{{ficha}}`, `{{instructor}}` por valores reales antes de enviar
- Leer `fichaId` y `userId` del `MensajeFormativo` para obtener ficha.codigo y user.nombre

### 🗓 Fase 2 — Próxima semana

**feat/csv-export-sync** | Esfuerzo: M | Modelo: Sonnet
- Reemplazar `obtenerMatriculados` con descarga del CSV oficial de Moodle
- Filtro suspendidos nativo, cédula, email, calificaciones A/-
- Poblar `Aprendiz.documento` (cédula) → habilita dedup exacto en DB

**P1-2 — mod_assign_list_participants** | Esfuerzo: M | Modelo: Sonnet
- Detectar BR/SN/RV por aprendiz
- Payload en `output/agent3/REUSE.md` sección "Moodle AJAX Calls"
- Requiere sesskey: `window.M?.cfg?.sesskey`

**P1-3 — lastaccess desde AJAX** | Esfuerzo: M | Modelo: Sonnet
- `core_grades_get_enrolled_users_for_selector` → `Aprendiz.ultimoAcceso`

### 📅 Fase 3 — Cuando actas esté estable en producción

**P1-5 — Excel con exceljs** | Esfuerzo: M | Modelo: Sonnet
- `GET /api/actas/:id/download/excel`
- Verde=APROBÓ / Amarillo=PENDIENTE / Rojo=NO PARTICIPÓ
- Mismo esquema que Extension Z pero 100% server-side, sin SaaS

---

## Ventajas del proyecto sobre Extension Z

1. Sin dependencia SaaS — todo self-hosted
2. PostgreSQL vs IndexedDB — multidispositivo, persistente
3. Word GOR-F-084 institucional — la extensión solo hace Excel
4. Workers BullMQ — async, la extensión bloquea el navegador 5-10 min
5. Multitenant — múltiples instructores en el mismo deploy
6. Auditoría e historial — la extensión no tiene logs
7. CSV export oficial → datos más limpios que scraping HTML
8. `mod_assign_list_participants` sin dirty state — Extension Z V1 deja Moodle sucio
