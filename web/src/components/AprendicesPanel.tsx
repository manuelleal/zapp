import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { apiFetch } from "@/api/client"

type EstadoFiltro = "" | "pendiente" | "calificado" | "sin_entregar"

interface Aprendiz {
  id: string
  nombre: string
  moodleId: string | null
}

interface Entrega {
  id: string
  estado: "pendiente" | "calificado" | "sin_entregar"
  fechaScan: string
  aprendiz: Aprendiz
}

interface EntregasResponse {
  evidenciaId: string
  evidenciaNombre: string
  actId: string | null
  entregas: Entrega[]
}

const ZAJUNA_BASE = "https://zajuna.sena.edu.co/zajuna"

function estadoLabel(estado: string): string {
  if (estado === "pendiente") return "Pendiente"
  if (estado === "calificado") return "Calificado"
  return "Sin entregar"
}

function estadoVariant(estado: string): "yellow" | "green" | "gray" {
  if (estado === "pendiente") return "yellow"
  if (estado === "calificado") return "green"
  return "gray"
}

export default function AprendicesPanel({ evidenciaId }: { evidenciaId: string }) {
  const [filtro, setFiltro] = useState<EstadoFiltro>("")

  const { data, isLoading, error } = useQuery<EntregasResponse>({
    queryKey: ["entregas", evidenciaId],
    queryFn: () =>
      apiFetch<EntregasResponse>(
        `/api/evidencias/${encodeURIComponent(evidenciaId)}/entregas`
      ),
    staleTime: 2 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="border-t border-gray-100 bg-gray-50 px-6 py-3">
        <p className="text-xs text-gray-500">Cargando aprendices...</p>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="border-t border-gray-100 bg-gray-50 px-6 py-3">
        <p className="text-xs text-red-500">Error al cargar aprendices.</p>
      </div>
    )
  }

  const { entregas, actId } = data

  if (entregas.length === 0) {
    return (
      <div className="border-t border-gray-100 bg-gray-50 px-6 py-3">
        <p className="text-xs text-gray-500">Sin entregas registradas.</p>
      </div>
    )
  }

  const counts = {
    pendiente: entregas.filter((e) => e.estado === "pendiente").length,
    calificado: entregas.filter((e) => e.estado === "calificado").length,
    sin_entregar: entregas.filter((e) => e.estado === "sin_entregar").length,
  }

  const filtradas = filtro ? entregas.filter((e) => e.estado === filtro) : entregas

  const filters: { label: string; value: EstadoFiltro }[] = [
    { label: `Todos (${entregas.length})`, value: "" },
    { label: `Pendientes (${counts.pendiente})`, value: "pendiente" },
    { label: `Calificados (${counts.calificado})`, value: "calificado" },
    { label: `Sin entregar (${counts.sin_entregar})`, value: "sin_entregar" },
  ]

  return (
    <div className="border-t border-gray-100 bg-gray-50">
      {/* Toolbar */}
      <div className="flex flex-wrap gap-1.5 px-6 pt-3 pb-2">
        {filters.map((f) => (
          <button
            key={f.value}
            onClick={() => setFiltro(f.value)}
            className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
              filtro === f.value
                ? "bg-sena-green text-white border-sena-green"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="max-h-64 overflow-y-auto px-6 pb-3 space-y-0.5">
        {filtradas.length === 0 ? (
          <p className="text-xs text-gray-500 py-2">
            Ningún aprendiz con este filtro.
          </p>
        ) : (
          filtradas.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-2 py-1.5 border-b border-gray-100 last:border-0"
            >
              <span className="flex-1 text-sm text-gray-700 min-w-0 truncate">
                {e.aprendiz.nombre}
              </span>
              <Badge variant={estadoVariant(e.estado)} className="text-xs shrink-0">
                {estadoLabel(e.estado)}
              </Badge>
              {actId && e.aprendiz.moodleId ? (
                <a
                  href={`${ZAJUNA_BASE}/mod/assign/view.php?id=${actId}&rownum=0&action=grader&userid=${e.aprendiz.moodleId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:underline shrink-0"
                >
                  Abrir entrega
                </a>
              ) : (
                <span className="text-xs text-gray-300 shrink-0 w-[72px]" />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
