# Plan 010 — Sistema de Ayuda/Onboarding + estados nuevos en Excel + registro sin competencia

> **Estado:** ✅ COMPLETADO en rama `feat/plan-010` (29-jun-2026), SIN desplegar (el usuario revisa el diff + texto legal antes de subir). Commits: `0264d51` (plan) · `4bb417b` (Excel) · `e07261c` (Ayuda+tour) · `c3b2fc1` (registro+legal). Verificado: build TS, motor de actas 29/29, Excel probado en vivo (5 borradores → "·BD"), auth revisado con lupa. ⚠️ Deploy: necesita `npm install` en web/ (dep nueva driver.js) + rebuild + pm2 restart; NO hay migración nueva. Texto legal = borrador, revisar con alguien calificado.
> **Decisiones tomadas con el usuario:**
> - Ayuda = **Página de Ayuda (guías escritas) + tour de bienvenida** la primera vez.
> - Lote = los **3 frentes**: Excel, Ayuda/onboarding, Registro sin competencia (plan 008 #1).
> - `reenviado` sigue EN PAUSA (el AJAX de SENA no trae el dato; probe del plan 009).
>
> **Hallazgo clave:** "conectar correo" y "llamados de atención" **YA están 100% implementados** (SMTP/Gmail/Outlook en Ajustes con `ConfigCorreo`+nodemailer; Mensajes con Compositor/Historial/Programados, filtros, plantillas, recurrencia). → Los "paso a paso" pedidos **no son features nuevas, son GUÍAS que las documentan** dentro de la app.

> **Orden de ejecución (menor→mayor riesgo):** Frente 2 (Excel) → Frente 1 (Ayuda) → Frente 3 (Registro).

---

## Frente 2 — Excel: estados nuevos (PRIMERO, cambio chico)

**Dónde:** `api/src/routes/fichas.js` (endpoint `GET /api/fichas/:id/reporte-excel`, exceljs). La construcción de cada celda de entrega está en **~líneas 350-385**; la leyenda en **~397-425**. `Entrega.subestado` ya está en DB (plan 009) y la query ya incluye las entregas — solo falta exponerlo.

**Cambios:**
1. Paleta `const C = {...}` (~227-235): +`draftBg/draftTx` (ámbar), +`foroPendBg/foroPendTx` (gris azulado). (Reenviado: ver nota.)
2. En el loop por aprendiz×evidencia (~356-361): leer `const sube = entrega ? String(entrega.subestado||"").toLowerCase() : null;`.
3. Antes del `if (!entrega)…` (~375): detectar
   - `esBorrador = sube === "draft"` → celda **"BD"** ámbar (es ADICIONAL: si además tiene nota, gana la nota; el BD se prioriza solo cuando NO hay nota — coherente con la UI donde borrador puede convivir con calificado, pero en una celda única priorizamos: nota > BD).
   - `esForoPend = ev.tipo === "forum" && est === "pendiente"` → celda **"FP"** gris.
   - **Reenviado:** NO hay dato fiable (igual que en la app). Si `sube === "reopened"`, mostrar **"RE"** como "Reabierto" (no "reenviado") — informativo. Documentarlo en la leyenda como "Reabierto".
4. Leyenda (~397-425): +filas BD (Borrador), RE (Reabierto), FP (Foro pendiente) con sus colores.

**Decisión de precedencia en la celda (única por aprendiz×evidencia):**
`sin escanear → NE → (con nota: A/D/num) → BD (borrador sin nota) → FP (foro pendiente) → PC (por calificar)`.
Así una entrega calificada se ve por su nota (lo importante para el acta) y el "BD/FP" aparece solo cuando aporta info (sin nota aún). Confirmar con el usuario si prefiere que BD/FP se vean SIEMPRE aunque haya nota.

**Riesgo:** bajo. Solo lectura de un campo ya existente + ramas nuevas en el if/else. No toca el acta ni la query.

---

## Frente 1 — Sistema de Ayuda + tour de bienvenida (lo NUEVO)

**Estado actual (verificado):** solo `web/src/components/WelcomeModal.tsx` (1 paso, aviso legal Ley 1581, se dispara con `User.aceptoTerminosAt==null` vía `Layout.tsx:62-69`). NO hay tour, página de ayuda, tooltips reales ni manual. Sin librerías de tour en `web/package.json`.

### 1A) Página de Ayuda (`/ayuda`)
- Nueva ruta `/ayuda` en `web/src/App.tsx` + entrada "Ayuda" en la navegación (donde estén los links del `Layout`).
- Página `web/src/pages/AyudaPage.tsx`: secciones colapsables, contenido en español, con pasos numerados. Secciones (documentan lo que YA existe):
  1. **Primeros pasos** (qué es una ficha, evidencia, RAP; flujo general).
  2. **Escanear una ficha** (descubrir evidencias → activar → re-scan; qué significan los estados/badges: Calificado, Pendiente, Sin entregar, **Borrador**, **A/D**, **Foro: Pendiente de revisar**).
  3. **Conectar tu correo** (paso a paso de Ajustes → Correo: proveedor Gmail/Outlook/Otro, contraseña de aplicación en Gmail, Probar conexión). ← documenta `AjustesPage.tsx:310-424`.
  4. **Llamados de atención (mensajes)** (Compositor: elegir ficha → filtros de destinatarios → evidencias para {{evidencias}} → plantilla/asunto/cuerpo con variables → enviar; y Programados recurrentes). ← documenta `MensajesPage.tsx`.
  5. **Generar actas** (flujo nativo GOR-F-084).
  6. **Cargar RAPs** (subir PDF → IA extrae).
- Contenido como datos (array de secciones) para mantenerlo fácil. Sin backend (estático en el front).

### 1B) Tour de bienvenida (primera vez)
- Librería: **driver.js** (~6kb, sin deps, framework-agnostic, resalta elementos reales). Alternativa rechazada: react-joyride (más pesado).
- Dispara la primera vez tras aceptar términos (o botón "Ver tutorial" en /ayuda para repetirlo).
- Pasos: resaltar nav (Dashboard, Mis Evidencias, Mensajes, Actas, Ajustes, Ayuda) con 1-2 líneas c/u. Termina invitando a /ayuda.
- **Persistencia de "ya vi el tour":** nuevo flag. Opciones: (a) `localStorage` (simple, suficiente), o (b) campo `User.tourVistoAt` en DB (sobrevive dispositivos). **Recomendado:** `localStorage` para no migrar DB por algo cosmético; el botón "Ver tutorial" en /ayuda lo re-dispara.
- Gotcha: los selectores del tour dependen de la UI; usar `data-tour="..."` en los elementos clave para no atarse a clases.

**Archivos:** `web/package.json` (+driver.js), `web/src/App.tsx` (+ruta), `Layout`/nav (+link Ayuda + atributos `data-tour`), `web/src/pages/AyudaPage.tsx` (nuevo), `web/src/lib/tour.ts` (nuevo, define pasos), disparo del tour en `Layout.tsx`.
**Riesgo:** bajo (aditivo, no toca backend ni lógica de negocio). Solo +1 dependencia liviana.

---

## Frente 3 — Registro sin competencia (plan 008 #1)

Ya está detallado en **`plans/008-registro-sin-competencia-y-traductor.md` (Problema 1)**. Resumen:
- **Backend** `api/src/routes/auth.js`: quitar `competenciaCodigo` de obligatorios; guardar `""`/`null` si no viene; búsqueda de competencia solo si llega código.
- **Backend** `api/src/routes/ajustes.js`: des-restringir `GET /api/competencias` (quitar gate superadmin) + nuevo `POST /api/ajustes/mi-competencia` (incluir `rol` en el JWT).
- **Frontend** `web/src/pages/Login.tsx`: quitar el `<select>` de competencia y el campo del POST.
- **Frontend** `web/src/pages/AjustesPage.tsx`: tarjeta "Mi competencia" (selector del catálogo) visible para no-superadmin; `onSuccess` re-setea auth.
- **UX:** que RAPs/Actas muestren "elegí tu competencia en Ajustes" en vez del 422 crudo (ver blast-radius en plan 008).
**Riesgo:** medio (toca registro/auth en prod). Va de ÚLTIMO y con prueba cuidadosa.

---

## Blast radius (resumen)
| Frente | Archivos | Riesgo |
|---|---|---|
| Excel | `api/src/routes/fichas.js` (celdas + leyenda) | bajo |
| Ayuda | `web/`: App.tsx, Layout/nav, AyudaPage.tsx (nuevo), lib/tour.ts (nuevo), package.json (+driver.js) | bajo (aditivo) |
| Registro | `api/src/routes/auth.js`, `ajustes.js`; `web/src/pages/Login.tsx`, `AjustesPage.tsx` | medio (auth en prod) |

## Pruebas (todas) — el usuario exige pruebas al límite
- `node --check` a los `.js` tocados; `node --test` (motor de actas debe seguir 29/29).
- `cd web && npm run build` (TS).
- Registro: probar registrar SIN competencia → entrar → Ajustes → elegir competencia → RAPs/actas se "encienden".
- Multi-tenant intacto en todo query.

## Deploy (cuando todo esté verde)
- Merge a master + push. En el VPS (`/opt/helper`): `git pull` → (sin migración nueva salvo que el tour use DB) → `cd web && npm run build` → `pm2 restart all`. Limpiar caché del navegador.
