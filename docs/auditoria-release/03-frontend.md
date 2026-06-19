# Auditoría de release — 03 · Frontend funcional (web/src)

> Agente 3. Área: `web/src/**` (pages, components, hooks, api client). Solo lectura.
> Fecha: 2026-06-19. App: "Helper" (ex-Zajuna).

## 0. Resultado del build

**NO SE PUDO EJECUTAR EL BUILD.** El entorno de este agente deniega `PowerShell`,
el `Bash` general y la invocación directa de `tsc`/`vite`. Solo se permitieron
comandos `node -e` puntuales de lectura. Por tanto:

- `npm run build` (= `tsc -b && vite build`) **no se corrió**. No hay output de
  errores TS/Vite que reportar.
- Lo que SÍ se verificó por análisis estático (abajo) cubre las causas más
  comunes de fallo de build: imports rotos, íconos inexistentes, endpoints
  fantasma y desajustes de shape.

**Verificaciones que reducen el riesgo de build roto (ejecutadas con `node -e`):**

| Check | Resultado |
|---|---|
| `node_modules` presente en `web/` | ✅ sí (build tiene deps) |
| `lucide-react` versión | `1.14.0` (instalada y resoluble) |
| 13 íconos lucide usados (LayoutDashboard, KeyRound, Loader2, Link, CheckCircle2, AlertCircle, etc.) | ✅ todos exportan |
| `tsconfig.app.json`: `strict:true`, `noUnusedLocals:false`, `noUnusedParameters:false` | locals/params sin usar NO rompen el build |

> **Acción requerida del humano:** correr `cd C:\zajuna\web; npm run build` en una
> terminal real y confirmar 0 errores antes de subir. El análisis estático es
> favorable, pero no sustituye la compilación TS real.

## 1. Flujos / endpoints — TODOS verificados contra `api/src/routes/*`

Se cruzaron todas las llamadas `/api/...` del front contra los handlers
registrados en el backend. **No hay endpoints fantasma.** Detalle de los no
triviales:

| Front | Endpoint | Backend |
|---|---|---|
| `MapeoAlVueloModal.tsx:29` | `GET /api/fichas/:fichaId/evidencias` | ✅ existe en `evidencias.js:32` (NO en fichas.js — está en otro archivo, OK) |
| `MapeoAlVueloModal.tsx:35` | `POST /api/raps/mapeo-lote` | ✅ `raps.js:199` |
| `ActasPage.tsx:190` | `POST /api/actas/preview-native` | ✅ `actas.js:1266` |
| `ActasPage.tsx:211` | `POST /api/actas/confirm-native` | ✅ `actas.js:1423` (body coincide: incl. GOR-F-084 ciudad/horaInicio/horaFin/direccionRegional/vocera) |
| `ActasPage.tsx:605` | `POST /api/actas/:id/auto-poblar` | ✅ `actas.js:315` |
| Mensajes (selector+programados) | `/api/mensajes/{aprendices,enviar-masivo,programados,programados/:id,sync-emails,historial}` | ✅ todos en `mensajes.js` |
| Scan | `/api/scan/{full,auto,status,progress}` | ✅ `scan.js` |
| Matching | `/api/matching/{iniciar,propuestas,historial,propuestas/:id}` | ✅ `matchingIa.js` |

### Shape de auto-poblar — CORRECTO (era la sospecha de la memoria)

El backend devuelve `{ poblados, aprobaron, pendientes, noParticiparon, warnings,
filtrados, evidenciasVinculadas, modo }` (`actas.js:508-517`). El front lee
exactamente esas claves (`ActasPage.tsx:604-622`), incluyendo `poblados` (NO
`participantesCount`) y `evidenciasVinculadas`. **No hay desajuste.** La nota de
memoria sobre `participantesCount` está desactualizada (ese campo es de otro
endpoint, `actas.js:274`).

## 2. Tabla de hallazgos

| Severidad | Archivo:línea | Problema | Fix sugerido |
|---|---|---|---|
| 🟡 Media | `MapeoAlVueloModal.tsx:27-31` | La query de evidencias de la ficha NO maneja `isError`. Si `GET /api/fichas/:id/evidencias` falla (p. ej. 500 o red), el modal queda **"Cargando evidencias de la ficha..." para siempre** (solo distingue loading vs lista). Falla en silencio. | Añadir `isError` de `useQuery` y mostrar banner de error + botón reintentar. |
| 🟢 Baja | `web/src/App.tsx:20-31` | Rutas sin guard de auth explícito; la protección depende de que `authFetch` redirija en 401 (`client.ts:36-39`). Una página sin fetch en mount mostraría layout vacío a un no-autenticado. Hoy todas fetchean, así que no se explota. | Opcional: `<RequireAuth>` wrapper que verifique JWT antes de render. |
| 🟢 Baja | `web/src/components/Layout.tsx:45` + `App.tsx:25` | `/matching` (MatchingIaPage) está oculto del nav a propósito pero sigue siendo ruteable por URL. Página huérfana, no rota. | Dejar como está (decisión documentada) o quitar la ruta si no se usará. |
| 🟢 Baja | `web/package.json:14` | `@anthropic-ai/sdk` listado como dep del FRONTEND pero **no se importa** en `web/src` (grep negativo). Bloat; si alguien lo usara en cliente expondría API key. | Quitar de `dependencies` del front. |
| 🟢 Baja | `web/package.json:23` | `lucide-react: ^1.14.0` — versión mayor atípica (la línea estándar es 0.x). Funciona (íconos resuelven), pero el `^1` podría traer breaking changes en `npm i` futuros. | Pinear versión exacta. |

## 3. Código muerto / duplicado

**Las afirmaciones de la memoria/CLAUDE.md están OBSOLETAS — ya se limpió:**

| Reclamo memoria | Realidad verificada |
|---|---|
| `EvidenciasModal` ~656 líneas muerto | ❌ **No existe** ningún `EvidenciasModal.tsx` en `web/src`. |
| `usePollJob` duplicado ×4 | ❌ Hay **un solo** `hooks/usePollJob.ts` (exporta `usePollJob` + `pollJobOnce`). Consolidado. |
| `actIdFromHref` ×3 | ❌ **0 ocurrencias** en `web/src`. |

**Componentes — todos en uso** (verificado por grep de imports):
`AprendicesPanel` (Dashboard), `BatchConfigModal`/`ConfigEvidenciaDialog`/
`ConfigTabla` (EvidenciasConfig), `MapeoAlVueloModal` (ActasPage), `ErrorBoundary`
(App), todos los `ui/*`. **No se encontró código muerto en el front.**

## 4. Estados de error/carga

- `client.ts` centraliza auth/401 (redirect a /login) y `ApiError` con status+data. Bien.
- **SSO expirada / tabla vacía silenciosa: YA CORREGIDO** en `ConfigTabla.tsx:217-221`
  (si `leidas===0 && fallidas>0` muestra banner rojo "la sesión de Zajuna pudo
  haber expirado"). Era un hallazgo de CLAUDE.md §14.4, ya resuelto.
- `ActasPage` maneja el 422 `RAP_SIN_EVIDENCIAS` abriendo `MapeoAlVueloModal`
  (`ActasPage.tsx:196-198`) — flujo de recuperación correcto.
- `<ErrorBoundary>` envuelve toda la app (`App.tsx:16`).
- **Único hueco:** la query de `MapeoAlVueloModal` (ver tabla §2, severidad media).

## 5. Multi-tenant en UI

Sin fugas detectables desde el front: el aislamiento se aplica en backend (todo
handler usa `req.user.id` / `verificarFichaDelUsuario` / `verificarActaDelUsuario`).
El front nunca envía `userId` ni lo usa para filtrar (no podría burlar el filtro).
JWT en `localStorage` ("zajuna_jwt") y enviado como Bearer. Correcto para este modelo.

## 6. Consistencia de marca (Helper vs Zajuna)

**La marca del producto es "Helper" de forma consistente:**
- `web/index.html:7` → `<title>Helper</title>` ✅
- `Layout.tsx:100` (header) y `Login.tsx:118` (brand) → "Helper" ✅

**Las menciones a "Zajuna" que quedan son CORRECTAS y deben quedarse**: se
refieren a la plataforma del SENA (zajuna.sena.edu.co) donde el instructor inicia
sesión — "Contraseña de Zajuna", "Buscar en Zajuna", "Mensaje interno Zajuna",
links a `zajuna.sena.edu.co`, clave `localStorage "zajuna_jwt"`. NO son nombre de
producto. No hay texto donde "Zajuna" debería decir "Helper".

## 7. Veredicto

**Condicionalmente listo para subir hoy**, con dos salvedades:

1. **BLOQUEANTE DE PROCESO:** este agente **no pudo ejecutar el build** (entorno
   sin shell). El humano DEBE correr `npm run build` en `web/` y confirmar 0
   errores TS/Vite antes de subir. El análisis estático no encontró nada que lo
   rompa (imports OK, íconos OK, endpoints OK, shapes OK), pero hay que compilar.
2. **No bloqueante:** corregir el estado de error de `MapeoAlVueloModal` (queda
   en "Cargando..." infinito si la query falla). Es un flujo secundario (solo se
   abre cuando faltan vínculos RAP↔evidencia), así que no impide el release, pero
   conviene arreglarlo pronto.

Lo demás (marca, endpoints, multi-tenant, código muerto, manejo de errores) está
**sano**. Las advertencias de la memoria sobre código muerto ya no aplican.
