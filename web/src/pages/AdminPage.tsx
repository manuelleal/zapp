/**
 * AdminPage.tsx — Panel del DUEÑO de la app (rol superadmin). Muestra las métricas
 * globales de la plataforma y la lista de instructores registrados, con acciones de
 * suspender/reactivar y eliminar. Consume /api/admin/* (todos exigen superadmin).
 *
 * Visible solo para superadmin: el item de nav y la ruta se ocultan a instructores,
 * y el backend devuelve 403 igual (defensa en profundidad).
 */
import Layout from "@/components/Layout"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch, ApiError } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Users, FolderOpen, FileText, ClipboardList, Mail, Activity, Loader2, Ban, Trash2, CheckCircle2 } from "lucide-react"
import { toast } from "sonner"

interface Metricas {
  instructores: { total: number; suspendidos: number; activos: number }
  fichas: number; evidencias: number; entregas: number; aprendices: number; actas: number
  mensajes: { total: number; porEstado: Record<string, number> }
  actividad30d: { jobs: number; scans: number }
}
interface Instructor {
  id: string; nombre: string; email: string; rol: string; competencia: string
  createdAt: string; lastAutoScanAt: string | null
  suspendido: boolean; aceptoTerminos: boolean
  fichas: number; actas: number; mensajes: number; evidencias: number; aprendices: number
}

function fmtFecha(iso: string | null): string {
  if (!iso) return "—"
  try { return new Date(iso).toLocaleDateString("es-CO", { dateStyle: "medium" }) } catch { return "—" }
}

function Tarjeta({ icon: Icon, label, valor, sub }: { icon: any; label: string; valor: React.ReactNode; sub?: string }) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 flex items-center gap-3">
      <div className="rounded-lg bg-sena-green/10 p-2.5 flex-shrink-0">
        <Icon className="w-5 h-5 text-sena-green" />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-semibold text-gray-900 leading-tight">{valor}</p>
        <p className="text-xs text-gray-500 truncate">{label}</p>
        {sub && <p className="text-[11px] text-gray-400 truncate">{sub}</p>}
      </div>
    </div>
  )
}

export default function AdminPage() {
  const qc = useQueryClient()

  const { data: metricas, isLoading: cargandoMetricas, isError: errorMetricas } =
    useQuery<Metricas>({ queryKey: ["admin-metricas"], queryFn: () => apiFetch("/api/admin/metricas") })

  const { data: instData, isLoading: cargandoInst } =
    useQuery<{ instructores: Instructor[] }>({ queryKey: ["admin-instructores"], queryFn: () => apiFetch("/api/admin/instructores") })

  const suspender = useMutation({
    mutationFn: ({ id, suspender }: { id: string; suspender: boolean }) =>
      apiFetch(`/api/admin/instructores/${id}`, { method: "PATCH", body: JSON.stringify({ suspender }) }),
    onSuccess: (_d, v) => { toast.success(v.suspender ? "Instructor suspendido." : "Instructor reactivado."); qc.invalidateQueries({ queryKey: ["admin-instructores"] }) },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "No se pudo actualizar."),
  })

  const eliminar = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/admin/instructores/${id}`, { method: "DELETE" }),
    onSuccess: () => { toast.success("Instructor eliminado."); qc.invalidateQueries({ queryKey: ["admin-instructores"] }); qc.invalidateQueries({ queryKey: ["admin-metricas"] }) },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "No se pudo eliminar."),
  })

  const m = metricas
  const enviados = m?.mensajes.porEstado?.enviado ?? 0
  const parciales = m?.mensajes.porEstado?.parcial ?? 0

  return (
    <Layout>
      <div className="space-y-6">
        <div>
          <h1 className="text-base font-semibold text-gray-900">Administración</h1>
          <p className="text-sm text-gray-500">Métricas de la plataforma y gestión de instructores.</p>
        </div>

        {/* Métricas */}
        {cargandoMetricas ? (
          <div className="flex items-center gap-2 text-gray-500 py-6"><Loader2 className="w-4 h-4 animate-spin" /> Cargando métricas...</div>
        ) : errorMetricas ? (
          <div className="text-sm text-red-600 py-4">No se pudieron cargar las métricas (¿tienes rol de administrador?).</div>
        ) : m && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            <Tarjeta icon={Users} label="Instructores" valor={m.instructores.total} sub={`${m.instructores.activos} activos · ${m.instructores.suspendidos} suspendidos`} />
            <Tarjeta icon={FolderOpen} label="Fichas" valor={m.fichas} />
            <Tarjeta icon={FileText} label="Evidencias" valor={m.evidencias} sub={`${m.entregas} entregas · ${m.aprendices} aprendices`} />
            <Tarjeta icon={ClipboardList} label="Actas generadas" valor={m.actas} />
            <Tarjeta icon={Mail} label="Mensajes" valor={m.mensajes.total} sub={`${enviados} enviados · ${parciales} parciales`} />
            <Tarjeta icon={Activity} label="Actividad (30 días)" valor={m.actividad30d.jobs} sub={`${m.actividad30d.scans} escaneos`} />
          </div>
        )}

        {/* Instructores */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-x-auto">
          <div className="px-4 py-3 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-800">Instructores registrados</h2>
          </div>
          {cargandoInst ? (
            <div className="flex items-center gap-2 text-gray-500 p-6"><Loader2 className="w-4 h-4 animate-spin" /> Cargando...</div>
          ) : !instData?.instructores.length ? (
            <p className="text-sm text-gray-500 p-6 text-center">No hay instructores registrados.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2 font-semibold">Instructor</th>
                  <th className="text-left px-3 py-2 font-semibold">Competencia</th>
                  <th className="text-center px-3 py-2 font-semibold">Fichas</th>
                  <th className="text-center px-3 py-2 font-semibold">Evid.</th>
                  <th className="text-center px-3 py-2 font-semibold">Actas</th>
                  <th className="text-center px-3 py-2 font-semibold">Msgs</th>
                  <th className="text-left px-3 py-2 font-semibold">Registro</th>
                  <th className="text-left px-3 py-2 font-semibold">Último scan</th>
                  <th className="text-center px-3 py-2 font-semibold">Estado</th>
                  <th className="text-center px-3 py-2 font-semibold">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {instData.instructores.map(i => (
                  <tr key={i.id} className={i.suspendido ? "opacity-60" : ""}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-800">{i.nombre}</div>
                      <div className="text-gray-400">{i.email}</div>
                    </td>
                    <td className="px-3 py-2 text-gray-600">{i.competencia}</td>
                    <td className="px-3 py-2 text-center text-gray-700">{i.fichas}</td>
                    <td className="px-3 py-2 text-center text-gray-700">{i.evidencias}</td>
                    <td className="px-3 py-2 text-center text-gray-700">{i.actas}</td>
                    <td className="px-3 py-2 text-center text-gray-700">{i.mensajes}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{fmtFecha(i.createdAt)}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{fmtFecha(i.lastAutoScanAt)}</td>
                    <td className="px-3 py-2 text-center">
                      {i.rol === "superadmin"
                        ? <Badge variant="gray" className="text-xs">admin</Badge>
                        : i.suspendido
                          ? <Badge variant="destructive" className="text-xs">suspendido</Badge>
                          : <Badge variant="green" className="text-xs">activo</Badge>}
                    </td>
                    <td className="px-3 py-2">
                      {i.rol === "superadmin" ? (
                        <span className="text-gray-300">—</span>
                      ) : (
                        <div className="flex items-center justify-center gap-1">
                          <Button variant="ghost" size="sm" className="h-7 px-2"
                            title={i.suspendido ? "Reactivar" : "Suspender"}
                            disabled={suspender.isPending}
                            onClick={() => suspender.mutate({ id: i.id, suspender: !i.suspendido })}>
                            {i.suspendido ? <CheckCircle2 className="w-3.5 h-3.5 text-sena-green" /> : <Ban className="w-3.5 h-3.5 text-amber-600" />}
                          </Button>
                          <Button variant="ghost" size="sm" className="h-7 px-2"
                            title="Eliminar instructor y todos sus datos"
                            disabled={eliminar.isPending}
                            onClick={() => {
                              if (confirm(`¿Eliminar a ${i.nombre} y TODOS sus datos (fichas, evidencias, actas, mensajes)? Esta acción no se puede deshacer.`)) eliminar.mutate(i.id)
                            }}>
                            <Trash2 className="w-3.5 h-3.5 text-red-600" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  )
}
