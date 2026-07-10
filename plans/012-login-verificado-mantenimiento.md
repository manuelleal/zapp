# Plan 012 — Login verificado contra Moodle + mensaje claro de mantenimiento SENA

> **Estado:** implementado en rama `fix/login-verificado-mantenimiento` (10-jul-2026).
> **Disparador:** incidente del 9-10 jul 2026 — "no cargan las evidencias para modificar
> fechas" en producción. Diagnóstico completo en la memoria de la sesión y abajo.

## Contexto (incidente)

El SENA puso Zajuna en **mantenimiento del 11 al 13 de julio** (banner en el portal)
y desde el **9 de julio** el login del portal quedó roto: el formulario acepta
documento+clave pero el clic **no navega** y no muestra error. Consecuencia en la app:

- `scraper/auth.js login()` esperaba la navegación post-clic con
  `waitForFunction(...).catch(() => {})` — el timeout se **tragaba en silencio** y
  como la URL no tenía `?error=` ni había `.loginerrors`, reportaba
  **"Sesión iniciada ✓" en FALSO**.
- Todo lo que venía después corría con una sesión que Moodle no reconocía:
  `leerConfigLote` falló al 100% ("la sesión de Zajuna expiró o el modo edición no
  quedó activo... destino=portal http=200"), los scans leyeron "0 aprendices / 0
  filas en grader", etc. Histograma del error en el VPS: 1 el 30-jun, **150 el
  9-jul, 75 el 10-jul**.
- El instructor veía errores crípticos por evidencia, no la causa real.

Probe que lo demuestra (read-only, dejado en el repo): `scripts/probe-sso-fetch.js`
— login Chromium + `goto /my` + fetch con cookies; capturas `tmp-probe-*.png`.

## Causa raíz

`login()` no tiene **ground truth**: nunca verifica que Moodle haya establecido la
sesión. La única prueba real de login válido es que `${BASE_URL}/my/` NO rebote
(mismo chequeo que ya usa la factory para las sesiones guardadas —
`api/src/lib/esSesionValida.js`, fix del 18-jun).

## Cambio (1 archivo)

**`scraper/auth.js` — `login()`**: tras los chequeos actuales de credenciales,
navegar a `${BASE_URL}/my/` y validar con `esSesionValidaUrl()`:

1. Si `/my/` carga → `"Sesión iniciada ✓ (verificada en Moodle /my)"`. Beneficio
   colateral: el `storageState` que la factory guarda en Redis queda **con la
   cookie de Moodle ya establecida** (antes podía guardarse recién logueado en el
   portal, sin haber pisado Moodle).
2. Si rebota → buscar aviso de mantenimiento en el portal (innerText + `alt`/`title`
   de imágenes, regex `/mantenimiento/i`) y lanzar:
   - con aviso: `Zajuna está en mantenimiento del SENA ("…"). Reintenta cuando termine.`
   - sin aviso: `Zajuna no estableció la sesión tras el login (posible mantenimiento
     o cambio en el portal del SENA). Reintenta más tarde.`
3. Si `/my/` ni siquiera responde (timeout/red) → error claro equivalente.

El error es **normal** (no `UnrecoverableError`): BullMQ reintenta y, si persiste,
el job queda `error` con ese mensaje → la UI ya lo muestra (banner rojo de
ConfigTabla, estado de jobs). NO marca credenciales inválidas (eso sigue reservado
a `"Credenciales incorrectas."`).

## Blast radius (verificado con grep)

Callers de `login()`: `api/src/lib/playwrightSession.js` (factory → TODOS los
workers), `scraper/fichas.js:386`, `scraper/extractGuiaRaps.js:150`,
`scripts/extraerGuiasDesdeZajuna.js`, `scraper/probes/*` (9 probes). Ninguno
depende de en qué página queda el browser tras `login()` (todos navegan explícito
después). Cambios de comportamiento:

- Login fresco tarda +2-5 s (una navegación extra a /my). Solo aplica a logins
  frescos; la reutilización de sesión de Redis no cambia.
- Donde antes había "éxito falso + scraping de ceros", ahora hay **fallo temprano
  con mensaje claro**. Es el comportamiento deseado (post-mortem 18-jun).
- `scraper/auth.js` ahora importa `api/src/lib/esSesionValida.js` (función pura,
  sin dependencias — no hay ciclo). Única fuente de verdad del chequeo.

## Pruebas

- `node --check` de los archivos tocados.
- Suite existente (`npm test`) verde.
- **Prueba E2E del camino de fallo contra el portal REAL en mantenimiento**
  (10-jul): `login()` ya NO reporta éxito falso; lanza el error claro. ✅
- ⚠️ El camino de ÉXITO no se puede probar hasta que Zajuna vuelva (~14-jul).
  Al volver: `node scripts/probe-sso-fetch.js` y un scan real deben pasar.

## Fuera de alcance (anotado para después)

- Detección de sesión muerta **a mitad de scan** (lecturas de 0 filas con la
  sesión ya establecida). Hoy no destruye datos (verificado: con 0 lecturas no se
  escribe nada, solo queda stale), pero el scan "termina OK" sin avisar.
- Banner proactivo en la UI ("Zajuna está en mantenimiento") antes de encolar jobs.
