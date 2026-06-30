/**
 * LegalFooter.tsx — Aviso legal permanente, visible en todas las páginas (se monta
 * en Layout). Texto "defendible" según la Ley 1581/2012: la app es de uso personal
 * del instructor, procesa solo datos a los que ya tiene acceso en Zajuna, no los
 * comparte con terceros, y el SENA es el Responsable del Tratamiento.
 *
 * NO afirma "no almacena datos" (sería falso y contraproducente legalmente).
 */
export default function LegalFooter() {
  return (
    <footer className="border-t border-gray-200 bg-white/60 mt-8">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4">
        <p className="text-[11px] leading-relaxed text-gray-500 text-center">
          <span className="font-medium text-gray-600">Helper</span> es una herramienta de uso
          personal del instructor para agilizar la calificación, retroalimentación y gestión de
          su formación en el SENA. Procesa únicamente información a la que el instructor ya tiene
          acceso en la plataforma Zajuna, no la comparte con terceros y la utiliza solo para esa
          labor. Los datos personales de los aprendices son responsabilidad del SENA conforme a la
          Ley 1581 de 2012 de Protección de Datos Personales.{" "}
          <a href="/terminos" className="font-medium text-gray-600 underline hover:text-gray-800">
            Términos y Privacidad
          </a>
          .
        </p>
      </div>
    </footer>
  )
}
