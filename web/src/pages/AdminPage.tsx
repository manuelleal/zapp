/**
 * AdminPage.tsx — Panel del DUEÑO de la app (rol superadmin). Muestra las métricas
 * globales de la plataforma y la lista de instructores registrados, con acciones de
 * suspender/reactivar y eliminar. Consume /api/admin/* (todos exigen superadmin).
 *
 * Visible solo para superadmin: el item de nav y la ruta se ocultan a instructores,
 * y el backend devuelve 403 igual (defensa en profundidad).
 */
import { useState } from "react"
import Layout from "@/components/Layout"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { apiFetch, ApiError } from "@/api/client"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Users, FolderOpen, FileText, ClipboardList, Mail, Activity, Loader2, Ban, Trash2, CheckCircle2, KeyRound, Copy, Cpu, UserPlus } from "lucide-react"
import { toast } from "sonner"

interface Metricas {
  instructores: { total: number; suspendidos: number; activos: number }
  fichas: number; evidencias: number; entregas: number; aprendices: number; actas: number
  mensajes: { total: number; porEstado: Record<string, number> }
  actividad30d: { jobs: number; scans: number }
  ia?: { tokensTotal: number; tokens30d: number; porProveedor: Record<string, number> }
}
interface Instructor {
  id: string; nombre: string; email: string; rol: string; competencia: string
  createdAt: string; lastAutoScanAt: string | null; lastLoginAt: string | null
  suspendido: boolean; aceptoTerminos: boolean
  fichas: number; actas: number; mensajes: number; evidencias: number; aprendices: number; tokens: number
}

function fmtFecha(iso: string | null): string {
  if (!iso) return "—"
  try { return new Date(iso).toLocaleDateString("es-CO", { dateStyle: "medium" }) } catch { return "—" }
}

// Antigüedad / última actividad en formato corto ("hoy", "hace 3 d", "hace 2 meses").
function haceCuanto(iso: string | null): string {
  if (!iso) return "—"
  const dias = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (dias <= 0) return "hoy"
  if (dias === 1) return "ayer"
  if (dias < 30) return `hace ${dias} d`
  const meses = Math.floor(dias / 30)
  return `hace ${meses} ${meses > 1 ? "meses" : "mes"}`
}

// Tokens en formato compacto (12.3k, 1.2M) para que la tabla no se desborde.
function fmtTokens(n: number): string {
  if (!n) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
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
  // Resultado del último reset de contraseña (se muestra UNA vez en el diálogo).
  const [resetInfo, setResetInfo] = useState<{ nombre: string; tempPassword: string } | null>(null)
  // Formulario "Crear administrador".
  const [adminOpen, setAdminOpen] = useState(false)
  const [adminNombre, setAdminNombre] = useState("")
  const [adminEmail, setAdminEmail] = useState("")
  const [adminPass, setAdminPass] = useState("")

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

  const resetPassword = useMutation({
    mutationFn: (id: string) => apiFetch<{ tempPassword: string; nombre: string }>(`/api/admin/instructores/${id}/reset-password`, { method: "POST" }),
    onSuccess: (d) => setResetInfo({ nombre: d.nombre, tempPassword: d.tempPassword }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "No se pudo restablecer la contraseña."),
  })

  const crearAdmin = useMutation({
    mutationFn: () => apiFetch("/api/admin/administradores", { method: "POST", body: JSON.stringify({ nombre: adminNombre, email: adminEmail, password: adminPass }) }),
    onSuccess: () => {
      toast.success("Administrador creado.")
      setAdminOpen(false); setAdminNombre(""); setAdminEmail(""); setAdminPass("")
      qc.invalidateQueries({ queryKey: ["admin-instructores"] }); qc.invalidateQueries({ queryKey: ["admin-metricas"] })
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "No se pudo crear el administrador."),
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
            {m.ia && <Tarjeta icon={Cpu} label="Tokens IA" valor={fmtTokens(m.ia.tokensTotal)} sub={`${fmtTokens(m.ia.tokens30d)} en 30 días`} />}
          </div>
        )}

        {/* Instructores */}
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-x-auto">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-gray-800">Instructores registrados</h2>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => setAdminOpen(true)}>
              <UserPlus className="w-3.5 h-3.5" /> Crear administrador
            </Button>
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
                  <th className="text-center px-3 py-2 font-semibold">Tokens</th>
                  <th className="text-left px-3 py-2 font-semibold">Registro</th>
                  <th className="text-left px-3 py-2 font-semibold">Último acceso</th>
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
                    <td className="px-3 py-2 text-center text-gray-700" title={`${i.tokens.toLocaleString("es-CO")} tokens`}>{fmtTokens(i.tokens)}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap" title={fmtFecha(i.createdAt)}>{haceCuanto(i.createdAt)}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap" title={fmtFecha(i.lastLoginAt)}>{haceCuanto(i.lastLoginAt)}</td>
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
                            title="Restablecer contraseña"
                            disabled={resetPassword.isPending}
                            onClick={() => {
                              if (confirm(`¿Restablecer la contraseña de ${i.nombre}? Se generará una contraseña temporal que deberás entregarle.`)) resetPassword.mutate(i.id)
                            }}>
                            <KeyRound className="w-3.5 h-3.5 text-blue-600" />
                          </Button>
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

      {/* Diálogo: contraseña temporal generada (se muestra una sola vez) */}
      <Dialog open={!!resetInfo} onOpenChange={(o) => { if (!o) setResetInfo(null) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Contraseña temporal</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            Entrégale esta contraseña a <span className="font-medium text-gray-800">{resetInfo?.nombre}</span>. No se volverá a mostrar; si la pierdes, genera otra.
          </p>
          <div className="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
            <code className="text-sm font-mono flex-1 select-all break-all">{resetInfo?.tempPassword}</code>
            <Button variant="outline" size="sm" className="h-7 px-2 gap-1"
              onClick={() => { if (resetInfo) { navigator.clipboard?.writeText(resetInfo.tempPassword); toast.success("Copiada al portapapeles.") } }}>
              <Copy className="w-3.5 h-3.5" /> Copiar
            </Button>
          </div>
          <DialogFooter>
            <Button className="bg-sena-green hover:bg-sena-green/90" onClick={() => setResetInfo(null)}>Listo</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Diálogo: crear cuenta solo-admin (sin credenciales Zajuna) */}
      <Dialog open={adminOpen} onOpenChange={(o) => { if (!o) setAdminOpen(false) }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Crear administrador</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-3"
            onSubmit={(e) => { e.preventDefault(); if (adminNombre && adminEmail && adminPass.length >= 6) crearAdmin.mutate() }}
          >
            <p className="text-xs text-gray-500">
              Cuenta de administrador (no instructor): entra al panel y ve todo, sin necesidad de credenciales de la plataforma ni competencia.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="admin-nombre">Nombre</Label>
              <Input id="admin-nombre" value={adminNombre} onChange={(e) => setAdminNombre(e.target.value)} placeholder="Nombre del administrador" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-email">Email</Label>
              <Input id="admin-email" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} placeholder="admin@ejemplo.com" required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="admin-pass">Contraseña</Label>
              <Input id="admin-pass" type="password" value={adminPass} onChange={(e) => setAdminPass(e.target.value)} placeholder="Mínimo 6 caracteres" required />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAdminOpen(false)}>Cancelar</Button>
              <Button type="submit" className="bg-sena-green hover:bg-sena-green/90" disabled={crearAdmin.isPending || !adminNombre || !adminEmail || adminPass.length < 6}>
                {crearAdmin.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "Crear"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Layout>
  )
}
