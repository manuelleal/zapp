import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Loader2, Link as LinkIcon, CheckCircle2, AlertCircle } from "lucide-react"
import { useQuery, useMutation } from "@tanstack/react-query"
import { apiFetch, ApiError } from "@/api/client"
import { toast } from "sonner"

interface RapSinEvidencia {
  id: string
  codigo: string
}

interface MapeoAlVueloModalProps {
  open: boolean
  onClose: () => void
  fichaId: string
  rapsSinMapeo: RapSinEvidencia[]
  onSuccess: () => void // Callback para reintentar el auto-poblar
}

export function MapeoAlVueloModal({ open, onClose, fichaId, rapsSinMapeo, onSuccess }: MapeoAlVueloModalProps) {
  // Estado local: rapId -> Set de evidenciaIds seleccionadas
  const [selecciones, setSelecciones] = useState<Record<string, Set<string>>>({})

  // Traer todas las evidencias de la ficha para que el usuario pueda elegir
  const { data: evidencias, isLoading: cargandoEvidencias, isError: errorEvidencias, refetch: recargarEvidencias } = useQuery({
    queryKey: ["evidencias-ficha", fichaId],
    queryFn: () => apiFetch<any[]>(`/api/fichas/${fichaId}/evidencias`),
    enabled: open && !!fichaId,
  })

  const mapeoMutation = useMutation({
    mutationFn: (mappings: any[]) =>
      apiFetch("/api/raps/mapeo-lote", {
        method: "POST",
        body: JSON.stringify({ fichaId, mappings })
      }),
    onSuccess: () => {
      toast.success("Evidencias mapeadas correctamente. Retomando la generación...")
      onClose()
      onSuccess() // Dispara el auto-poblar nuevamente
    },
    onError: (e) => {
      toast.error(e instanceof ApiError ? e.message : "Error al guardar el mapeo")
    }
  })

  function toggleEvidencia(rapId: string, evidenciaId: string) {
    setSelecciones(prev => {
      const currentSet = prev[rapId] ? new Set(prev[rapId]) : new Set<string>()
      if (currentSet.has(evidenciaId)) currentSet.delete(evidenciaId)
      else currentSet.add(evidenciaId)
      return { ...prev, [rapId]: currentSet }
    })
  }

  function handleGuardar() {
    // Validar que TODOS los RAPs huérfanos tengan al menos 1 evidencia seleccionada
    const mappings = []
    for (const rap of rapsSinMapeo) {
      const ids = Array.from(selecciones[rap.id] || [])
      if (ids.length === 0) {
        toast.error(`Selecciona al menos una evidencia para el RAP ${rap.codigo}`)
        return
      }
      mappings.push({ rapId: rap.id, evidenciaIds: ids })
    }

    mapeoMutation.mutate(mappings)
  }

  const isBusy = mapeoMutation.isPending

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !isBusy) onClose() }}>
      <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col p-0 overflow-hidden">
        {/* Encabezado */}
        <div className="bg-gradient-to-r from-blue-600 to-indigo-700 px-6 py-5 flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0 rounded-full bg-white/20 p-2">
              <LinkIcon className="w-6 h-6 text-white" />
            </div>
            <div>
              <DialogTitle className="text-white font-bold text-lg leading-snug">
                Mapeo al Vuelo de Evidencias
              </DialogTitle>
              <DialogDescription className="text-blue-100 text-sm mt-0.5">
                Selecciona las evidencias que vas a evaluar para cada uno de los siguientes RAPs.
              </DialogDescription>
            </div>
          </div>
        </div>

        {/* Cuerpo */}
        <div className="flex-1 overflow-y-auto px-6 py-5 bg-gray-50/50 space-y-6">
          {cargandoEvidencias ? (
            <div className="flex items-center justify-center py-10 text-gray-500 gap-2">
              <Loader2 className="w-5 h-5 animate-spin" /> Cargando evidencias de la ficha...
            </div>
          ) : errorEvidencias ? (
            <div className="flex flex-col items-center justify-center py-10 text-gray-600 gap-3">
              <AlertCircle className="w-8 h-8 text-red-500" />
              <p className="text-sm text-center">No se pudieron cargar las evidencias de la ficha.</p>
              <Button variant="outline" size="sm" onClick={() => recargarEvidencias()}>Reintentar</Button>
            </div>
          ) : (
            rapsSinMapeo.map(rap => (
              <div key={rap.id} className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
                <div className="bg-gray-100 px-4 py-3 border-b border-gray-200 flex items-center justify-between">
                  <span className="font-mono font-bold text-gray-800">{rap.codigo}</span>
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                    Seleccionadas: {selecciones[rap.id]?.size || 0}
                  </span>
                </div>
                <div className="p-4 max-h-64 overflow-y-auto space-y-2">
                  {evidencias?.map(ev => {
                    const isChecked = selecciones[rap.id]?.has(ev.id) || false
                    return (
                      <label key={ev.id} className={`flex items-start gap-3 p-2 rounded-md border cursor-pointer transition-colors ${isChecked ? "bg-blue-50 border-blue-200" : "bg-white border-transparent hover:bg-gray-50"}`}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleEvidencia(rap.id, ev.id)}
                          className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600"
                        />
                        <span className="text-sm text-gray-700 leading-tight">
                          {ev.nombre}
                        </span>
                      </label>
                    )
                  })}
                  {!evidencias?.length && (
                    <div className="text-sm text-gray-500 italic py-2">
                      No hay evidencias registradas en esta ficha.
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-white border-t border-gray-200 flex justify-end gap-3 flex-shrink-0">
          <Button variant="outline" onClick={onClose} disabled={isBusy}>
            Cancelar y volver
          </Button>
          <Button 
            className="bg-sena-green hover:bg-sena-green/90 gap-2 text-white" 
            onClick={handleGuardar} 
            disabled={isBusy || cargandoEvidencias}
          >
            {isBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Guardar Mapeo y Continuar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
