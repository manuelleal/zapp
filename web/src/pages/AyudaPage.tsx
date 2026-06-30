// ─── Página de Ayuda (/ayuda) ─────────────────────────────────────────────────
//
// Qué hace: guías escritas paso a paso que documentan lo que la app YA hace
// (escanear, correo, mensajes, actas, RAPs). NO es backend ni lógica: es contenido
// estático para que un instructor nuevo no se pierda. Reemplaza/complementa al
// tour de bienvenida (que solo resalta la nav la 1ª vez).
//
// Por qué <details>/<summary> nativos: secciones colapsables sin dependencias ni
// estado de React. Accesibles por teclado de fábrica. Estilados con Tailwind.
//
// El botón "Ver tutorial de nuevo" re-dispara el tour (driver.js) por si el
// instructor quiere repasarlo después de la 1ª vez.

import Layout from "@/components/Layout"
import { Button } from "@/components/ui/button"
import { startTour } from "@/lib/tour"
import {
  HelpCircle, PlayCircle, Rocket, ScanLine, Mail,
  MessageSquare, ClipboardList, BookOpen,
} from "lucide-react"

// Una sección colapsable de la ayuda. Recibe un ícono, título y el contenido ya
// maquetado (los pasos son distintos por sección, así que va como children).
function Seccion({
  icon: Icon,
  titulo,
  children,
  defaultOpen = false,
}: {
  icon: typeof HelpCircle
  titulo: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  return (
    <details
      open={defaultOpen}
      className="group bg-white rounded-lg border border-gray-200 overflow-hidden"
    >
      <summary className="px-4 py-3 flex items-center gap-3 cursor-pointer select-none hover:bg-gray-50 list-none">
        <span className="w-8 h-8 rounded-lg bg-sena-green/10 flex items-center justify-center flex-shrink-0">
          <Icon className="w-4 h-4 text-sena-green" />
        </span>
        <span className="text-sm font-semibold text-gray-900 flex-1">{titulo}</span>
        {/* La flechita rota con el estado open del <details> (group-open). */}
        <svg
          className="w-4 h-4 text-gray-400 transition-transform group-open:rotate-90 flex-shrink-0"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </summary>
      <div className="px-4 pb-4 pt-1 border-t border-gray-100 text-sm text-gray-700 space-y-3">
        {children}
      </div>
    </details>
  )
}

// Lista de pasos numerados (estilo consistente entre secciones).
function Pasos({ children }: { children: React.ReactNode }) {
  return <ol className="list-decimal pl-5 space-y-1.5 marker:text-gray-400 marker:text-xs">{children}</ol>
}

// Resalta un término del dominio (ficha, evidencia, estado…) en el texto.
function T({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-gray-900">{children}</strong>
}

export default function AyudaPage() {
  return (
    <Layout>
      <div className="space-y-4 max-w-3xl">

        {/* Encabezado */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <HelpCircle className="w-5 h-5 text-sena-green flex-shrink-0" />
            <div>
              <h1 className="text-sm font-semibold text-gray-900">Ayuda</h1>
              <p className="text-xs text-gray-500">Guías paso a paso para usar la app.</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs"
            onClick={() => startTour()}
          >
            <PlayCircle className="w-3.5 h-3.5 text-sena-green" />
            <span>Ver tutorial de nuevo</span>
          </Button>
        </div>

        {/* 1) Primeros pasos */}
        <Seccion icon={Rocket} titulo="1) Primeros pasos" defaultOpen>
          <p>
            Una <T>ficha</T> es un grupo de aprendices; una <T>evidencia</T> es una
            actividad que el aprendiz entrega; un <T>RAP</T> es un resultado de
            aprendizaje.
          </p>
          <p className="text-gray-500">Flujo general:</p>
          <Pasos>
            <li>Elegí tu competencia en <T>Ajustes</T>.</li>
            <li>Escaneá tus <T>fichas</T>.</li>
            <li>Escaneá las <T>evidencias</T>.</li>
            <li>Revisá y calificá en Zajuna.</li>
            <li>Generá <T>actas</T> o mandá <T>mensajes</T>.</li>
          </Pasos>
        </Seccion>

        {/* 2) Escanear una ficha y entender los estados */}
        <Seccion icon={ScanLine} titulo="2) Escanear una ficha y entender los estados">
          <Pasos>
            <li>
              En <T>Fichas</T> (o el <T>Dashboard</T>), tocá <T>"Escanear fichas"</T>:
              la app descubre tus fichas desde Zajuna (espejo de lo que ves en la
              plataforma).
            </li>
            <li>
              Abrí una ficha y escaneá evidencias: primero se <T>descubren</T>, luego
              <T> activás</T> las que querés rastrear, y se <T>re-escanea</T> para
              traer las entregas.
            </li>
          </Pasos>
          <p className="text-gray-500">Estados por aprendiz:</p>
          <ul className="list-disc pl-5 space-y-1">
            <li><T>Calificado</T> (con nota A/D o número).</li>
            <li><T>Pendiente</T> (entregó, falta calificar).</li>
            <li><T>Sin entregar</T>.</li>
            <li><T>Borrador</T> (empezó pero no envió — badge ámbar).</li>
          </ul>
          <p>
            En <T>foros</T>: <T>Pendiente de revisar</T> / <T>Revisado</T> (los foros
            se revisan en Zajuna, no se califican desde la app).
          </p>
          <p>
            La nota cualitativa <span className="font-semibold text-emerald-600">A</span> (verde) /{" "}
            <span className="font-semibold text-red-600">D</span> (rojo) aparece cuando
            se califica por letra en vez de número.
          </p>
        </Seccion>

        {/* 3) Conectar tu correo */}
        <Seccion icon={Mail} titulo="3) Conectar tu correo (para enviar por email)">
          <Pasos>
            <li>Andá a <T>Ajustes → "Correo para notificaciones"</T>.</li>
            <li>
              Elegí proveedor: <T>Gmail</T> (smtp.gmail.com:587),{" "}
              <T>Outlook/Office 365</T> (smtp.office365.com:587), u <T>Otro</T>{" "}
              (host/puerto manual).
            </li>
            <li>
              <T>Gmail:</T> no uses tu clave normal — necesitás una{" "}
              <T>"contraseña de aplicación"</T> (requiere verificación en 2 pasos
              activada). Se genera en tu cuenta de Google → Seguridad → Contraseñas de
              aplicaciones.
            </li>
            <li><T>Outlook:</T> si tu organización bloquea SMTP, contactá a sistemas.</li>
            <li>
              Ingresá tu correo, la contraseña (de aplicación en Gmail) y, opcional, tu
              nombre (aparece como remitente).
            </li>
            <li>
              Tocá <T>Guardar</T> y luego <T>Probar conexión</T>: si falla, el mensaje
              te dice por qué (clave incorrecta, 2FA, etc.).
            </li>
          </Pasos>
        </Seccion>

        {/* 4) Hacer un llamado de atención (mensajes) */}
        <Seccion icon={MessageSquare} titulo="4) Hacer un llamado de atención (mensajes)">
          <Pasos>
            <li>Andá a <T>Mensajes → pestaña Compositor</T>.</li>
            <li>
              Elegí la <T>ficha</T>. (Opcional: "Sincronizar emails desde la plataforma"
              para traer los correos de los aprendices.)
            </li>
            <li>
              Elegí <T>destinatarios</T> con los <T>filtros rápidos</T> (un clic marca a
              todos los que cumplen): <T>Con pendientes</T>, <T>Con desaprobadas</T>,{" "}
              <T>Inactivos &gt;7 días</T>, <T>Nunca entraron</T>. O marcá manual.
            </li>
            <li>
              (Opcional) Seleccioná las <T>evidencias</T> para la variable{" "}
              <code className="px-1 py-0.5 rounded bg-gray-100 text-xs font-mono">{"{{evidencias}}"}</code>{" "}
              — vienen premarcadas las de tu competencia. Podés incluir también las
              desaprobadas.
            </li>
            <li>
              Elegí el <T>canal</T>: <T>Correo electrónico</T> (requiere SMTP
              configurado) o <T>Mensaje interno de la plataforma</T>.
            </li>
            <li>
              Elegí una <T>plantilla</T> o escribí. Variables disponibles:{" "}
              <code className="px-1 py-0.5 rounded bg-gray-100 text-xs font-mono">{"{{nombre}}"}</code>,{" "}
              <code className="px-1 py-0.5 rounded bg-gray-100 text-xs font-mono">{"{{ficha}}"}</code>,{" "}
              <code className="px-1 py-0.5 rounded bg-gray-100 text-xs font-mono">{"{{instructor}}"}</code>,{" "}
              <code className="px-1 py-0.5 rounded bg-gray-100 text-xs font-mono">{"{{evidencias}}"}</code>.
              Mirá la <T>Vista previa</T>.
            </li>
            <li>
              Tocá <T>Enviar a N</T>. O <T>Programar…</T> para envíos recurrentes (cada
              X días a una hora; recalcula los destinatarios en cada corrida).
            </li>
          </Pasos>
        </Seccion>

        {/* 5) Generar un acta */}
        <Seccion icon={ClipboardList} titulo="5) Generar un acta">
          <Pasos>
            <li>Andá a <T>Actas → Nueva acta</T>.</li>
            <li>Elegí la <T>ficha</T>.</li>
            <li>
              Tocá <T>Vista previa</T> (se auto-puebla con tus RAPs y evidencias).
            </li>
            <li>
              Generá el acta <T>GOR-F-084</T> (DOCX). Requiere haber escaneado y tener
              RAPs vinculados.
            </li>
          </Pasos>
        </Seccion>

        {/* 6) Cargar tus RAPs */}
        <Seccion icon={BookOpen} titulo="6) Cargar tus RAPs">
          <Pasos>
            <li>Andá a <T>RAPs → "Cargar mis RAPs"</T>.</li>
            <li>Subí el <T>PDF de tu guía</T>.</li>
            <li>La IA extrae los RAPs y los vincula a tus evidencias.</li>
          </Pasos>
        </Seccion>

        {/* Nota de cierre */}
        <p className="text-xs text-gray-500 px-1">
          ¿Algo no funciona o falta? Avisale al administrador.
        </p>
      </div>
    </Layout>
  )
}
