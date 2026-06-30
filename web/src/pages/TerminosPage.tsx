// ─── Página /terminos — Términos de uso y Política de Privacidad ──────────────
//
// Qué hace: documento PÚBLICO (accesible SIN sesión) que se enlaza desde la casilla
// de consentimiento del registro, el WelcomeModal y el LegalFooter. Resume los
// términos de uso y el tratamiento de datos alineado con la Ley 1581 de 2012.
//
// Por qué NO usa <Layout>: Layout asume usuario autenticado (nav, /me, WelcomeModal).
// Esta página debe verse desde la pantalla de registro, así que trae su propio
// encabezado mínimo (marca "Helper" + "Volver") y no depende del store de auth.
//
// Contenido: es un resumen informativo; prevalece la normativa del SENA y la Ley 1581.

import { useNavigate } from "react-router-dom"
import { ShieldCheck, ArrowLeft } from "lucide-react"

// Una sección del documento: título + cuerpo. Mantiene el maquetado consistente.
function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-gray-900">{titulo}</h2>
      <div className="text-sm text-gray-600 leading-relaxed space-y-2">{children}</div>
    </section>
  )
}

export default function TerminosPage() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Encabezado simple (sin Layout): marca + volver */}
      <header className="border-b border-gray-200 bg-white">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
          >
            <ArrowLeft className="w-4 h-4" />
            Volver
          </button>
          <div className="ml-auto flex items-center gap-2">
            <div className="rounded-full bg-sena-green/10 p-1.5">
              <ShieldCheck className="w-4 h-4 text-sena-green" />
            </div>
            <span className="font-bold text-gray-900">Helper</span>
          </div>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="bg-white rounded-lg border border-gray-200 p-6 sm:p-8 space-y-6">
          <div>
            <h1 className="text-lg font-bold text-gray-900">Términos de uso y Política de Privacidad</h1>
            <p className="text-xs text-gray-500 mt-1">
              Este documento es un resumen informativo; prevalece la normativa institucional
              del SENA y la Ley 1581 de 2012 de Protección de Datos Personales.
            </p>
          </div>

          <Seccion titulo="1. Qué es Helper">
            <p>
              Helper es una herramienta de <span className="font-medium text-gray-800">uso personal del
              instructor</span> para agilizar la calificación, la retroalimentación y la gestión de su
              formación en el SENA. Automatiza tareas que el instructor ya realiza en la plataforma Zajuna.
            </p>
          </Seccion>

          <Seccion titulo="2. Finalidad del tratamiento">
            <p>
              La finalidad es automatizar tareas que el instructor ya hace —revisar evidencias, calificar,
              generar actas y enviar mensajes a sus aprendices— utilizando la información de su propia
              sesión de Zajuna. No se persigue ninguna finalidad distinta a apoyar la labor formativa.
            </p>
          </Seccion>

          <Seccion titulo="3. Responsable del tratamiento">
            <p>
              El <span className="font-medium text-gray-800">SENA</span> es el Responsable del Tratamiento
              de los datos personales de los aprendices. Helper actúa únicamente como herramienta de apoyo
              al instructor en el ejercicio de su labor.
            </p>
          </Seccion>

          <Seccion titulo="4. Datos que se procesan">
            <p>
              Helper procesa únicamente información a la que el instructor <span className="font-medium text-gray-800">ya
              tiene acceso</span> en Zajuna (sus fichas, evidencias y entregas). No se comparte con terceros.
            </p>
            <p>
              Las credenciales de Zajuna del instructor se almacenan <span className="font-medium text-gray-800">cifradas</span>
              {" "}(AES-256-GCM) y se usan solo para iniciar sesión en su nombre y ejecutar las tareas que él solicita.
            </p>
          </Seccion>

          <Seccion titulo="5. Derechos del titular (habeas data)">
            <p>
              Conforme a la Ley 1581 de 2012, los titulares de los datos pueden ejercer sus derechos a{" "}
              <span className="font-medium text-gray-800">conocer, actualizar, rectificar y suprimir</span> sus datos
              personales, así como a <span className="font-medium text-gray-800">revocar la autorización</span> otorgada,
              ante el SENA como Responsable del Tratamiento.
            </p>
          </Seccion>

          <Seccion titulo="6. Responsabilidad del instructor">
            <p>
              El instructor es responsable del uso que haga de los datos de sus aprendices conforme a la
              Ley 1581 de 2012 y a la normativa institucional del SENA.
            </p>
          </Seccion>

          <Seccion titulo="7. Contacto">
            <p>
              Para ejercer sus derechos como titular o resolver dudas sobre el tratamiento de datos, diríjase
              al SENA a través de los canales institucionales dispuestos para ello.
            </p>
          </Seccion>

          <p className="text-xs text-gray-500 border-t border-gray-100 pt-4">
            Este documento es un resumen informativo; prevalece la normativa institucional del SENA y la
            Ley 1581 de 2012 de Protección de Datos Personales.
          </p>
        </div>
      </main>
    </div>
  )
}
