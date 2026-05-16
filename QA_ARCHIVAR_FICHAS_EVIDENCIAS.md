# QA: Archivar fichas + cerrar evidencias

Este archivo debe revisarse primero cuando se retome el feature `archivar fichas + cerrar evidencias` en otro chat o sesión.

## Contexto del feature

Rama esperada: `feature/archivar-fichas-evidencias`.

Stack:

- Backend: Fastify en `api/src/server.js`, puerto `3000`.
- DB: Prisma + Postgres.
- Redis/BullMQ para jobs.
- Scraping: Playwright.
- Frontend: vanilla JS/CSS en `public/`.
- Auth: JWT en `localStorage["zajuna_jwt"]`.

Modelos relevantes:

- `Ficha.archivedAt`: `null` significa activa; timestamp significa archivada.
- `Evidencia.cerradaAt`: `null` significa abierta; timestamp significa cerrada.

Endpoints relevantes:

- `PATCH /api/fichas/:id` con body `{ "archivada": boolean }`.
- `PATCH /api/evidencias/:id` con body `{ "cerrada": boolean }`.
- `GET /api/fichas` filtra archivadas por defecto.
- `GET /api/fichas?incluirArchivadas=1` incluye archivadas.
- `GET /api/fichas/:id/evidencias` filtra cerradas por defecto.
- `GET /api/fichas/:id/evidencias?incluirCerradas=1` incluye cerradas.

## Resultado QA ejecutado

Validado:

- Login funciona.
- Usuario `ddiddimmo@gmail.com` existe y tiene 15 fichas.
- `GET /api/fichas` requiere JWT y devuelve `401` sin token.
- Archivar ficha:
  - `PATCH /api/fichas/:id { archivada: true }` pone `archivedAt`.
  - La ficha desaparece de la lista default.
  - Reaparece con `?incluirArchivadas=1`.
  - `PATCH /api/fichas/:id { archivada: false }` restaura `archivedAt = null`.
- Cerrar evidencia manualmente:
  - `PATCH /api/evidencias/:id { cerrada: true }` pone `cerradaAt`.
  - Con toggle OFF/API default desaparece de la lista.
  - Con `?incluirCerradas=1` reaparece.
  - `PATCH /api/evidencias/:id { cerrada: false }` restaura `cerradaAt = null`.
- Validaciones de seguridad:
  - Ficha de otro usuario: `403`.
  - Ficha inexistente: `404`.
  - Body inválido `{ archivada: "si" }`: `400`.
  - Body vacío en evidencia: `400`.
  - Sin Authorization: `401`.

## Bugs / pendientes detectados

### 1. Regla ambigua o bug en auto-reapertura de evidencias

Archivo: `api/src/workers/evidenciasWorker.js`.

Zona aproximada: lógica de auto-cierre alrededor de la actualización de `cerradaAt`.

Comportamiento actual observado:

```js
const sinTrabajoPendiente = pendientes === 0 && sinEntregar === 0 && entregas.length > 0;
await prisma.evidencia.update({
  where: { id: evDb.id },
  data:  { cerradaAt: sinTrabajoPendiente ? (evDb.cerradaAt || new Date()) : null },
});
```

Problema:

- Si el instructor cierra manualmente una evidencia que aún tiene pendientes o sin entregar, el siguiente escaneo la reabre porque pone `cerradaAt = null`.
- Esto contradice la regla: “Preserva `cerradaAt` manual si ya estaba”.
- Pero también coincide con otra regla del plan QA: “auto-reapertura tiene precedencia”.

Antes de aplicar fix, confirmar regla de negocio final:

- Opción A: el cierre manual se debe preservar aunque haya pendientes.
- Opción B: el worker puede reabrir automáticamente si detecta pendientes/sin entregar.

Recomendación técnica si se elige Opción A:

- Agregar un campo para distinguir cierre manual vs automático, por ejemplo:
  - `Evidencia.cierreManualAt DateTime?`, o
  - `Evidencia.cierreOrigen String?` con valores `manual`/`auto`.
- Sin ese dato no se puede saber si `cerradaAt` fue manual o automático.

### 2. Badge “Sin escanear” no se muestra correctamente

Archivos:

- `api/src/routes/fichas.js`
- `public/app.js`

Problema:

- La UI tiene lógica para mostrar `Sin escanear` cuando `f.pendientes` no es número/null.
- Pero el backend devuelve `pendientes: 0` cuando una ficha no tiene evidencias/entregas escaneadas.
- Resultado: una ficha nunca escaneada puede aparecer como `Al día`.

Fix mínimo recomendado:

- En `GET /api/fichas`, devolver `pendientes: null` cuando no existan evidencias abiertas con entregas escaneadas.
- La UI ya soporta `null` y renderiza `Sin escanear`.

Criterio esperado:

- Sin escaneo real: badge gris `Sin escanear`.
- Escaneada y sin pendientes: badge verde `Al día`.
- Escaneada con pendientes: badge amarillo `N pendientes`.

### 3. Estado vacío cuando todas las fichas están archivadas

Archivos probables:

- `api/src/routes/fichas.js`
- `public/app.js`
- `public/index.html`

Problema UX:

- Si todas las fichas activas están archivadas y el toggle `Ver archivadas` está OFF, la tabla queda vacía.
- El backend ya devuelve `archivadasCount`, pero `public/app.js` actualmente llama `renderFichas(data.fichas || [])` y no usa `archivadasCount`.

Fix recomendado:

- Pasar `archivadasCount` a `renderFichas`.
- Si `fichas.length === 0 && archivadasCount > 0`, mostrar mensaje tipo:
  - “Todas tus fichas están archivadas. Activa ‘Ver archivadas’ para restaurarlas o revisarlas.”

## Checks que otro chat debe ejecutar primero

1. Verificar estado del entorno:

```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

2. Verificar backend:

```powershell
Invoke-WebRequest -Uri http://localhost:3000/api/fichas -UseBasicParsing
```

Esperado sin token: `401`.

3. Revisar cambios actuales:

```powershell
git status --short
```

Importante: antes de editar, confirmar si `api/src/workers/evidenciasWorker.js`, `public/app.js` o `public/style.css` ya tienen cambios locales del usuario.

4. Si se van a aplicar fixes, no sobrescribir cambios existentes sin revisar diff.

## Criterios de aceptación después de fixes

- `GET /api/fichas` distingue correctamente fichas no escaneadas vs al día.
- Toggle `Ver archivadas` sigue funcionando.
- Archivar/restaurar conserva seguridad por usuario.
- Cerrar/reabrir evidencias conserva seguridad por usuario.
- La regla final de auto-reapertura/cierre manual está implementada y cubierta por prueba manual/API.
- Si todas las fichas están archivadas, la UI no muestra un vacío confuso.

## Nota de QA

En la sesión QA anterior no se aplicaron cambios de código. Solo se ejecutaron pruebas API/DB y scripts temporales en `%TEMP%`, removidos al finalizar.
