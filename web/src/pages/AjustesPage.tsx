import { useState, useEffect, useRef } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Settings, Loader2, Mail, CheckCircle2, Trash2, FlaskConical } from "lucide-react"
import Layout from "@/components/Layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiFetch, ApiError } from "@/api/client"
import { toast } from "sonner"
import { useAuthStore } from "@/store/auth"
import { useNavigate } from "react-router-dom"

const SUPERADMIN = "ddiddimmo@gmail.com"

interface Competencia {
  id:     string
  codigo: string
  nombre: string
}

interface JobStatus {
  id:        string
  status:    string
  progreso:  number
  errorMsg:  string | null
  resultado: { found: number; nuevas: number; codigos: string[]; msg?: string } | null
}

interface ConfigCorreo {
  id:            string
  smtpHost:      string
  smtpPort:      number
  smtpUser:      string
  fromNombre:    string | null
  creadaAt:      string
  actualizadaAt: string
}

const PROVEEDORES = [
  { label: "Outlook / Office 365 (SENA)",  host: "smtp.office365.com", port: 587 },
  { label: "Gmail",                         host: "smtp.gmail.com",     port: 587 },
  { label: "Otro (avanzado)",               host: "",                   port: 587 },
] as const

function detectarProveedor(host: string): number {
  if (host === "smtp.office365.com") return 0
  if (host === "smtp.gmail.com")     return 1
  if (host)                          return 2
  return 0
}

export default function AjustesPage() {
  const queryClient = useQueryClient()
  const navigate    = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()

  const esSuperAdmin = user?.email === SUPERADMIN

  // ── Modo Dios state ────────────────────────────────────────────────────────
  const [scanJobId,       setScanJobId]       = useState<string | null>(null)
  const [scanProgreso,    setScanProgreso]     = useState(0)
  const [scanDone,        setScanDone]         = useState(false)
  const [compSeleccionada, setCompSeleccionada] = useState("")
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const { data: competencias, refetch: refetchComps } = useQuery<Competencia[]>({
    queryKey: ["competencias-admin"],
    queryFn:  () => apiFetch<Competencia[]>("/api/competencias"),
    enabled:  !!jwt && esSuperAdmin,
  })

  // Polling del job de descubrimiento
  useEffect(() => {
    if (!scanJobId || scanDone) return
    pollRef.current = setInterval(async () => {
      try {
        const status = await apiFetch<JobStatus>(`/api/jobs/${scanJobId}`)
        setScanProgreso(status.progreso)
        if (status.status === "done" || status.status === "failed") {
          clearInterval(pollRef.current!)
          setScanDone(true)
          if (status.status === "done") {
            const r = status.resultado
            toast.success(`Descubrimiento completo: ${r?.found ?? 0} competencia(s) encontrada(s)${r?.nuevas ? `, ${r.nuevas} nueva(s)` : ""}.`)
            refetchComps()
          } else {
            toast.error(status.errorMsg ?? "Error en el descubrimiento.")
          }
        }
      } catch { /* ignorar errores transitorios de red */ }
    }, 1500)
    return () => clearInterval(pollRef.current!)
  }, [scanJobId, scanDone])

  const descubrirMutation = useMutation({
    mutationFn: () => apiFetch<{ jobId: string }>("/api/ajustes/descubrir-competencias", { method: "POST" }),
    onSuccess: (r) => { setScanJobId(r.jobId); setScanProgreso(0); setScanDone(false) },
    onError:   (e) => toast.error(e instanceof ApiError ? e.message : "Error al iniciar descubrimiento."),
  })

  const simularMutation = useMutation({
    mutationFn: () => apiFetch<{ token: string; competenciaCodigo: string; competenciaNombre: string }>(
      "/api/ajustes/simular-competencia",
      { method: "POST", body: JSON.stringify({ competenciaCodigo: compSeleccionada }) }
    ),
    onSuccess: (r) => {
      setAuth(r.token, {
        id:                user!.id,
        nombre:            user!.nombre,
        email:             user!.email,
        competenciaCodigo: r.competenciaCodigo,
        competenciaNombre: r.competenciaNombre,
      })
      toast.success(`Simulando competencia ${r.competenciaCodigo}. Redirigiendo...`)
      setTimeout(() => navigate("/"), 800)
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al simular."),
  })

  const [proveedorIdx, setProveedorIdx] = useState(0)
  const [smtpHost,     setSmtpHost]     = useState("smtp.office365.com")
  const [smtpPort,     setSmtpPort]     = useState(587)
  const [smtpUser,     setSmtpUser]     = useState("")
  const [smtpPass,     setSmtpPass]     = useState("")
  const [fromNombre,   setFromNombre]   = useState("")

  useEffect(() => {
    const storedJwt = localStorage.getItem("zajuna_jwt")
    if (!storedJwt) { navigate("/login"); return }
    if (!user && storedJwt) {
      try {
        const payload = JSON.parse(atob(storedJwt.split(".")[1]))
        setAuth(storedJwt, {
          id: payload.id || "", nombre: payload.nombre || "", email: payload.email || "",
          competenciaNombre: payload.competenciaNombre || "", competenciaCodigo: payload.competenciaCodigo || "",
        })
      } catch { clearAuth(); navigate("/login") }
    }
  }, [])

  const { data: config, isLoading } = useQuery<ConfigCorreo | null>({
    queryKey: ["ajustes-correo"],
    queryFn:  () => apiFetch<ConfigCorreo | null>("/api/ajustes/correo"),
    enabled:  !!jwt,
  })

  useEffect(() => {
    if (config) {
      const idx = detectarProveedor(config.smtpHost)
      setProveedorIdx(idx)
      setSmtpHost(config.smtpHost)
      setSmtpPort(config.smtpPort)
      setSmtpUser(config.smtpUser)
      setFromNombre(config.fromNombre ?? "")
    }
  }, [config])

  function handleProveedorChange(idx: number) {
    setProveedorIdx(idx)
    const p = PROVEEDORES[idx]
    if (p.host) { setSmtpHost(p.host); setSmtpPort(p.port) }
  }

  const guardarMutation = useMutation({
    mutationFn: () => apiFetch("/api/ajustes/correo", {
      method: "POST",
      body:   JSON.stringify({ smtpHost, smtpPort, smtpUser, smtpPass: smtpPass || undefined, fromNombre }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ajustes-correo"] })
      setSmtpPass("")
      toast.success("Correo configurado correctamente.")
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al guardar."),
  })

  const probarMutation = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; error?: string }>("/api/ajustes/correo/probar", { method: "POST" }),
    onSuccess: (r) => {
      if (r.ok) toast.success("Conexión verificada. El correo está listo para enviar.")
      else      toast.error(`No se pudo conectar: ${r.error}`)
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al probar."),
  })

  const eliminarMutation = useMutation({
    mutationFn: () => apiFetch("/api/ajustes/correo", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ajustes-correo"] })
      setProveedorIdx(0); setSmtpHost("smtp.office365.com"); setSmtpPort(587)
      setSmtpUser(""); setSmtpPass(""); setFromNombre("")
      toast.success("Configuración eliminada.")
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al eliminar."),
  })

  function handleGuardar() {
    if (!smtpUser.trim()) { toast.error("El correo electrónico es obligatorio."); return }
    if (!config && !smtpPass.trim()) { toast.error("La contraseña es obligatoria."); return }
    guardarMutation.mutate()
  }

  const esAvanzado = proveedorIdx === 2

  // Nota de ayuda según proveedor
  const notaProveedor = proveedorIdx === 0
    ? "Usa tu correo y contraseña normales del SENA. Si no funciona, es probable que tu cuenta tenga verificación en dos pasos — contacta al área de sistemas del SENA."
    : proveedorIdx === 1
    ? "Gmail requiere una contraseña de aplicación, no tu contraseña normal. Activa la verificación en 2 pasos en myaccount.google.com y luego genera una contraseña de aplicación."
    : "Consulta con tu proveedor de correo el servidor SMTP y el puerto correctos."

  return (
    <Layout>
      <div className="space-y-4 max-w-xl">
        <div className="bg-white rounded-lg border border-gray-200 p-4 flex items-center gap-2">
          <Settings className="w-4 h-4 text-sena-green" />
          <h1 className="text-sm font-semibold text-gray-900">Ajustes</h1>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-5">
          <div className="flex items-center gap-2 border-b border-gray-100 pb-3">
            <Mail className="w-4 h-4 text-sena-green" />
            <h2 className="text-sm font-semibold text-gray-900">Correo para notificaciones</h2>
            {config && (
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded">
                <CheckCircle2 className="w-3 h-3" /> Configurado
              </span>
            )}
          </div>

          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Loader2 className="w-4 h-4 animate-spin" /> Cargando...
            </div>
          ) : (
            <div className="space-y-4">

              {/* Selector de proveedor */}
              <div className="space-y-1.5">
                <Label>¿Con qué correo vas a enviar las notificaciones?</Label>
                <div className="flex flex-col gap-2">
                  {PROVEEDORES.map((p, i) => (
                    <label key={i} className="flex items-center gap-2.5 cursor-pointer">
                      <input
                        type="radio"
                        name="proveedor"
                        checked={proveedorIdx === i}
                        onChange={() => handleProveedorChange(i)}
                        className="h-4 w-4 text-sena-green"
                      />
                      <span className="text-sm text-gray-700">{p.label}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Advertencia específica para Outlook/SENA */}
              {proveedorIdx === 0 && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-300 rounded-md px-3 py-2">
                  &#9888; Si tu cuenta es del SENA (@sena.edu.co), es posible que Microsoft haya deshabilitado el acceso SMTP. En ese caso usa Gmail.
                </p>
              )}

              {/* Campos avanzados solo si elige Otro */}
              {esAvanzado && (
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1.5 col-span-2">
                    <Label htmlFor="smtp-host">Servidor SMTP *</Label>
                    <Input id="smtp-host" value={smtpHost} onChange={e => setSmtpHost(e.target.value)}
                      placeholder="smtp.ejemplo.com" />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="smtp-port">Puerto</Label>
                    <Input id="smtp-port" type="number" value={smtpPort}
                      onChange={e => setSmtpPort(Number(e.target.value) || 587)} />
                  </div>
                </div>
              )}

              {/* Correo y contraseña */}
              <div className="space-y-1.5">
                <Label htmlFor="smtp-user">Tu correo electrónico *</Label>
                <Input id="smtp-user" type="email" value={smtpUser}
                  onChange={e => setSmtpUser(e.target.value)}
                  placeholder="instructor@sena.edu.co" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="smtp-pass">
                  {proveedorIdx === 1 ? "Contraseña de aplicación *" : "Contraseña *"}
                </Label>
                <Input id="smtp-pass" type="password" value={smtpPass}
                  onChange={e => setSmtpPass(e.target.value)}
                  placeholder={config ? "Dejar vacío para no cambiar" : "Tu contraseña"} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="from-nombre">Tu nombre (aparece en los correos enviados)</Label>
                <Input id="from-nombre" value={fromNombre}
                  onChange={e => setFromNombre(e.target.value)}
                  placeholder="Christiam Puentes — Instructor SENA" />
              </div>

              {/* Nota contextual */}
              <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-md px-3 py-2">
                {notaProveedor}
              </p>

              {/* Acciones */}
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
                <Button size="sm" className="bg-sena-green hover:bg-sena-green/90 text-xs"
                  onClick={handleGuardar} disabled={guardarMutation.isPending}>
                  {guardarMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                  Guardar
                </Button>
                <Button size="sm" variant="outline" className="text-xs"
                  onClick={() => probarMutation.mutate()}
                  disabled={probarMutation.isPending || !config}>
                  {probarMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                  Probar conexión
                </Button>
                {config && (
                  <Button size="sm" variant="outline"
                    className="text-xs gap-1.5 text-red-600 border-red-300 hover:bg-red-50 ml-auto"
                    onClick={() => { if (confirm("¿Eliminar la configuración de correo?")) eliminarMutation.mutate() }}
                    disabled={eliminarMutation.isPending}>
                    <Trash2 className="w-3 h-3" /> Eliminar
                  </Button>
                )}
              </div>

            </div>
          )}
        </div>

        {/* ── Modo Dios: solo para superadmin ─────────────────────────────── */}
        {esSuperAdmin && (
          <div className="bg-white rounded-lg border border-amber-300 p-5 space-y-5">
            <div className="flex items-center gap-2 border-b border-amber-100 pb-3">
              <FlaskConical className="w-4 h-4 text-amber-600" />
              <h2 className="text-sm font-semibold text-gray-900">Simulador de Competencias</h2>
              <span className="ml-auto text-xs text-amber-700 bg-amber-50 border border-amber-300 px-2 py-0.5 rounded">SuperAdmin</span>
            </div>

            {/* Paso 1: Descubrir */}
            <div className="space-y-2">
              <p className="text-xs text-gray-600">
                Extrae automáticamente todos los códigos de competencia presentes en tus fichas sincronizadas y los registra en la base de datos.
              </p>
              <Button
                size="sm"
                className="bg-amber-600 hover:bg-amber-700 text-white text-xs"
                onClick={() => descubrirMutation.mutate()}
                disabled={descubrirMutation.isPending || (!!scanJobId && !scanDone)}
              >
                {(descubrirMutation.isPending || (!!scanJobId && !scanDone))
                  ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Escaneando...</>
                  : "Escanear Zajuna para descubrir competencias"}
              </Button>

              {/* Barra de progreso */}
              {scanJobId && (
                <div className="space-y-1">
                  <div className="w-full bg-gray-100 rounded-full h-1.5">
                    <div
                      className="bg-amber-500 h-1.5 rounded-full transition-all duration-500"
                      style={{ width: `${scanProgreso}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-500">
                    {scanDone ? "Completado" : `${scanProgreso}%...`}
                  </p>
                </div>
              )}
            </div>

            {/* Paso 2: Simular */}
            <div className="space-y-2 pt-2 border-t border-amber-100">
              <Label className="text-xs">Competencia a simular</Label>
              {!competencias || competencias.length === 0 ? (
                <p className="text-xs text-gray-400 italic">Sin competencias en DB. Ejecuta el escaneo primero.</p>
              ) : (
                <select
                  className="w-full text-xs border border-gray-200 rounded-md px-3 py-2 bg-white focus:outline-none focus:ring-1 focus:ring-amber-400"
                  value={compSeleccionada}
                  onChange={e => setCompSeleccionada(e.target.value)}
                >
                  <option value="">— Selecciona una competencia —</option>
                  {competencias.map(c => (
                    <option key={c.id} value={c.codigo}>
                      [{c.codigo}] {c.nombre}
                    </option>
                  ))}
                </select>
              )}
              <Button
                size="sm"
                variant="outline"
                className="text-xs border-amber-400 text-amber-700 hover:bg-amber-50"
                onClick={() => simularMutation.mutate()}
                disabled={!compSeleccionada || simularMutation.isPending}
              >
                {simularMutation.isPending
                  ? <><Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> Aplicando...</>
                  : "Simular esta competencia"}
              </Button>
              {user?.competenciaCodigo && (
                <p className="text-xs text-gray-400">
                  Activa ahora: <span className="font-mono text-gray-700">{user.competenciaCodigo}</span> — {user.competenciaNombre}
                </p>
              )}
            </div>
          </div>
        )}

      </div>
    </Layout>
  )
}
