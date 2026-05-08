# zajuna-nav.md — Ingeniería inversa de Extensión Z

Documentación extraída de `root.PiOpq-8m.js` y confirmada con pruebas reales.
Estado: ✅ = confirmado en producción | 🔍 = inferido del código | ⚠️ = pendiente verificar

---

## URLs y endpoints

### Constantes base
```
ZAJUNA = "https://zajuna.sena.edu.co/zajuna"
```

### Endpoints Moodle / Zajuna

| Método | URL | Estado | Uso |
|--------|-----|--------|-----|
| POST | `/lib/ajax/service.php?sesskey={k}&info=mod_assign_list_participants` | ✅ | Listar aprendices de una actividad |
| POST | `/lib/ajax/service.php?sesskey={k}&info=core_message_send_instant_messages` | ✅ | Enviar mensaje interno Moodle |
| GET | `/grade/report/grader/index.php?id={courseId}&perpage=0` | ✅ | Tabla de calificaciones completa |
| GET | `/mod/assign/view.php?id={id}&action=grading` | ✅ | Vista calificación masiva (DOM) |
| GET | `/mod/assign/view.php?id={id}&action=grader` | ✅ | Vista grader individual |
| GET | `/mod/assign/view.php?id={id}&action=grader&tsort=timesubmitted&tdir=3` | ✅ | Grader ordenado por fecha entrega |
| GET | `/user/profile.php?id={userId}` | ✅ | Perfil del instructor/estudiante |
| GET | `/course/view.php?id={courseId}` | ✅ | Vista del curso |
| GET | `/mod/forum/export.php?id={forumId}` | 🔍 | Exportar foros |
| GET | `/course/switchrole.php` | 🔍 | Cambiar rol en curso |

### WhatsApp (externo)
```
https://wa.me/{telefono}?text={encodeURIComponent(msg)}&app_absent=1
```
- `telefono` = número completo con código de país sin `+` (ej: `573001234567`)
- `app_absent=1` = abre WhatsApp Web si no tiene la app instalada

---

## Cómo obtener el sesskey

Tres métodos en cascada — usar el primero que funcione:

```javascript
// Método 1 — M.cfg (objeto global inyectado por Moodle en TODAS las páginas post-login)
window.M.cfg.sesskey

// Método 2 — input hidden en formularios
document.querySelector('input[name="sesskey"]').value

// Método 3 — link de logout (fallback confirmado ✅)
new URL(document.querySelector('a[data-title="logout,moodle"]').href)
  .searchParams.get("sesskey")
```

**Recomendación para Playwright:** usar Método 1 (`window.M.cfg.sesskey`) — siempre presente.

---

## Cómo obtener el ID Moodle del usuario

```javascript
// Desde el link de perfil en la barra superior
document.querySelector('a[href*="/user/profile.php?id="]').href
// → extraer id= con URLSearchParams o regex /[?&]id=(\d+)/

// Alternativa: atributo data-
document.querySelector('#change-user-select').dataset.currentuserid
```

---

## mod_assign_list_participants — Payload completo ✅

```javascript
// URL
POST /lib/ajax/service.php?sesskey={sesskey}&info=mod_assign_list_participants

// Headers
Content-Type: application/json

// Body
[{
  "index": 0,
  "methodname": "mod_assign_list_participants",
  "args": {
    "assignid": 12345,       // ID de la actividad (param id= de la URL)
    "groupid": 0,
    "filter": "",            // "" = todos | "requiregrading" = solo pendientes
    "skip": 0,
    "limit": 0,              // 0 = sin límite (todos)
    "onlyids": null,
    "includeenrolments": true,
    "tablesort": false
  }
}]

// Respuesta — campos clave por estudiante:
{
  "id": 12345,               // moodleUserId — usar para mensajes y calificación
  "fullname": "Juan Pérez",
  "email": "juan@sena.edu.co",
  "phone1": "3001234567",    // ⚠️ puede estar vacío
  "isSuspended": false,      // true = ignorar (estudiante suspendido)
  "lastaccess": 1715000000,  // timestamp — último acceso global
  "lastaccesscourse": 1715000000, // timestamp — último acceso al curso
  "requiregrading": true,    // true = entregó Y no tiene calificación
  "submitted": true,
  "submissionstatus": "submitted"
}
```

**Nota:** `isSuspended: true` → ignorar en reportes y notificaciones (config `includeSuspendedStudents`).

---

## core_message_send_instant_messages — Payload completo ✅

```javascript
// URL
POST /lib/ajax/service.php?sesskey={sesskey}&info=core_message_send_instant_messages

// Body
[{
  "index": 0,
  "methodname": "core_message_send_instant_messages",
  "args": {
    "messages": [{
      "touserid": 12345,           // moodleUserId del destinatario
      "text": "Buen día, ...",     // texto plano o HTML
      "textformat": 1              // 1 = HTML, 0 = texto plano
    }]
  }
}]

// Respuesta exitosa:
[{ "msgid": 98765 }]

// Respuesta con error:
[{ "msgid": -1, "errormessage": "..." }]
```

---

## Calificación masiva — vía DOM ✅

La calificación se hace desde la tabla en `/grade/report/grader/index.php`, no via AJAX.

```javascript
// 1. Navegar a la tabla completa del curso
GET /grade/report/grader/index.php?id={courseId}&perpage=0

// 2. Selector del input de calificación por estudiante e ítem
input[name="grade[{userid}][{itemid}]"]

// Ejemplo:
document.querySelector('input[name="grade[12345][678]"]').value = "A"

// 3. Moodle guarda al hacer submit del formulario de la página
// (no requiere AJAX separado)
```

**Sistema de calificación Zajuna:**
- **A** = Aprobado
- **D** = Desaprobado

**Selectores adicionales de la vista grading:**
```javascript
'form[data-region="grading-actions-form"]'
'span[class*="gradevalue"]'
'div[data-region="user-info"]'
'div[data-region="activity-dates"]'
```

---

## Teléfonos de aprendices

**No hay endpoint automático en Zajuna/Moodle.** El campo `phone1` de `mod_assign_list_participants` puede existir pero generalmente está vacío.

**Flujo real:**
1. El instructor carga los teléfonos manualmente (CSV o uno a uno)
2. Se almacenan en PostgreSQL **cifrados** con AES-256-GCM (mismo esquema que credenciales Zajuna)
3. Se asocian al `aprendizId` en la tabla `Aprendiz`

**Schema pendiente:** agregar campo `telefonoCifrado String?` a modelo `Aprendiz`.

---

## Sofía Plus — Reporte de juicios de evaluación

**No hay API.** El instructor descarga manualmente desde:
```
https://senasofiaplus.edu.co/sofia/ejecucionformacion/reportes/reporteJuiciosEvaluacion.faces
```

**Flujo de integración:**
1. Instructor descarga el archivo desde Sofía Plus
2. Sube el archivo al backend via `POST /api/sofia/upload`
3. El backend lo procesa y cruza datos con la DB (aprendices, estados, RAPs)

---

## Reportes Excel

**Librería:** `exceljs` — para reportes con formato (colores SENA, encabezados, anchos de columna).

**Plantillas de mensajes:** Handlebars con variables:
```
{{aprendiz}}    → nombre completo del aprendiz
{{evidencias}}  → lista de evidencias pendientes/desaprobadas
{{instructor}}  → nombre del instructor
{{ficha}}       → código de ficha
{{fecha}}       → fecha actual
```

---

## Selectores CSS clave

### Barra de navegación
```javascript
'#usernavigation'
'div[class="logininfo"]'
'div[class="logininfo"]>a'                          // Nombre instructor
'a[href*="/user/profile.php?id="]'                 // Link perfil → extrae userId
'a[data-title="logout,moodle"]'                    // Link logout → extrae sesskey (fallback)
'#change-user-select'  // attr: data-currentuserid
```

### Breadcrumb y curso
```javascript
'li.breadcrumb-item>a[title]'
'a[href*="/course/view.php?id="]'                  // → extrae courseId
'div[class="page-header-headings"]>h1'
'meta[name="keywords"]'
```

### Tabla de calificaciones
```javascript
'input[name="grade[{userid}][{itemid}]"]'          // Input de calificación
'input[name="sesskey"]'
```

### Actividades del curso
```javascript
'a[href*="/mod/assign/"]'                          // Links a evidencias tipo assign
'a[href*="/mod/forum/"]'                           // Links a foros
```

---

## Patrón de extracción del código de ficha

```javascript
// Del nombre del curso — formato: P_NNNNNN_V_NNNNNNN_R_68_C_9545
/_V_(\d{7})_/   // Código de ficha (7 dígitos, empieza en 2 o 3)
/_P_(\d+)_/     // Código de programa

// Del meta keywords de la página
document.querySelector('meta[name="keywords"]').getAttribute("content")
```

---

## Configuración por defecto de la extensión

```javascript
{
  versionGetEvsStatus: "V2",
  includeSuspendedStudents: false,  // filtrar isSuspended: true
  autoViewEvidenceFiles: false,
  autoImproveGradesView: false,
  includeDeliveryDatesV2: true,
  reportLogDateFilterModeV2: "days",
  reportLogDaysV2: 30
}
```

---

## Estado de implementación

| Módulo | Archivo | Estado |
|--------|---------|--------|
| Auth / login | `scraper/auth.js` | ✅ Hecho |
| Fichas | `scraper/fichas.js` | ✅ Hecho |
| Evidencias (listar) | `scraper/evidencias.js` | ✅ Hecho |
| Mensajes Moodle + WhatsApp | `scraper/mensajes.js` | ✅ Hecho |
| Calificación masiva | `scraper/calificacion.js` | ⏳ Pendiente |
| Foros | `scraper/foros.js` | ⏳ Pendiente |
| Reportes Excel | `scraper/reportes.js` | ⏳ Pendiente |
| Sofía Plus upload | `api/src/routes/sofia.js` | ⏳ Pendiente |
