# HANDOFF-ACTAS.md — Sprint Actas GOR-F-084 V02 + Mensajería Inteligente

> Documento de sprint para el módulo de Actas de Seguimiento institucionales.
> Léelo completo antes de tocar cualquier archivo. Última actualización: **17 mayo 2026**.
>
> El HANDOFF.md principal cubre Config Evidencias (M1-M6). Este cubre Actas.

---

## 🎯 Objetivo del sprint

Convertir el módulo Actas de una herramienta genérica en un **generador de documentos institucionales GOR-F-084 V02** que:
1. Acepta el CSV de notas exportado desde Zajuna
2. Clasifica aprendices por estados de RAP (4 estados exactos)
3. Genera el Word oficial SENA con formato GOR-F-084 V02
4. Permite enviar mensajes formativos segmentados (con aprobación del instructor)
5. Mantiene archivo de mensajes como trazabilidad de "llamados de atención"

---

## 📁 Archivos de referencia en el repo raíz

| Archivo | Descripción |
|---------|-------------|
| `acta_03_ficha_3118548.pdf` | PDF de referencia — estructura GOR-F-084 V02 real |
| `AIPI ACTA 2 DE FORMACIÓN-INGLES.docx` | Ejemplo de acta Word institucional existente |

> ⚠️ El prompt del sprint menciona `acta_03_ficha_3118321.pdf` pero en el repo existe `acta_03_ficha_3118548.pdf`. Ambas fichas son reales; la 3118321 tiene los totales de referencia (37/5/17/15). La 3118548 es el PDF de ejemplo disponible en repo.

---

## 🗺️ Estado actual del módulo Actas (pre-sprint)

### Lo que YA existe y funciona

| Componente | Archivo | Estado |
|---|---|---|
| Tablas DB | `ActaSeguimiento`, `ActaParticipante`, `MensajeFormativo` | ✅ En producción (migración `20260517032341`) |
| CRUD actas | `api/src/routes/actas.js` | ✅ POST/GET/PATCH/cerrar + auto-poblar |
| Auto-poblar (3 estados) | `actas.js:202-294` | ⚠️ Funciona pero con 3 estados, no 4 |
| Descarga Word (genérica) | `actas.js:309-562` | ⚠️ Genera Word pero NO en formato GOR-F-084 V02 |
| Mensajería Zajuna | `api/src/routes/mensajes.js` + `mensajeFormativoWorker.js` | ✅ Envía mensajes internos Moodle via Playwright |
| Frontend completo | `web/src/pages/ActasPage.tsx` | ✅ Lista, detalle, participantes, Word download |
| Datos reales en DB | 2 actas, 138 participantes | ✅ Acta #2 ficha `3186684` con 138 aprendices |

### Gaps críticos confirmados por análisis

| Gap | Impacto | Archivo(s) afectado(s) |
|---|---|---|
| `Aprendiz.documento` no existe | No se puede guardar ni validar cédula del estudiante | `prisma/schema.prisma` |
| CSV import: NO existe | Sin CSV no hay parser, sin parser no hay GOR-F-084 | Nuevo: `scraper/csvParser.js`, `api/src/routes/actasImport.js` |
| GOR-F-084 V02 format: NO existe | El Word generado es genérico, no cumple formato SENA | `api/src/routes/actas.js` (nueva función paralela) |
| `juicio` solo soporta 3 valores | `"EVIDENCIAS PENDIENTES"` y `"NO PARTICIPÓ"` no existen | `actas.js:182` (`JUICIOS_VALIDOS`) + `auto-poblar` |
| Por-RAP grade tracking: NO existe | `auto-poblar` hace all-or-nothing, no detecta qué RAPs falta | Requiere lógica nueva en CSV parser |
| Templates mensajes: NO existen | Mensajes son texto libre, sin plantillas por estado | Nuevo: `api/src/lib/mensajeTemplates.js` |
| Exportar mensajes (CSV/PDF): NO existe | No hay trazabilidad descargable de llamados de atención | `api/src/routes/mensajes.js` (nuevo endpoint) |

---

## 📐 Reglas de negocio (GOR-F-084 V02)

### Clasificación de aprendices (4 estados — aplicar EN ORDEN)

RAPs en scope: **240202501-01** a **240202501-06** (inglés SENA)
Ignorar: actividades sin código 240202501, quizzes, borradores.

```
Regla 1: TODOS 6 RAPs = A  →  "Aprobó"            raps_aprobados: [01,02,03,04,05,06]
Regla 2: ALGUNOS RAPs = A  →  "Evidencias pendientes (RAP XX, RAP YY)"
                               raps_aprobados: [lista de A], raps_pendientes: [lista de faltantes]
Regla 3: NINGÚN RAP = A
         + tiene ALGÚN registro de actividad  →  "Evidencias pendientes (RAP 01-06)"
                                                  raps_aprobados: "Ninguno"
Regla 4: SIN NINGÚN registro de actividad    →  "No participó"
                                                  raps_aprobados: "Ninguno"
```

> Distinción crítica Regla 3 vs 4: alguien que intentó y falló todo = "Evidencias pendientes", NO "No participó".

### Filtro de filas válidas del CSV

Una fila del CSV es válida si tiene AMBOS:
- **Nombre completo:** mínimo 2 palabras con espacio. Rechazar iniciales solas (YZ, LP, MS...).
- **Documento:** string numérico, 7-10 dígitos (cédula colombiana).

Las filas inválidas se descartan silenciosamente. NO afectan los totales.

### Tabla resumen (obligatoria en GOR-F-084 V02)

| Total aprendices | Aprobó | Evidencias pendientes | No participó |
| N | N | N | N |

Validación hard: `Aprobó + Pendientes + No participó === Total`. Fallar si no cuadra.

### Warning count (llamados de atención)

- Fuente: tabla `MensajeFormativo` — se cuenta cuántos mensajes tiene cada aprendiz en `destinatarios` JSON con `estado = "enviado"`.
- Se muestra en la sección NOTA del acta: "tuvo 3 llamados de atención por plataforma".
- Query:
  ```sql
  SELECT elem->>'aprendizId' AS aprendiz_id, COUNT(*) AS warning_count
  FROM mensaje_formativo, jsonb_array_elements(destinatarios) AS elem
  WHERE ficha_id = $1 AND estado = 'enviado'
  GROUP BY aprendiz_id
  ```
- Usar `prisma.$queryRaw` — no requiere cambio de schema.

---

## 🏗️ Plan de implementación

### Phase 0 — Leer antes de tocar (1 día) — HACER PRIMERO

**Exit criteria:** Poder describir los 3 bugs sin mirar el código.

```
☐ 1. Leer acta_03_ficha_3118548.pdf → mapear columnas GOR-F-084 V02 a campos de la app
☐ 2. Leer AIPI ACTA 2 DE FORMACIÓN-INGLES.docx → confirmar estructura header SENA
☐ 3. Correr auto-poblar en el acta real (ficha 3186684) y comparar totales con expected
☐ 4. Identificar los 3 bugs por comparación: qué produce el sistema vs. qué debería producir
☐ 5. Documentar los 3 bugs aquí antes de escribir una línea
```

**Bugs esperados (hipótesis — confirmar en Phase 0):**
1. `auto-poblar` usa 3 estados (`APROBÓ/PENDIENTE/NO ASISTIÓ`) en vez de 4 (`APROBÓ/EVIDENCIAS PENDIENTES/NO PARTICIPÓ`) — la distinción Regla 3 vs 4 está perdida
2. El download Word no tiene formato GOR-F-084 V02 (sin header SENA, sin tabla resumen de 4 columnas, sin campo documento)
3. Los totales son incorrectos porque no hay filtro de filas válidas (iniciales, documentos inválidos inflatan el conteo)

---

### Phase 1 — Fix acta generation (3-4 días)

**Pre-requisito:** Phase 0 exit criteria cumplidos.

#### Tarea 1.1 — Migración schema (30 min)

```
Archivo: prisma/schema.prisma
Cambios:
  - Aprendiz: agregar  documento String?
  - MensajeFormativo: agregar  templateTipo String?  (preparar Phase 2)
Migración: npx prisma migrate dev --name aprendiz_documento_mensaje_template
```

#### Tarea 1.2 — CSV parser puro (medio día)

```
Archivo nuevo: scraper/csvParser.js
Exports:
  parsearCSVActa(csvText: string) → [{ nombre, documento, estado, rapsAprobados, rapsPendientes, warningCount }]

Lógica:
  1. Parsear CSV manual (split \n, split ,) — no instalar dependencia nueva
  2. Detectar columnas por header: "Nombre completo", "Número de documento", "240202501-01", ..., "240202501-06"
  3. Filtrar filas inválidas (nombre < 2 palabras, documento no 7-10 dígitos)
  4. Por cada fila válida: aplicar las 4 reglas de clasificación en orden
  5. Retornar array clasificado

Tests inline (al final del archivo, protegidos por require.main === module):
  - Aprobó total: nombre="JUAN JOSE SIERRA ORTEGA" doc="1092647286" todos A → estado="Aprobó"
  - Parcial: 5 de 6 A → estado="Evidencias pendientes (RAP 06)"
  - 0 A + tiene registro → estado="Evidencias pendientes (RAP 01, 02, 03, 04, 05, 06)"
  - Sin registro → estado="No participó"
  - Fila inválida: nombre="YZ" → descartada, no en output
```

#### Tarea 1.3 — Endpoints CSV import (medio día)

```
Archivo nuevo: api/src/routes/actasImport.js

POST /api/actas/import-csv
  Body: multipart con campo "csv" (archivo) + "fichaId" (string)
  Acción: parsear CSV, retornar preview clasificado (NO escribe en DB)
  Response: { filas: [...clasificadas], resumen: { total, aprobaron, pendientes, noParticiparon } }

POST /api/actas/:id/import-csv
  Body: { filas: [...clasificadas desde preview] }
  Acción: upsert Aprendiz (con documento) + upsert ActaParticipante con juicio correcto
  Response: { importados: N }

Registrar en server.js: fastify.register(require("./routes/actasImport"))
```

#### Tarea 1.4 — Fix auto-poblar 4 estados (2 horas)

```
Archivo: api/src/routes/actas.js

Cambios:
  1. Línea 182: JUICIOS_VALIDOS → ["APROBÓ", "EVIDENCIAS PENDIENTES", "NO PARTICIPÓ", "PENDIENTE"]
     (mantener "PENDIENTE" por compatibilidad con actas existentes)
  2. auto-poblar (líneas 261-278): separar "NO ASISTIÓ" en dos casos:
     - Tiene entregas pero ninguna aprobada → "EVIDENCIAS PENDIENTES"
     - Sin ninguna entrega → "NO PARTICIPÓ"
  3. Actualizar contadores en respuesta: { aprobaron, evidenciasPendientes, noParticiparon, poblados }
```

#### Tarea 1.5 — Generador GOR-F-084 V02 (1 día)

```
Archivo: api/src/routes/actas.js

Nuevo endpoint: GET /api/actas/:id/download?format=gor-f-084
  - NO modificar el endpoint existente (download sin ?format sigue siendo genérico)
  - Nueva función generateGORF084(acta, participantes, rapsInfo, warningCounts)

Estructura GOR-F-084 V02 (mapear desde PDF de referencia):
  ┌─────────────────────────────────────────┐
  │  LOGO SENA  │  GOR-F-084 V02  │  FECHA  │  (header institucional)
  ├─────────────────────────────────────────┤
  │  REGIONAL / CENTRO / PROGRAMA / FICHA  │
  ├─────────────────────────────────────────┤
  │  ACTA DE SEGUIMIENTO N° [numero]        │
  │  Fecha: [fecha]  Hora: [hora]           │
  ├─────────────────────────────────────────┤
  │  OBJETIVO: [objetivo]                   │
  ├─────────────────────────────────────────┤
  │  RESULTADOS DE APRENDIZAJE: [RAPs]      │
  ├─────────────────────────────────────────┤
  │  Tabla participantes (por aprendiz):    │
  │  Nombre | Documento | Estado | RAPs     │
  ├─────────────────────────────────────────┤
  │  TABLA RESUMEN:                         │
  │  Total | Aprobó | Pendientes | No part. │
  ├─────────────────────────────────────────┤
  │  CONCLUSIONES: [texto]                  │
  ├─────────────────────────────────────────┤
  │  NOTA: [aprendices con llamados]        │
  ├─────────────────────────────────────────┤
  │  COMPROMISOS: tabla actividad/fecha/    │
  ├─────────────────────────────────────────┤
  │  FIRMA INSTRUCTOR                       │
  └─────────────────────────────────────────┘

WARNING: el campo documento requiere que los Aprendiz tengan `documento` poblado
(via CSV import). Si null → mostrar "—" en la tabla.
```

#### Tarea 1.6 — Validación contra PDF de referencia (2 horas)

```
Ejecutar con los datos de ficha 3118321 (si están disponibles en DB) o ficha 3186684:
  GET /api/actas/:id/download?format=gor-f-084
  Abrir el Word generado
  Comparar campo por campo contra el PDF de referencia

Para ficha 3118321: totales esperados = Total:37, Aprobó:5, Pendientes:17, NoParticipó:15
```

---

### Phase 2 — Mensajería inteligente (1-2 semanas)

**Pre-requisito:** Phase 1 completa y verificada.

#### Tarea 2.1 — Templates (medio día)

```
Archivo nuevo: api/src/lib/mensajeTemplates.js

Exports:
  TEMPLATES = {
    congratulation: {
      tipo: "congratulation",
      asunto: "Felicitaciones — Competencia Inglés aprobada",
      cuerpo: "Estimado/a {{nombre}}, nos complace informarle que ha aprobado
               satisfactoriamente todos los RAPs de la competencia de inglés.
               Queda a paz y salvo con esta evidencia. ¡Felicitaciones!"
    },
    reminder: {
      tipo: "reminder",
      asunto: "Aviso de evidencias pendientes — RAPs {{rapsPendientes}}",
      cuerpo: "Estimado/a {{nombre}}, le recordamos que tiene pendiente la entrega
               de evidencias para los RAPs {{rapsPendientes}}.
               Tiene plazo hasta el {{fechaLimite}} para regularizar su situación."
    },
    alert: {
      tipo: "alert",
      asunto: "Llamado de atención — Sin participación en evidencias",
      cuerpo: "Estimado/a {{nombre}}, a la fecha no registra participación en
               ninguna de las evidencias de la competencia de inglés.
               Por favor comuníquese con su instructor a la brevedad."
    }
  }

Función: interpolarTemplate(template, vars) → { asunto, cuerpo } con {{placeholders}} reemplazados
```

#### Tarea 2.2 — Endpoint templates + bulk segmentado (medio día)

```
Archivo: api/src/routes/mensajes.js

GET /api/mensajes/templates
  Response: array de templates disponibles

Modificar POST /api/mensajes:
  - Aceptar templateTipo String? en body
  - Si templateTipo presente: guardar en mensajeFormativo.templateTipo

POST /api/actas/:id/mensajes-segmento
  Body: { segmento: "aprobaron" | "pendientes" | "noParticiparon", templateTipo, asunto?, cuerpo?, canal }
  Acción:
    1. Leer participantes del acta con juicio correspondiente al segmento
    2. Si templateTipo → usar template, interpolar {{nombre}}, {{rapsPendientes}}, {{fechaLimite}}
    3. Crear MensajeFormativo con destinatarios filtrados
    4. Encolar en mensajesQueue (canal zajuna) o marcar enviado (canal manual)
    5. NUNCA enviar sin acción explícita del instructor (este endpoint ES la aprobación explícita)

Registrar endpoint en actas.js o en mensajes.js (preferir mensajes.js para cohesión)
```

#### Tarea 2.3 — UI: botón "Enviar mensaje a segmento" en ActaDetailPanel (medio día)

```
Archivo: web/src/pages/ActasPage.tsx

En ActaDetailPanel (sección Participantes):
  - Botón "📩 Mensajear pendientes" → abre MensajeSegmentoModal
  - Botón "📩 Mensajear sin participar" → abre MensajeSegmentoModal
  - Botón "🎉 Felicitar aprobados" → abre MensajeSegmentoModal

MensajeSegmentoModal (nuevo componente):
  - Muestra segmento seleccionado + N destinatarios
  - Selector de template (GET /api/mensajes/templates)
  - Preview del mensaje con un destinatario de ejemplo
  - Editor asunto/cuerpo (pre-relleno desde template, editable)
  - Selector canal (zajuna / manual)
  - Botón "Enviar" (requiere confirmación: "¿Enviar a N aprendices?")
```

#### Tarea 2.4 — Exportar archivo de mensajes (medio día)

```
Archivo: api/src/routes/mensajes.js

GET /api/mensajes/export?fichaId=X&format=csv
  - Query mensajeFormativo por fichaId, expandir destinatarios JSON
  - Generar CSV manual: destinatario,documento,ficha,asunto,estado,enviadoAt,templateTipo
  - response.header("Content-Type", "text/csv")
  - response.header("Content-Disposition", "attachment; filename=mensajes-ficha-X.csv")

GET /api/mensajes/export?fichaId=X&format=json
  - Mismo query, retornar JSON estructurado (más fácil para debugging)

Frontend: en ActasPage header → botón "⬇ Exportar mensajes" (solo visible si hay mensajes)
```

#### Tarea 2.5 — Fecha límite por evidencia para templates (2 horas)

```
Fuente: EvidenciaConfig.raw.duedate (ya en DB desde M1 del sprint Config Evidencias)
No requiere nuevo campo.

En mensajeTemplates.js: interpolarTemplate acepta { fechaLimite? }
En el endpoint mensajes-segmento: buscar EvidenciaConfig más reciente de la ficha,
  extraer raw.duedate, formatearlo como "viernes 23 de mayo" para el template.
```

---

### Phase 3 — Gestión autónoma del ciclo (FUTURO)

**Pre-requisito:** Phase 2 archivos de mensajes live con datos reales.
**No diseñar Phase 3 hasta que el schema de MensajeFormativo esté estable.**

Tareas tentativas:
1. Anuncios semanales auto-generados (proponer, instructor aprueba)
2. Recordatorios escalonados basados en EvidenciaConfig.raw.duedate
3. Sistema propone cuándo generar el acta; instructor decide

---

## 🚦 Reglas del sprint

1. **Phase 0 exit criteria = BLOQUEANTE.** No escribir código Phase 1 sin cumplirlos.
2. **Nunca auto-enviar mensajes.** El sistema propone; el instructor ejecuta.
3. **No modificar el endpoint `/download` existente.** Agregar `?format=gor-f-084` como variante.
4. **GOR-F-084 V02 = el PDF de referencia manda.** En caso de duda, copiar el formato exacto del PDF, no inventar.
5. **`zajuna-evidencias.js` no se toca** (regla global del proyecto).

---

## 🔧 Decisiones técnicas tomadas

| Decisión | Razón |
|---|---|
| CSV parser en `scraper/csvParser.js` (no en routes) | Permite unit-testing standalone (`node scraper/csvParser.js`) sin HTTP |
| No instalar `csv-parse` o PapaParse | CSV de Zajuna es simple, `split` manual evita una dependencia |
| Dos endpoints download (genérico vs GOR-F-084) | Backwards compat; las actas existentes no se rompen |
| Templates como constantes en código (no tabla DB) | Los 3 templates son estables, no necesitan UI de edición |
| Email channel: NO en Phase 2 | `nodemailer` no está instalado; Zajuna internal messages ya funciona; email requiere scraping de perfiles para obtener correos |
| Warning count via `prisma.$queryRaw` | JSON unnesting de `destinatarios`; no requiere migración |

---

## 📊 Schema actual relevante

```prisma
model ActaSeguimiento {
  id           String   @id @default(cuid())
  userId       String
  fichaId      String
  numero       String
  fecha        DateTime
  hora         String
  lugar        String
  objetivo     String
  conclusiones String?
  compromisos  Json?
  rapIds       Json      // IDs de RAP de la tabla RAP
  estado       String    @default("borrador")  // "borrador" | "cerrada"
  creadoAt     DateTime  @default(now())
  participantes ActaParticipante[]
  mensajes      MensajeFormativo[]
}

model ActaParticipante {
  id         String @id @default(cuid())
  actaId     String
  aprendizId String
  juicio     String   // actual: "APROBÓ|PENDIENTE|NO ASISTIÓ"
                      // target: "APROBÓ|EVIDENCIAS PENDIENTES|NO PARTICIPÓ"
  @@unique([actaId, aprendizId])
}

model Aprendiz {
  id       String  @id @default(cuid())
  fichaId  String
  nombre   String
  moodleId String?
  // GAP: falta  documento String?
}

model MensajeFormativo {
  id            String    @id @default(cuid())
  userId        String
  actaId        String?
  fichaId       String
  canal         String    // "zajuna" | "manual"
  asunto        String
  cuerpo        String
  destinatarios Json      // [{ aprendizId, nombre, moodleId }]
  enviadoAt     DateTime?
  estado        String    @default("pendiente")  // "pendiente|enviado|error"
  errorMsg      String?
  creadoAt      DateTime  @default(now())
  // GAP: falta  templateTipo String?
}
```

---

## 🗂️ Archivos a crear / modificar (checklist)

### Nuevos archivos
- [ ] `scraper/csvParser.js` — parser + clasificador puro
- [ ] `api/src/routes/actasImport.js` — endpoints import CSV
- [ ] `api/src/lib/mensajeTemplates.js` — templates + interpolador

### Archivos a modificar
- [ ] `prisma/schema.prisma` — `Aprendiz.documento`, `MensajeFormativo.templateTipo`
- [ ] `api/src/routes/actas.js` — GOR-F-084 download + fix auto-poblar 4 estados
- [ ] `api/src/routes/mensajes.js` — templates endpoint + export + mensajes-segmento
- [ ] `api/src/server.js` — register actasImport routes
- [ ] `web/src/pages/ActasPage.tsx` — botón segmento + modal mensaje + export button

### NO modificar
- `zajuna-evidencias.js` (regla global)
- El endpoint `GET /api/actas/:id/download` sin `?format` (mantener genérico)
- Los workers de mensajes existentes (ya funcionan)

---

## 📝 Notas operativas

- **Para correr el server:** `node api/src/server.js` (puerto 3000)
- **Para la DB:** `npx prisma studio` (explorar datos), `npx prisma migrate dev` (tras schema changes)
- **Para el frontend:** `cd web && npm run dev` (puerto 5173 con proxy → 3000)
- **Branch actual:** `feat/frontend-resilience-e2e` (a considerar si crear branch nueva para este sprint)
- **PDF de referencia:** `C:\zajuna\acta_03_ficha_3118548.pdf` — leer primero con un visor PDF
- **Acta real en DB:** id `cmp9r6vwk0001thhk4s8lb5gp`, ficha `3186684`, 138 participantes, 6 RAPs de inglés
