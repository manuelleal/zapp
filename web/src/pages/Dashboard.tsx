import { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Search, LogOut } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { useAuthStore } from "@/store/auth"
import { authFetch, apiFetch, ApiError } from "@/api/client"

interface Ficha {
  id: string
  codigo: string
  programa: string
  nombre: string
  archivedAt: string | null
  pendientes: number | null
  calificados: number | null
  sinEntregar: number | null
}

interface FichasResponse {
  fichas: Ficha[]
  archivadasCount: number
}

interface JobResponse {
  id: string
  status: "queued" | "running" | "done" | "error"
  progreso: number
  errorMsg?: string
}

function getUserInitials(nombre: string): string {
  return nombre
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
}

export default function Dashboard() {
  const navigate = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()
  const queryClient = useQueryClient()

  const [verArchivadas, setVerArchivadas] = useState(false)
  const [scanStatus, setScanStatus] = useState("")
  const [scanLoading, setScanLoading] = useState(false)

  // Auto-login from stored JWT on first load
  useEffect(() => {
    const storedJwt = localStorage.getItem("zajuna_jwt")
    if (!storedJwt) {
      navigate("/login")
      return
    }
    if (!user && storedJwt) {
      try {
        const payload = JSON.parse(atob(storedJwt.split(".")[1]))
        setAuth(storedJwt, {
          id: payload.id || "",
          nombre: payload.nombre || "",
          email: payload.email || "",
          competenciaNombre: payload.competenciaNombre || "",
          competenciaCodigo: payload.competenciaCodigo || "",
        })
      } catch {
        clearAuth()
        navigate("/login")
      }
    }
  }, [])

  const { data, isLoading, error } = useQuery<FichasResponse>({
    queryKey: ["fichas", verArchivadas],
    queryFn: () =>
      apiFetch<FichasResponse>(`/api/fichas${verArchivadas ? "?incluirArchivadas=1" : ""}`),
    enabled: !!jwt,
    retry: false,
  })

  const archivarMutation = useMutation({
    mutationFn: ({ id, archivada }: { id: string; archivada: boolean }) =>
      apiFetch(`/api/fichas/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ archivada }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["fichas"] }),
    onError: (err) => {
      if (err instanceof ApiError) setScanStatus(`Error: ${err.message}`)
    },
  })

  function handleLogout() {
    clearAuth()
    navigate("/login")
  }

  async function handleScanFichas() {
    setScanLoading(true)
    setScanStatus("Iniciando escaneo...")
    try {
      const res = await authFetch("/api/fichas/scan", { method: "POST", body: "{}" })
      const data = await res.json()
      if (!res.ok) {
        setScanStatus(data.error || "Error al iniciar el escaneo.")
        return
      }
      await pollJob(data.jobId)
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return
      setScanStatus(err instanceof Error ? err.message : "Error inesperado.")
    } finally {
      setScanLoading(false)
    }
  }

  function pollJob(jobId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        try {
          const res = await authFetch(`/api/jobs/${jobId}`)
          const data: JobResponse = await res.json()
          if (!res.ok) {
            clearInterval(timer)
            setScanStatus(data.errorMsg || "Error consultando job.")
            return reject(new Error(data.errorMsg))
          }
          if (data.status === "done") {
            clearInterval(timer)
            setScanStatus("Escaneo completo.")
            queryClient.invalidateQueries({ queryKey: ["fichas"] })
            resolve()
          } else if (data.status === "error") {
            clearInterval(timer)
            setScanStatus(data.errorMsg || "El escaneo falló.")
            reject(new Error(data.errorMsg))
          } else {
            setScanStatus(`Escaneando... ${data.progreso || 0}%`)
          }
        } catch (err) {
          clearInterval(timer)
          reject(err)
        }
      }, 3000)
    })
  }

  const fichas = data?.fichas ?? []
  const archivadasCount = data?.archivadasCount ?? 0
  const activas = fichas.filter((f) => !f.archivedAt).length
  const archivadas = fichas.length - activas

  if (error instanceof ApiError && error.status === 401) {
    clearAuth()
    navigate("/login")
    return null
  }

  const displayNombre = user?.nombre || ""
  const displayCompetencia = user?.competenciaNombre || ""

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-sena-green rounded-lg flex items-center justify-center flex-shrink-0">
              <svg viewBox="0 0 24 24" className="w-5 h-5 fill-white">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
            </div>
            <div>
              <div className="font-semibold text-sm text-gray-900">Zajuna Manager</div>
              {displayCompetencia && (
                <div className="text-xs text-gray-500">{displayCompetencia}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {displayNombre && (
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-sena-green text-white text-xs font-bold flex items-center justify-center">
                  {getUserInitials(displayNombre)}
                </div>
                <span className="text-sm text-gray-700 hidden sm:inline">{displayNombre}</span>
              </div>
            )}
            <Button variant="ghost" size="sm" onClick={handleLogout} className="gap-1.5">
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Salir</span>
            </Button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-4">
        {/* Actions bar */}
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleScanFichas}
              disabled={scanLoading}
              className="bg-sena-green hover:bg-sena-green/90 gap-2"
            >
              <Search className="w-4 h-4" />
              {scanLoading ? "Escaneando..." : "Escanear fichas"}
            </Button>

            {scanStatus && (
              <span className={`text-sm ${scanLoading ? "text-blue-600" : "text-gray-600"}`}>
                {scanStatus}
              </span>
            )}

            <div className="ml-auto flex items-center gap-2">
              <Switch
                id="ver-archivadas"
                checked={verArchivadas}
                onCheckedChange={setVerArchivadas}
              />
              <Label htmlFor="ver-archivadas" className="text-sm text-gray-600 cursor-pointer">
                Ver archivadas
              </Label>
            </div>
          </div>
        </div>

        {/* Fichas table */}
        {isLoading ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500 text-sm">
            Cargando fichas...
          </div>
        ) : fichas.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-12 text-center">
            <div className="text-4xl mb-3">📭</div>
            {!verArchivadas && archivadasCount > 0 ? (
              <p className="text-gray-600 text-sm">
                No hay fichas activas. Tienes{" "}
                <strong>{archivadasCount} archivada{archivadasCount !== 1 ? "s" : ""}</strong>.{" "}
                Activa <strong>Ver archivadas</strong> para verlas.
              </p>
            ) : (
              <p className="text-gray-600 text-sm">
                Aún no tienes fichas escaneadas.
                <br />
                Haz clic en <strong>Escanear fichas</strong> para empezar.
              </p>
            )}
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-semibold text-gray-800 flex items-center gap-2">
                <span>📋</span> Fichas
              </h2>
              <Badge variant="green" className="text-xs">
                {archivadas > 0
                  ? `${activas} activa${activas !== 1 ? "s" : ""} · ${archivadas} archivada${archivadas !== 1 ? "s" : ""}`
                  : `${activas} ficha${activas !== 1 ? "s" : ""}`}
              </Badge>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-5 py-3 font-medium text-gray-600 whitespace-nowrap">Código</th>
                    <th className="text-left px-5 py-3 font-medium text-gray-600 whitespace-nowrap">Programa</th>
                    <th className="text-left px-5 py-3 font-medium text-gray-600">Nombre del curso</th>
                    <th className="text-left px-5 py-3 font-medium text-gray-600 whitespace-nowrap">Pendientes</th>
                    <th className="text-left px-5 py-3 font-medium text-gray-600 whitespace-nowrap">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {fichas.map((f) => (
                    <FichaRow
                      key={f.id}
                      ficha={f}
                      onArchivar={(id, archivada) => archivarMutation.mutate({ id, archivada })}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-5 py-2 border-t border-gray-100">
              <p className="text-xs text-gray-400 text-right">
                Solo fichas con código de 7 dígitos · Datos de Zajuna/Moodle
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

function FichaRow({
  ficha: f,
  onArchivar,
}: {
  ficha: Ficha
  onArchivar: (id: string, archivada: boolean) => void
}) {
  const isArchivada = !!f.archivedAt

  return (
    <tr className={`border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors ${isArchivada ? "opacity-60" : ""}`}>
      <td className="px-5 py-3 whitespace-nowrap">
        <span className="font-mono text-sm font-medium text-gray-800">{f.codigo ?? "—"}</span>
      </td>
      <td className="px-5 py-3 whitespace-nowrap">
        {f.programa ? (
          <Badge variant="green" className="font-mono text-xs">{f.programa}</Badge>
        ) : (
          <Badge variant="gray" className="text-xs">—</Badge>
        )}
      </td>
      <td className="px-5 py-3 text-gray-700 max-w-xs truncate" title={f.nombre}>
        {f.nombre}
      </td>
      <td className="px-5 py-3 whitespace-nowrap">
        <PendientesBadge pendientes={f.pendientes} />
      </td>
      <td className="px-5 py-3 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={isArchivada} className="text-xs h-7 px-2">
            Ver evidencias
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7 px-2"
            onClick={() => onArchivar(f.id, !isArchivada)}
          >
            {isArchivada ? "Restaurar" : "Archivar"}
          </Button>
        </div>
      </td>
    </tr>
  )
}

function PendientesBadge({ pendientes }: { pendientes: number | null }) {
  if (pendientes === null) {
    return <Badge variant="gray">Sin escanear</Badge>
  }
  if (pendientes === 0) {
    return <Badge variant="green">Al día</Badge>
  }
  return (
    <Badge variant="yellow">
      {pendientes} pendiente{pendientes !== 1 ? "s" : ""}
    </Badge>
  )
}
