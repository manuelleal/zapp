# Auditoría de Release — 05. Capa de Datos + Estado Real de Features

> **Agente 5** · 2026-06-19 · App "Helper" (antes Zajuna) · `C:\zajuna` rama `master`
> Todo verificado contra DB real (Postgres `zajuna`@localhost:5432) y código. Read-only, sin modificar datos reales. Scripts temporales de consulta ya borrados.

## Resumen ejecutivo

| Área | Veredicto |
|---|---|
| Schema Prisma | ✅ Sólido. Índices "faltantes" de la memoria **ya están aplicados** (migración `20260610034612_add_indexes_criticos`). |
| Migraciones | ✅ `prisma migrate status` = "up to date", **sin drift**. 20 migraciones consistentes. |
| Integridad referencial | ✅ **0 huérfanos** en todas las FKs verificadas. |
| Multi-tenant a nivel datos | ✅ **0 cruces** entre usuarios. 4 users, todos con `competenciaId` seteado. |
| Aprendices duplicados sucios | ✅ **Ninguno** (el caso `ACADRIAN` vs `ADRIAN` de la memoria ya no existe en DB). |
| Dedup de evidencias | ✅ **0 duplicados por ficha** — confirma "dedup descartado" de la memoria. |

---

## 1. Tabla de conteos DB (2026-06-19)

| Tabla | Conteo | Notas |
|---|---:|---|
| User | 4 | 1 real (`ddiddimmo@gmail.com`) + 3 de prueba (`instructor*.test@zajuna.local`) |
| Ficha | 32 | — |
| Aprendiz | 294 | Bajó de 535 (limpieza); 0 duplicados sucios |
| Evidencia | 2437 | Subió de 2164 (más scans) |
| Entrega | 1670 | — |
| Competencia | 19 | — |
| RAP | 75 | — |
| RapEvidenciaRel | **2211** | Era 0 (bloqueante histórico) → desbloqueado. 2169 evidencias distintas vinculadas |
| MatchingPropuesta | 0 | El matching IA escribe directo en `RapEvidenciaRel`, no en esta tabla (tabla legacy del flujo "propone/acepta") |
| ActaSeguimiento | 10 | Todas en `borrador` (3 de prueba sin participantes + 7 con 47-51) |
| ActaParticipante | 345 | — |
| MensajeFormativo | 3 | 1 enviado OK, 2 en `error` |
| MensajeProgramado | 0 | Feature implementada, sin datos aún |
| Criterio | 5 | Solo del import de `raps.md` (Guía 01) |
| Job | 326 | — |
| ConfigCorreo | 1 | SMTP configurado para 1 instructor |
| EvidenciaConfig | 2755 | Cache `raw` de config de fechas |
| AIFeedback | 0 | Feature de feedback IA sin uso |
| HistorialEstado | 200 | — |

**Features con datos:** scan/evidencias, matching, actas, fichas, config correo.
**Features vacías (no rotas, sin uso):** MensajeProgramado, AIFeedback, MatchingPropuesta.

---

## 2. Estado de cada feature (smoke read-only)

### ACTAS — ✅ funciona
- Confirmado lo que reportó otra sesión: `RapEvidenciaRel=2211` desbloquea el flujo. 7 actas reales con 47-51 participantes poblados (`ActaParticipante=345`).
- `auto-poblar` y `preview-native` (`api/src/routes/actas.js:337` y `:1284`) **escopan correctamente** `RapEvidenciaRel`/`MatchingPropuesta` por `evidencia.fichaId` → un mismo código de evidencia repetido en varias fichas NO contamina entre fichas. Verificado.
- ⚠️ Menor: todas las actas están en `borrador` (ninguna `firmada`/`archivada`) — esperable, nadie ha cerrado el ciclo en datos reales. No es un bug.
- Formato oficial GOR-F-084 V02 presente (campos `ciudad`, `horaInicio/Fin`, `vocera`, etc. en schema, migración `20260618160218`).

### MENSAJES (masivos) — ⚠️ funciona con limitaciones
- Envío masivo Zajuna funciona: hay 1 `MensajeFormativo` `estado=enviado`.
- 🔴 **2 de 3 mensajes en `estado=error`** — uno con `templateTipo=null`. Causa raíz probable (no confirmada en vivo, requiere sesión SSO): sesión Moodle expirada al enviar, o destinatario sin `moodleId`. Vale revisar el `errorMsg` de esos registros antes del release; ratio de error 66% en datos reales es señal de fragilidad del canal Zajuna.

### MENSAJES (programados) — ⚠️ implementado, sin validar con datos
- Modelo `MensajeProgramado` completo y bien diseñado: guarda el **filtro** (no destinatarios), `proximaEjecucion` indexada, `pausadoAt` soft-state, tope anti-spam (`intervaloDias` mín 1). Migración `20260610221109` aplicada.
- `MensajeProgramado=0` → la feature **nunca se ha ejercido con datos reales**. Código presente pero sin smoke real. Recomendación: crear 1 programado de prueba y verificar que el tick repetible lo dispara antes del release.

### SCAN / EVIDENCIAS — ✅ funciona
- `Evidencia=2437`, `Entrega=1670`, `EvidenciaConfig=2755` — datos abundantes y crecientes (CAPA 1 + CAPA 2 AJAX commiteadas).
- 0 evidencias huérfanas (sin ficha), 0 entregas huérfanas (sin evidencia ni aprendiz).
- Cache `assignId`/`contextId`/`itemid` en schema (CAPA 2) presente.

### MATCHING IA RAP↔evidencia — ✅ funciona
- **Cobertura RAP: 66/75 RAPs** tienen ≥1 evidencia vinculada (88%).
- Las 19 competencias tienen RAPs en DB (3-6 c/u).
- Los 9 RAPs sin vínculo corresponden a competencias cuya guía no se ha extraído o casos puntuales (`240201528` mencionado en memoria con mismatch de formato).
- ⚠️ Nota: el matching escribe en `RapEvidenciaRel`, dejando `MatchingPropuesta` vacía. El flujo "IA propone → instructor acepta" (regla #8 del CLAUDE.md) **se está saltando** — el script `matchearCompetenciaIA.js` upserta directo sin pasar por aprobación del instructor. No es bug de datos, pero contradice la regla de diseño "la IA propone, el instructor decide". Revisar si es intencional.

---

## 3. Integridad multi-tenant (nivel datos)

Verificado por SQL raw:

| Chequeo | Resultado |
|---|---|
| `Entrega` sin `Evidencia` | 0 |
| `Entrega` sin `Aprendiz` | 0 |
| `Evidencia` sin `Ficha` | 0 |
| `RapEvidenciaRel` sin `Evidencia` | 0 |
| `ActaSeguimiento.userId != Ficha.userId` | **0** (sin cruce de tenant) |
| `MensajeFormativo.userId != Ficha.userId` | **0** (sin cruce de tenant) |
| Aprendices duplicados sucios (normalizando nombre por ficha) | **0** |
| Evidencias con mismo código canónico en la **misma ficha** | **0** |

**Datos de prueba a limpiar antes de producción:** 3 usuarios `instructor*.test@zajuna.local` y 4 actas `#SMK-*`/de prueba (con 49-51 participantes generados por los smoke tests). No afectan a producción pero ensucian conteos.

---

## 4. Índices / migraciones

**Sin drift. Sin índices faltantes.** La memoria (`faltan @@index([fichaId]) / @@index([userId])`) está **DESACTUALIZADA** — la migración `20260610034612_add_indexes_criticos` ya añadió todos los índices críticos:

- `Ficha(userId)`, `Job(userId)`, `MensajeProgramado(userId)`
- `Evidencia(fichaId)`, `Aprendiz(fichaId)`, `ActaSeguimiento(fichaId)`
- `Entrega(aprendizId)`, `HistorialEstado(entregaId)`
- `RapEvidenciaRel(rapId)` + `(evidenciaId)`, `MatchingPropuesta(rapId,estado)`
- `MensajeProgramado(proximaEjecucion)` (migración `20260610221109`)

### Índices opcionales sugeridos (no bloqueantes, baja prioridad)

`MensajeFormativo` se consulta por `userId` y por `fichaId` (historial, pestañas) y **no tiene índices** en esas FKs. Con solo 3 filas no importa hoy, pero al escalar:

```prisma
model MensajeFormativo {
  // ...campos existentes...
  @@index([userId])
  @@index([fichaId])
}
```

`ConfigAudit` y `ConfigChangeJob` tampoco tienen índice en `userId`/`evidenciaId` (FKs sin índice en Postgres). Bajo volumen hoy; considerar si crecen:

```prisma
model ConfigAudit { @@index([userId]) @@index([evidenciaId]) }
model ConfigChangeJob { @@index([userId]) }
```

---

## 5. Riesgos de integridad / hallazgos

1. **🟡 66% de MensajeFormativo en error** (2/3). Investigar `errorMsg` — posible fragilidad del canal Zajuna (sesión SSO / `moodleId` faltante). Único hallazgo con olor a bug real.
2. **🟡 Regla #8 (IA propone, instructor decide) bypasseada** por el matching automático: `RapEvidenciaRel` se llena directo, `MatchingPropuesta=0`. Confirmar con el usuario si el auto-upsert es intencional para el release.
3. **🟢 9 RAPs (de 75) sin evidencia vinculada** — competencias con guías sin extraer. Limita actas de esas competencias (no rompe nada, corta con 422 controlado).
4. **🟢 Datos de prueba en DB** (3 users test + actas SMK-*). Limpiar antes de producción para no inflar métricas ni exponer cuentas test.
5. **🟢 FKs sin índice sin cobertura** (`MensajeFormativo`, `ConfigAudit`, `ConfigChangeJob`) — irrelevante al volumen actual, anotado para escala.

**Sin riesgos de integridad referencial ni multi-tenant a nivel datos.** La capa de datos está sólida para el release.
