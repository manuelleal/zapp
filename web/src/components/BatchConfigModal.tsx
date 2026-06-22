import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { AlertCircle, Loader2 } from "lucide-react"

interface BatchConfigModalProps {
  open: boolean
  onClose: () => void
  evidenciaCount: number
  onSubmit: (cambios: BatchCambios) => void
  busy: boolean
  error?: string
}

export interface BatchCambios {
  entregaFecha?: string
  entregaHora?: string
  abrirFecha?: string
  abrirHora?: string
  limiteFecha?: string
  limiteHora?: string
  intentos?: string
}

type DateField = {
  fechaKey: keyof BatchCambios
  horaKey: keyof BatchCambios
  label: string
  defaultHora: string
}

const DATE_FIELDS: DateField[] = [
  { fechaKey: "abrirFecha",    horaKey: "abrirHora",    label: "Apertura de entregas",  defaultHora: "00:00" },
  { fechaKey: "entregaFecha",  horaKey: "entregaHora",  label: "Fecha de entrega",      defaultHora: "23:55" },
  { fechaKey: "limiteFecha",   horaKey: "limiteHora",   label: "Fecha límite (extensión)", defaultHora: "23:55" },
]

export default function BatchConfigModal({ open, onClose, evidenciaCount, onSubmit, busy, error }: BatchConfigModalProps) {
  const [cambios, setCambios] = useState<BatchCambios>({})
  const [confirmando, setConfirmando] = useState(false)

  function setField(key: keyof BatchCambios, val: string) {
    setCambios(prev => ({ ...prev, [key]: val || undefined }))
  }

  function getCamposLlenos() {
    return Object.entries(cambios).filter(([, v]) => v !== undefined && v !== "").map(([k]) => k)
  }

  function handleConfirmar() {
    const llenos = getCamposLlenos()
    if (llenos.length === 0) return
    setConfirmando(true)
  }

  function handleAplicar() {
    onSubmit(cambios)
    setConfirmando(false)
  }

  function handleClose() {
    if (busy) return
    setCambios({})
    setConfirmando(false)
    onClose()
  }

  const camposLlenos = getCamposLlenos()
  const tieneAlgo    = camposLlenos.length > 0

  // Resumen legible de los cambios
  function resumenCambio(key: string): string {
    const labelsMap: Record<string, string> = {
      abrirFecha: "Apertura", abrirHora: "Hora apertura",
      entregaFecha: "Entrega", entregaHora: "Hora entrega",
      limiteFecha: "Límite", limiteHora: "Hora límite",
      intentos: "Intentos",
    }
    return `${labelsMap[key] ?? key}: ${(cambios as Record<string, string>)[key]}`
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">
            Configurar {evidenciaCount} evidencia{evidenciaCount !== 1 ? "s" : ""} seleccionada{evidenciaCount !== 1 ? "s" : ""}
          </DialogTitle>
        </DialogHeader>

        {!confirmando ? (
          <div className="space-y-4 py-2">
            <p className="text-xs text-gray-500">
              Solo se aplican los campos que completes. Los campos vacíos no se modifican.
            </p>

            {DATE_FIELDS.map(({ fechaKey, horaKey, label, defaultHora }) => (
              <div key={String(fechaKey)} className="space-y-1">
                <Label className="text-sm font-medium text-gray-700">{label}</Label>
                <div className="flex gap-2">
                  <Input
                    type="date"
                    className="flex-1 h-8 text-sm"
                    value={cambios[fechaKey] ?? ""}
                    onChange={e => {
                      setField(fechaKey, e.target.value)
                      if (e.target.value && !cambios[horaKey]) setField(horaKey, defaultHora)
                    }}
                    disabled={busy}
                  />
                  <Input
                    type="time"
                    step="300"
                    className="w-28 h-8 text-sm"
                    value={cambios[horaKey] ?? ""}
                    onChange={e => setField(horaKey, e.target.value)}
                    disabled={busy || !cambios[fechaKey]}
                  />
                </div>
              </div>
            ))}

            <div className="space-y-1">
              <Label className="text-sm font-medium text-gray-700">Intentos máximos</Label>
              <select
                className="w-full h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                value={cambios.intentos ?? ""}
                onChange={e => setField("intentos", e.target.value)}
                disabled={busy}
              >
                <option value="">(sin cambio)</option>
                <option value="Ilimitado">Ilimitado</option>
                {[1, 2, 3, 5, 10].map(n => <option key={n} value={String(n)}>{n}</option>)}
              </select>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}
          </div>
        ) : (
          <div className="py-3 space-y-3">
            <p className="text-sm text-gray-700 font-medium">
              ¿Aplicar estos cambios a <strong>{evidenciaCount}</strong> evidencia{evidenciaCount !== 1 ? "s" : ""}?
            </p>
            <ul className="text-sm text-gray-600 space-y-1 pl-3 border-l-2 border-sena-green">
              {camposLlenos.map(k => (
                <li key={k}>{resumenCambio(k)}</li>
              ))}
            </ul>
            <p className="text-xs text-amber-700 bg-amber-50 px-3 py-2 rounded-md">
              Esta acción modifica la plataforma directamente y no se puede deshacer fácilmente.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2 flex-wrap">
          <Button variant="outline" onClick={handleClose} disabled={busy}>
            Cancelar
          </Button>
          {!confirmando ? (
            <Button
              className="bg-sena-green hover:bg-sena-green/90"
              onClick={handleConfirmar}
              disabled={!tieneAlgo || busy}
            >
              Continuar
            </Button>
          ) : (
            <Button
              className="bg-red-600 hover:bg-red-700"
              onClick={handleAplicar}
              disabled={busy}
            >
              {busy ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" />Aplicando...</> : "Confirmar y aplicar"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
