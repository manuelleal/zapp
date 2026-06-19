# 04 — Diseño Visual + Mobile Responsive (AGENTE 4)

> Auditoría de release. Área: look & feel + responsive. **SOLO LECTURA + PROPUESTAS.** No se editó código fuente.
> Stack verificado: React 18 + Vite 5 + Tailwind 3 + shadcn/ui en `web/`. Build de producción: ✅ compila limpio (`npm run build`, 3.4s).

---

## 1. Diagnóstico del look actual

El diseño NO está "feo", está **consistente y sobrio** — una UI utilitaria tipo dashboard (tarjetas blancas, borde `gray-200`, fondo `gray-50`, acento `sena-green #00A650`, tipografía Inter). Las primitivas shadcn (`button`, `badge`, `input`, `dialog`) ya tienen estados `hover`/`focus-visible` correctos. Es honesto y legible. Dicho eso, hay puntos objetivos que lo hacen ver "amateur":

| # | Hallazgo | Evidencia | Severidad |
|---|---|---|---|
| D1 | **Densidad/tamaños de fuente inconsistentes.** Conviven `text-sm`, `text-xs`, `text-[11px]`, `text-[10px]` en la misma vista (tablas de Mensajes y Actas). Da sensación de apretado/desordenado. | `MensajesPage.tsx:591` (`text-[11px]`), `:512` (`text-[10px]`), tablas a `text-xs` | Media (cosmética) |
| D2 | **Jerarquía de títulos plana.** Los "H1" de página son `text-sm font-semibold` (igual que un label de sección). No hay un encabezado de página claro. Todo pesa lo mismo. | `MensajesPage.tsx:498`, `RapsPage.tsx:305`, `Fichas` no tiene título de página | Media |
| D3 | **Emojis como iconos en UI "seria".** 📋 📭 💬 ⚠️ ✕ mezclados con lucide-react. Para una herramienta institucional SENA se ve improvisado. | `Dashboard.tsx:247,310`, `Fichas.tsx:357,362`, `ActasPage.tsx:378,461` | Baja |
| D4 | **Sin sombras/elevación.** Todas las tarjetas usan solo `border`. Plano. Un `shadow-sm` sutil daría profundidad sin recargar. | global (`bg-white rounded-lg border border-gray-200`) | Baja (cosmética) |
| D5 | **Tablas apretadas verticalmente.** Filas a `py-1` / `py-1.5` con texto `text-xs`. Funciona en desktop, se siente comprimido. | `MensajesPage.tsx:667`, `ActasPage.tsx:895` | Baja |
| D6 | **Spinner de carga = texto "Cargando..."** plano en varias páginas en vez de un skeleton/spinner consistente. | `Dashboard.tsx:244`, `Fichas.tsx:354` | Baja |
| D7 | **Color de "primary" duplicado.** Existe `--primary: 145 100% 32%` (≈sena-green) en CSS *y* la clase literal `bg-sena-green`. Los botones mezclan ambos (`bg-primary` en `button.tsx` vs `bg-sena-green` hardcodeado en páginas). No es un bug visual hoy (son casi el mismo verde) pero es deuda. | `index.css:13` vs `tailwind.config.js:13` | Baja (deuda) |

**Veredicto del look:** sólido como base. Los problemas son de pulido, no estructurales.

---

## 2. Recomendación: ¿dejar o retocar para el release de HOY?

**RETOQUE MÍNIMO, no rediseño.** Para un release hoy:

- ✅ **SÍ aplicar:** los **fixes mobile** de la §3 (algunos son bugs reales de overflow, no cosmética) y 2-3 toques visuales de riesgo casi nulo (sombras suaves, jerarquía de título). Alto valor, riesgo bajo.
- 🚫 **NO tocar hoy:** unificar `bg-sena-green`→`bg-primary`, quitar emojis, normalizar todos los `text-[Npx]`. Son barridos amplios que tocan decenas de líneas → riesgo de regresión visual sin testear. Dejarlos para post-release.

La app **es vendible visualmente como está**. Lo único que *de verdad* urge antes de mostrarla en un teléfono son los overflows de tabla y el header que no colapsa (§3).

---

## 3. Mobile Responsive — Auditoría concreta

### 3.0 Hallazgo transversal #1 — El header/nav NO colapsa (afecta TODAS las páginas)

`Layout.tsx:103-120`: la barra de navegación es un `<nav class="flex items-center gap-1">` con 7 items. En `<sm` se ocultan las **etiquetas** (`hidden sm:inline`, línea 117) pero quedan los **7 iconos** en fila + logo + avatar + botón Salir. En un viewport de 360px eso es ~9 elementos en una sola fila de 56px de alto sin wrap → se aprietan/desbordan. **No hay menú hamburguesa.** Es el problema mobile #1.

### 3.1 Checklist mobile por pantalla

| Pantalla | Archivo | Estado | Detalle |
|---|---|---|---|
| **Login** | `Login.tsx` | ✅ | `max-w-md` centrado, `p-4`. El `grid-cols-2` (cédula/pass zajuna, :220) es aceptable en 360px. Sin problemas reales. |
| **Header/Nav** | `Layout.tsx` | 🔴 | Nav de 7 iconos sin colapsar (ver §3.0). Banners (jobs/creds) usan `truncate`/`flex-wrap` → OK. |
| **Dashboard** | `Dashboard.tsx` | 🟡 | Bien en general (`flex-wrap`, `truncate`, filtro con `overflow-x-auto`). Riesgo menor: fila de evidencia (`:283`) tiene nombre + badge + 2-3 botones en una fila `flex` sin wrap; con foro ("💬 N comentarios sin calificar") puede empujar fuera en 360px. |
| **Fichas** | `Fichas.tsx` | ✅ | Tablas envueltas en `overflow-x-auto` (`:198`, `:376`). Modales `Dialog` adaptan. OK. |
| **EvidenciasConfig** | `EvidenciasConfig.tsx` + `ConfigTabla.tsx` | ✅ | Toolbar `flex flex-col md:flex-row` (`:331`) y `flex-wrap`. Tabla de `ConfigTabla` en `overflow-x-auto` (`:346`). Barra de acción batch (`:685`) usa `flex-wrap`. OK. |
| **Actas (lista + detalle)** | `ActasPage.tsx` | 🟡 | Tablas de participantes/preview/compromisos sí tienen `overflow-x-auto` (`:385,:872,:1008`) ✅. Pero el **modal Nueva Acta** usa varios `grid-cols-2` SIN breakpoint (`:291,:302,:320`) → en 360px los pares fecha/hora quedan muy angostos. `max-w-2xl` + `p-6` fijo aprieta. 🟡 |
| **Mensajes** | `MensajesPage.tsx` | 🔴 | Layout en 2 columnas correctamente colapsa (`grid-cols-1 lg:grid-cols-2`, :529) ✅. **PERO** la tabla de destinatarios (6 columnas, `:644`) está en un div con solo `overflow-y-auto` y **sin `overflow-x-auto`** → desborda horizontalmente en mobile. Igual la tabla de **Historial** (`:783`) no tiene wrapper de scroll. 🔴 |
| **RAPs** | `RapsPage.tsx` | ✅ | Todo en cards con `flex-wrap`, `truncate`, `line-clamp-2`. Sin tablas. Excelente en mobile. |
| **Ajustes** | `AjustesPage.tsx` | ✅ (asumido) | Formularios con `Input w-full`. Sin tablas anchas. Bajo riesgo. |

Leyenda: ✅ OK · 🟡 aprieta pero usable · 🔴 se rompe (overflow/desborde).

---

## 4. Cambios propuestos (priorizados) — NO aplicados

> Cada propuesta indica `[VISUAL]`/`[MOBILE]` + riesgo. Verificadas contra el código real (archivo:línea).

### 🔴 P1 — Bugs mobile reales (aplicar hoy)

#### P1.1 [MOBILE · riesgo bajo] Header con menú colapsable
`Layout.tsx:103` — el nav no colapsa. **Opción mínima sin JS** (deja iconos pero permite wrap y scroll horizontal, evita el desborde):
```diff
- <nav className="flex items-center gap-1">
+ <nav className="flex items-center gap-1 overflow-x-auto max-w-[55vw] sm:max-w-none scrollbar-hide">
```
`scrollbar-hide` ya se usa en el repo (`Dashboard.tsx:217`), así que la utilidad existe. **Solución ideal (más trabajo, riesgo medio):** un `<Sheet>`/drawer hamburguesa en `<md`. Para HOY, la de una línea es suficiente y segura.

#### P1.2 [MOBILE · riesgo bajo] Tabla de destinatarios de Mensajes desborda
`MensajesPage.tsx:643` — el wrapper solo tiene scroll vertical:
```diff
- <div className="border border-gray-200 rounded-md max-h-96 overflow-y-auto">
+ <div className="border border-gray-200 rounded-md max-h-96 overflow-y-auto overflow-x-auto">
```

#### P1.3 [MOBILE · riesgo bajo] Tabla de Historial de Mensajes sin scroll-x
`MensajesPage.tsx:779` — la tarjeta envuelve el `<table>` con `overflow-hidden` (recorta, no scrollea):
```diff
- <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
+ <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
+   <div className="overflow-x-auto">
      ... <table className="w-full text-xs"> ...
+   </div>
  </div>
```
(envolver el `<table>` de `:783` en un `<div className="overflow-x-auto">`).

#### P1.4 [MOBILE · riesgo bajo] Modal Nueva Acta: grids fijos a 2 columnas
`ActasPage.tsx:291, 302, 320` — tres `grid grid-cols-2 gap-3`. Hacerlos responsivos:
```diff
- <div className="grid grid-cols-2 gap-3">
+ <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
```
(aplicar a las 3 ocurrencias). Mismo patrón opcional en `Fichas.tsx:403` y `Login.tsx:220`, aunque ahí aprieta menos.

#### P1.5 [MOBILE · riesgo bajo] Fila de evidencia del Dashboard puede desbordar
`Dashboard.tsx:283` — fila con muchos elementos sin permitir wrap:
```diff
- <div className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50">
+ <div className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50 flex-wrap sm:flex-nowrap">
```
Riesgo: muy bajo; en desktop `sm:flex-nowrap` mantiene el layout actual.

### 🟢 P2 — Toques visuales seguros (aplicar hoy si sobra tiempo)

#### P2.1 [VISUAL · riesgo muy bajo] Elevación sutil en tarjetas
Da profundidad sin recargar. Patrón repetido `bg-white rounded-lg border border-gray-200`. Añadir `shadow-sm`:
```diff
- className="bg-white rounded-lg border border-gray-200 p-4 ..."
+ className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 ..."
```
Aplica como mejora opcional en los contenedores de tarjeta de cada página (Dashboard `:168`, Fichas `:341`, Mensajes `:496,:531,:706`, RAPs `:301`). **Es cosmético y reversible.** No hacerlo en barrido masivo si no hay tiempo de revisar visualmente.

#### P2.2 [VISUAL · riesgo bajo] Jerarquía del título de página
Los "H1" son `text-sm`. Subirlos a `text-base font-semibold` (o `sm:text-lg`) da jerarquía sin romper layout. Ej. `MensajesPage.tsx:498`, `RapsPage.tsx:305`:
```diff
- <h1 className="text-sm font-semibold text-gray-900">Mensajería masiva</h1>
+ <h1 className="text-base font-semibold text-gray-900">Mensajería masiva</h1>
```
Riesgo bajo pero **verificar visualmente** que no rompe el `flex` del header de cada página.

#### P2.3 [VISUAL · riesgo muy bajo] Focus ring en `<select>` nativos
Varios `<select>` usan `focus:ring-1` mientras los `Input`/`Button` shadcn usan `focus-visible:ring-2`. Unificar a `focus-visible:ring-2 focus-visible:ring-ring` en los selects (`ActasPage.tsx:282`, `MensajesPage.tsx:541,730`) para consistencia de accesibilidad. Cosmético.

### 🔵 P3 — Post-release (NO hoy; barridos amplios)

- [VISUAL · riesgo medio] Unificar `bg-sena-green` → `bg-primary` (token ya existe en `index.css:13`). Toca ~40 líneas.
- [VISUAL · riesgo bajo] Reemplazar emojis (📋📭💬⚠️✕) por iconos lucide. Toca varias páginas.
- [VISUAL · riesgo bajo] Normalizar escala tipográfica: eliminar `text-[10px]`/`text-[11px]`, quedarse en `text-xs`/`text-sm`.
- [VISUAL] Skeletons de carga consistentes en vez de "Cargando..." plano.
- [PERF] Code-splitting: el bundle JS es 536 kB (>500 kB warning). `React.lazy` por ruta. No es visual pero mejora el primer pintado en mobile/3G.

---

## 5. Resumen ejecutivo

- **Look:** consistente y utilitario, no "feo". Problemas = pulido (densidad/jerarquía/emojis/sin sombras), no estructura. **Recomendación: retoque mínimo, no rediseño.**
- **Mobile:** la mayoría de páginas ya son responsive (tablas con `overflow-x-auto`, grids con breakpoints, `flex-wrap`, `truncate`). **RAPs, Fichas, EvidenciasConfig y Login están bien.** Tres focos rojos: **(1) header/nav de 7 iconos sin colapsar** (todas las páginas), **(2) tabla de destinatarios + historial en Mensajes sin scroll horizontal**, **(3) modal Nueva Acta con grids `grid-cols-2` fijos**.
- **Para HOY (bajo riesgo):** aplicar P1.1–P1.5 (fixes mobile, casi todos de 1 línea) y opcionalmente P2.1–P2.3 (cosmética segura). Dejar P3 para después.
- **Build:** ✅ compila sin errores.
