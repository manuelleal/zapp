# HANDOFF-ACTAS.md — Sprint Actas v2 (Refinado)

> Documento de sprint para el módulo de Actas de Seguimiento institucionales.
> Léelo COMPLETO antes de tocar cualquier archivo.
> **Última actualización: 17 mayo 2026 — Plan refinado post-análisis, listo para implementar.**

---

## Estado actual de la rama

- **Rama:** `feat/frontend-resilience-e2e`
- **Último commit:** `64feb0d` — feat(actas): CSV import GOR-F-084 V02 — Fase 1 completa

---

## Qué ya está construido (Fase 1 — commitada)

| Archivo | Qué hace |
|---------|----------|
| `scraper/csvParser.js` | Parser CSV Zajuna — 4 estados, detecta RAPs 240202501-{01..06}, 16 tests inline |
| `api/src/routes/actasImport.js` | POST /api/actas/import-csv/preview + /import-csv — **A REEMPLAZAR** |
| `api/src/routes/actas.js` | CRUD + auto-poblar (reescribir) + /download/gor-f-084 |
| `web/src/pages/ActasPage.tsx` | Lista + detalle + ImportCSVModal (eliminar modal) + tabla participantes |
| `prisma/schema.prisma` | `Aprendiz.documento`, `MensajeFormativo.templateTipo` |
| `prisma/migrations/20260517194723_*/` | Migración aplicada |

---

## ⚠️ DECISIONES DE DISEÑO — LEER ANTES DE IMPLEMENTAR

### 1. El CSV manual se ELIMINA
El `ImportCSVModal` y `actasImport.js` se crearon como atajo pero son trabajo manual innecesario.
El sistema ya tiene los datos: `Entrega` + `RapEvidenciaRel` + `MatchingPropuesta`.
**`auto-poblar` lee directamente de la DB.** El CSV se descarta.

### 2. Estados simplificados — 3, no 4 ni 5
| Estado | Condición |
|--------|-----------|
| `APROBÓ` | Todos los RAPs del acta tienen `notaActual > 0` en al menos una entrega |
| `PENDIENTE` | Tiene al menos una entrega en cualquier RAP del acta (pero no todos aprobados) |
| `NO PARTICIPÓ` | Cero entregas en todas las evidencias de todos los RAPs del acta |

Eliminar: `NO ASISTIÓ`, el `PENDIENTE` ambiguo anterior.

### 3. rapStatus — granularidad por RAP, editable por celda
`ActaParticipante.rapStatus` es un JSON `{ "240202501-04": "APROBÓ", "240202501-05": "PENDIENTE", "240202501-06": "NO PARTICIPÓ" }`.
- Auto-poblar calcula esto desde la DB
- La tabla del frontend muestra una **columna por RAP** (dinámica según los RAPs del acta)
- Cada celda tiene su propio dropdown editable (3 opciones)
- El juicio global se recalcula automáticamente desde rapStatus al guardar

### 4. Warning "evidencias sin calificar" — solo visual, nunca en Word
`Entrega.estado = "pendiente"` significa el aprendiz entregó pero el instructor NO ha calificado aún.
Si un aprendiz tiene eso en cualquier evidencia de los RAPs del acta → `hasUngraded = true`.
Aparece como badge ⚠ en la fila. Sirve para que el instructor corrija antes de cerrar el acta.

### 5. Aprendices "fantasma" — poder eliminarlos
El auto-poblar a veces trae filas inválidas (ej. `DQ`, `AU`, `VG` que son códigos/iniciales del CSV, no estudiantes reales). El instructor debe poder **eliminar un participante individual** del acta desde la tabla.

### 6. Notas/aclaraciones — campo adicional
Además de "Conclusiones" y "Compromisos", el acta necesita un campo **"Notas / Aclaraciones"** de texto libre. A veces hay cosas que no caben en conclusiones (ej. "Aprendiz X solicitó prórroga", "Grupo fue trasladado de jornada").

### 7. Archivar y eliminar actas
- **Eliminar**: cualquier estado (borrador o cerrada), con confirmación. Cascada borra participantes.
- **Archivar**: saca el acta de la vista principal. Toggle `archivadaAt`. `GET /api/actas?incluirArchivadas=1` para verlas.

---

## Schema — migración pendiente

### Archivo: `prisma/schema.prisma`

```prisma
model ActaSeguimiento {
  // ... campos existentes ...
  notas        String?    // NUEVO — campo libre "notas / aclaraciones"
  archivadaAt  DateTime?  // NUEVO — soft-archive
}

model ActaParticipante {
  // ... campos existentes ...
  rapStatus   Json?    // NUEVO — { "240202501-04": "APROBÓ", ... }
  hasUngraded Boolean  @default(false)  // NUEVO — warning calculado al auto-poblar
}
```

**Comando:**
```powershell
npx prisma migrate dev --name actas_rapstatus_archivo_notas
```

---

## Backend — orden de implementación

### Paso 1: Schema + migración
Archivo: `prisma/schema.prisma`
Añadir los 3 campos arriba. Migrar.

### Paso 2: DELETE y archive de actas
Archivo: `api/src/routes/actas.js`

**DELETE `/api/actas/:id`**
- Solo owner (`acta.userId === req.user.id`)
- Cualquier estado (borrador o cerrada)
- Borrar en cascada: primero `ActaParticipante`, luego `ActaSeguimiento`
- No usar `deleteMany` con cascade en Prisma — borrar en dos pasos explícitos

**PATCH `/api/actas/:id`** — agregar soporte `archivada: bool`
```js
if (typeof body.archivada === "boolean") {
  data.archivadaAt = body.archivada ? new Date() : null;
}
```

**GET `/api/actas`** — filtrar archivadas por defecto
```js
const incluirArchivadas = req.query.incluirArchivadas === "1";
where.archivadaAt = incluirArchivadas ? undefined : null;
```

### Paso 3: DELETE participante individual
Archivo: `api/src/routes/actas.js`

**DELETE `/api/actas/:id/participantes/:participanteId`**
- Verificar que `acta.userId === req.user.id`
- Verificar que `acta.estado === "borrador"` (no se puede modificar acta cerrada)
- `await prisma.actaParticipante.delete({ where: { id: req.params.participanteId } })`

### Paso 4: Reescribir auto-poblar (el más importante)
Archivo: `api/src/routes/actas.js` — función `auto-poblar`

**Lógica:**
```
1. Leer acta → rapIds (array de IDs de RAP)
2. Para cada rapId: buscar evidencias vinculadas en la ficha via:
   - RapEvidenciaRel (vínculos confirmados manualmente)
   - MatchingPropuesta(estado="aceptado") (vínculos IA aceptados)
   - UNIÓN de ambos, deduplicar por evidenciaId
3. Para cada aprendiz de la ficha (Aprendiz.fichaId = acta.fichaId):
   a. Para cada RAP: buscar Entrega del aprendiz en las evidencias de ese RAP
      - APROBÓ:       alguna entrega con (notaActual > 0 OR /aprobad|^A$/i.test(estado))
      - PENDIENTE:    tiene entregas pero ninguna aprobada
      - NO PARTICIPÓ: cero entregas para ese RAP
   b. rapStatus = { [rap.codigo]: estado, ... }
   c. juicio global:
      - todos APROBÓ → "APROBÓ"
      - todos NO PARTICIPÓ → "NO PARTICIPÓ"
      - resto → "PENDIENTE"
   d. hasUngraded: alguna entrega con estado="pendiente" (entregó, no calificado)
4. Upsert ActaParticipante con rapStatus + juicio + hasUngraded
5. Retornar { poblados, aprobaron, pendientes, noParticiparon, warnings }
```

**Query de referencia para las evidencias por RAP:**
```js
// Evidencias confirmadas manualmente
const relsConfirmadas = await prisma.rapEvidenciaRel.findMany({
  where: { rapId: { in: rapIds }, evidencia: { fichaId: acta.fichaId } },
  select: { rapId: true, evidenciaId: true },
});

// Evidencias por IA aceptadas
const relsIA = await prisma.matchingPropuesta.findMany({
  where: {
    rapId:   { in: rapIds },
    estado:  "aceptado",
    evidencia: { fichaId: acta.fichaId },
  },
  select: { rapId: true, evidenciaId: true },
});

// Mapa: rapId → Set<evidenciaId>
const mapaRapEvidencias = new Map();
for (const rel of [...relsConfirmadas, ...relsIA]) {
  if (!mapaRapEvidencias.has(rel.rapId)) mapaRapEvidencias.set(rel.rapId, new Set());
  mapaRapEvidencias.get(rel.rapId).add(rel.evidenciaId);
}
```

### Paso 5: Actualizar GET /api/actas/:id
Incluir en cada participante:
```js
participantes: {
  select: {
    id: true, aprendizId: true, juicio: true,
    rapStatus: true, hasUngraded: true,   // NUEVO
    aprendiz: { select: { nombre: true, moodleId: true } },
  },
  orderBy: { aprendiz: { nombre: "asc" } },
}
```

### Paso 6: Actualizar PATCH /api/actas/:id/participantes
Aceptar `rapStatus` además de `juicio`:
```js
for (const p of participantes) {
  await prisma.actaParticipante.upsert({
    where:  { actaId_aprendizId: { actaId, aprendizId: p.aprendizId } },
    create: { actaId, aprendizId: p.aprendizId, juicio: p.juicio, rapStatus: p.rapStatus ?? undefined },
    update: { juicio: p.juicio, rapStatus: p.rapStatus ?? undefined },
  });
}
```

### Paso 7: PATCH /api/actas/:id — aceptar `notas`
```js
if (typeof body.notas === "string") data.notas = body.notas;
```

### Paso 8: Actualizar GOR-F-084 Word
Archivo: `api/src/routes/actas.js` — endpoint `GET /:id/download/gor-f-084`
- La tabla de participantes ahora usa `rapStatus` para generar la columna "Estado"
- Formato de estado en Word: `"Aprobó"` / `"Evidencias pendientes (RAP 04, RAP 05)"` / `"No participó"`
- Añadir sección "Notas / Aclaraciones" después de Compromisos si `acta.notas` existe

---

## Frontend — orden de implementación

### Paso A: Actualizar tipos TypeScript
```tsx
interface ActaDetalle {
  // ...
  notas: string | null        // NUEVO
  archivadaAt: string | null  // NUEVO
  participantes: {
    id: string
    aprendizId: string
    juicio: "APROBÓ" | "PENDIENTE" | "NO PARTICIPÓ"
    rapStatus: Record<string, "APROBÓ" | "PENDIENTE" | "NO PARTICIPÓ"> | null  // NUEVO
    hasUngraded: boolean      // NUEVO
    aprendiz: { nombre: string; moodleId: string | null }
  }[]
}
```

### Paso B: Tabla dinámica de participantes
**Columnas = rapsInfo del acta (dinámico)**

```
| Nombre | RAP 04 | RAP 05 | RAP 06 | Juicio global | ⚠ |
```

- Celda de RAP: pill verde/amarillo/gris + dropdown editable (solo en borrador)
  - Verde `APROBÓ` / Amarillo `PENDIENTE` / Gris `NO PARTICIPÓ`
- Columna ⚠: si `hasUngraded` → badge naranja con tooltip "Tiene entregas sin calificar — revisar en Dashboard"
- Columna Juicio global: dropdown editable (3 opciones, solo borrador)
- **Botón ✕ eliminar** al final de la fila (solo borrador) — llama a `DELETE /api/actas/:id/participantes/:participanteId`

### Paso C: Eliminar ImportCSVModal
Quitar el componente `ImportCSVModal` y el botón "Importar CSV" del `ActaDetailPanel`.
(El `actasImport.js` queda en el backend por si se reactiva, pero sin botón en UI).

### Paso D: Sección Notas/Aclaraciones
Agregar en `ActaDetailPanel` una nueva sección entre Objetivo y Participantes:
- Textarea `notas` — guarda con el mismo botón de conclusiones o con su propio botón

### Paso E: Archivar y eliminar actas en la lista
En cada fila de acta:
- Botón `📦 Archivar` / `♻ Restaurar` → llama `PATCH /api/actas/:id {archivada: bool}`
- Botón `🗑 Eliminar` → confirmación → llama `DELETE /api/actas/:id`
- Toggle "Ver archivadas" en el header (como fichas)

### Paso F: Guardar rapStatus al guardar juicios
`guardarJuicios()` envía array con `{ aprendizId, juicio, rapStatus }` por participante.

---

## Archivos a tocar (resumen)

| Archivo | Operación |
|---------|-----------|
| `prisma/schema.prisma` | + 3 campos |
| `api/src/routes/actas.js` | Reescribir auto-poblar, + DELETE acta, + DELETE participante, + archive, + notas, + rapStatus en Word |
| `web/src/pages/ActasPage.tsx` | Tabla dinámica, delete participante, archivar/eliminar acta, notas, quitar ImportCSVModal |

**NO tocar:**
- `api/src/routes/actasImport.js` — dejar quieto (podría reactivarse), solo quitar el botón del frontend
- `scraper/csvParser.js` — dejar quieto (puede usarse en otras herramientas)

---

## Prompt para continuar en nueva sesión (copiar y pegar tal cual)

```
Contexto: proyecto Zajuna App en C:\zajuna rama feat/frontend-resilience-e2e.
Lee HANDOFF-ACTAS.md completo antes de tocar nada.

El sprint activo es "Actas v2 — rapStatus por RAP".
El plan completo con lógica, código de referencia y orden de pasos está en HANDOFF-ACTAS.md.

Resumen ejecutivo de lo que falta implementar (en orden):
1. Migración Prisma: ActaParticipante.rapStatus Json?, ActaParticipante.hasUngraded Boolean, ActaSeguimiento.notas String?, ActaSeguimiento.archivadaAt DateTime?
2. DELETE /api/actas/:id (cualquier estado, cascade participantes)
3. DELETE /api/actas/:id/participantes/:participanteId (solo borrador)
4. PATCH /api/actas/:id con archivada:bool + notas:string
5. GET /api/actas con filtro archivadaAt=null por defecto
6. Reescribir auto-poblar: lee RapEvidenciaRel + MatchingPropuesta(aceptado) → calcula rapStatus + juicio (3 estados) + hasUngraded por aprendiz
7. GET /api/actas/:id incluir rapStatus + hasUngraded en participantes
8. PATCH /api/actas/:id/participantes aceptar rapStatus
9. PATCH /api/actas/:id aceptar notas
10. Actualizar GOR-F-084 Word: columna Estado usa rapStatus, añade sección notas
11. Frontend ActasPage.tsx: tabla dinámica (columna por RAP), delete participante, archivar/eliminar acta, sección notas, quitar ImportCSVModal

Reglas:
- Back completo primero, luego front
- 3 estados exactos: APROBÓ / PENDIENTE / NO PARTICIPÓ (eliminar NO ASISTIÓ)
- rapStatus editable celda por celda en la tabla
- hasUngraded = badge warning visual únicamente, nunca en Word
- Smoke test con JWT real antes de cada commit
- Una migración, no varias

Arranca con el paso 1 (schema) y sigue en orden. No preguntes — el plan está en HANDOFF-ACTAS.md.
```

---

## Smoke test checklist (antes de cada commit)

```
[ ] npx prisma studio — verificar campos nuevos en las tablas
[ ] POST /api/actas/:id/auto-poblar — retorna poblados/aprobaron/pendientes/noParticiparon/warnings
[ ] GET /api/actas/:id — participantes tienen rapStatus y hasUngraded
[ ] DELETE /api/actas/:id/participantes/:id — borra la fila de la tabla en UI
[ ] DELETE /api/actas/:id — desaparece de la lista
[ ] PATCH archivada:true → no aparece en lista; ?incluirArchivadas=1 → sí aparece
[ ] Tabla de participantes muestra columnas dinámicas según rapsInfo del acta
[ ] Celda RAP editable → guardar juicios → persiste en DB
[ ] Badge ⚠ aparece para aprendices con hasUngraded=true
[ ] Download GOR-F-084 — columna Estado refleja rapStatus
```
