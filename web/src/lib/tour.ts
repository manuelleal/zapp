// ─── Tour de bienvenida (driver.js) ───────────────────────────────────────────
//
// Qué hace: resalta los items de la barra de navegación la primera vez que un
// instructor entra (tras aceptar el aviso legal), explicando en 1-2 líneas para
// qué sirve cada sección. También se re-dispara desde la página de Ayuda con el
// botón "Ver tutorial de nuevo".
//
// Por qué driver.js: librería liviana (~6 kb, sin dependencias) que resalta
// elementos reales del DOM. Resaltamos por el atributo `data-tour="<ruta>"` que
// agrega cada <NavLink> en Layout.tsx — así el tour NO se ata a clases de Tailwind
// que pueden cambiar con un rediseño.
//
// Gotcha: el tour debe correr DESPUÉS de que la nav esté montada. El disparo
// automático en Layout.tsx espera ~600 ms a que React pinte los <NavLink>; si un
// selector no existe (porque el item está oculto, p.ej. nav colapsada en móvil),
// driver.js simplemente salta ese paso sin romper.

import { driver } from "driver.js"
import "driver.js/dist/driver.css"

// Clave en localStorage para recordar que el usuario ya vio el tour. Se usa tanto
// aquí como en Layout.tsx (disparo automático de la 1ª vez).
export const TOUR_KEY = "helper_tour_visto"

/**
 * Arranca el tour de bienvenida resaltando cada sección de la navegación.
 * Cada paso apunta al <NavLink> por su `data-tour="<ruta>"`.
 */
export function startTour() {
  const tour = driver({
    showProgress:  true,
    nextBtnText:   "Siguiente",
    prevBtnText:   "Atrás",
    doneBtnText:   "Listo",
    steps: [
      {
        element: '[data-tour="/dashboard"]',
        popover: {
          title:       "Dashboard",
          description: "Tu panel: resumen de fichas y tareas en curso.",
        },
      },
      {
        element: '[data-tour="/fichas"]',
        popover: {
          title:       "Fichas",
          description: "Tus fichas (grupos). Acá las escaneas desde Zajuna.",
        },
      },
      {
        element: '[data-tour="/evidencias/config"]',
        popover: {
          title:       "Mis Evidencias",
          description: "Activá cuáles rastrear y mirá su estado por aprendiz.",
        },
      },
      {
        element: '[data-tour="/raps"]',
        popover: {
          title:       "RAPs",
          description: "Subí tu guía en PDF y la IA extrae los resultados de aprendizaje.",
        },
      },
      {
        element: '[data-tour="/actas"]',
        popover: {
          title:       "Actas",
          description: "Generá el acta GOR-F-084 cuando ya escaneaste.",
        },
      },
      {
        element: '[data-tour="/mensajes"]',
        popover: {
          title:       "Mensajes",
          description: "Mandá llamados de atención (correo o plataforma), con filtros y programados.",
        },
      },
      {
        element: '[data-tour="/ajustes"]',
        popover: {
          title:       "Ajustes",
          description: "Tu competencia, tu correo SMTP y tus credenciales de Zajuna.",
        },
      },
      {
        element: '[data-tour="/ayuda"]',
        popover: {
          title:       "Ayuda",
          description: "Guías paso a paso. Volvé acá cuando tengas dudas.",
        },
      },
    ],
  })

  tour.drive()
}
