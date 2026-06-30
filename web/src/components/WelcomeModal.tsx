/**
 * WelcomeModal.tsx — Aviso de bienvenida / tratamiento de datos que se muestra la
 * PRIMERA vez que el instructor entra (cuando aceptoTerminosAt es null). Al aceptar,
 * persiste la aceptación en DB (POST /api/auth/aceptar-terminos) para no volver a
 * mostrarlo (sobrevive a reloads y cambios de dispositivo).
 *
 * Texto alineado con la Ley 1581: la app automatiza la labor que el instructor ya
 * hace, usando los datos de su propia sesión de Zajuna; él es responsable de su uso.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ShieldCheck } from "lucide-react"
import { useMutation } from "@tanstack/react-query"
import { apiFetch } from "@/api/client"

export default function WelcomeModal({ open, onAccepted }: { open: boolean; onAccepted: () => void }) {
  const aceptar = useMutation({
    mutationFn: () => apiFetch("/api/auth/aceptar-terminos", { method: "POST" }),
    onSuccess: onAccepted,
    onError: onAccepted, // no bloquear el uso si la red falla; se reintenta el próximo login
  })

  return (
    <Dialog open={open}>
      <DialogContent className="max-w-lg" onPointerDownOutside={e => e.preventDefault()} onEscapeKeyDown={e => e.preventDefault()}>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="rounded-full bg-sena-green/10 p-2">
              <ShieldCheck className="w-5 h-5 text-sena-green" />
            </div>
            <DialogTitle>Bienvenido a Helper</DialogTitle>
          </div>
        </DialogHeader>

        <div className="space-y-3 text-sm text-gray-600 leading-relaxed">
          <p>
            Helper automatiza tareas que ya realizas como instructor del SENA —revisar evidencias,
            calificar, generar actas y enviar mensajes— usando la información de tu propia sesión de
            la plataforma Zajuna.
          </p>
          <p>
            Esta herramienta es de <span className="font-medium text-gray-800">uso personal</span> y
            busca facilitar tu trabajo. No comparte la información de tus aprendices con terceros.
          </p>
          <p>
            Tú eres responsable del uso de los datos de tus aprendices conforme a la
            <span className="font-medium text-gray-800"> Ley 1581 de 2012</span> de Protección de Datos
            Personales, cuyo Responsable del Tratamiento es el SENA.
          </p>
          <p>
            Los titulares de los datos pueden ejercer sus derechos a conocer, actualizar, rectificar y
            suprimir su información, así como a revocar la autorización, ante el SENA.{" "}
            <a
              href="/terminos"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sena-green underline hover:text-sena-green/80"
            >
              Ver Términos y Política de Privacidad
            </a>
            .
          </p>
        </div>

        <DialogFooter>
          <Button onClick={() => aceptar.mutate()} disabled={aceptar.isPending} className="bg-sena-green hover:bg-sena-green/90 text-white">
            {aceptar.isPending ? "Guardando..." : "Entendido, continuar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
