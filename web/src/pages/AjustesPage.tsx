import { useState, useEffect } from "react"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { Settings, Loader2, Mail, CheckCircle2, AlertCircle, Trash2 } from "lucide-react"
import Layout from "@/components/Layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiFetch, ApiError } from "@/api/client"
import { toast } from "sonner"
import { useAuthStore } from "@/store/auth"
import { useNavigate } from "react-router-dom"

interface ConfigCorreo {
  id:            string
  smtpHost:      string
  smtpPort:      number
  smtpUser:      string
  fromNombre:    string | null
  creadaAt:      string
  actualizadaAt: string
}

export default function AjustesPage() {
  const queryClient = useQueryClient()
  const navigate    = useNavigate()
  const { jwt, user, clearAuth, setAuth } = useAuthStore()

  const [smtpHost,   setSmtpHost]   = useState("")
  const [smtpPort,   setSmtpPort]   = useState(587)
  const [smtpUser,   setSmtpUser]   = useState("")
  const [smtpPass,   setSmtpPass]   = useState("")
  const [fromNombre, setFromNombre] = useState("")

  useEffect(() => {
    const storedJwt = localStorage.getItem("zajuna_jwt")
    if (!storedJwt) { navigate("/login"); return }
    if (!user && storedJwt) {
      try {
        const payload = JSON.parse(atob(storedJwt.split(".")[1]))
        setAuth(storedJwt, {
          id:                payload.id || "",
          nombre:            payload.nombre || "",
          email:             payload.email || "",
          competenciaNombre: payload.competenciaNombre || "",
          competenciaCodigo: payload.competenciaCodigo || "",
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
      setSmtpHost(config.smtpHost)
      setSmtpPort(config.smtpPort)
      setSmtpUser(config.smtpUser)
      setFromNombre(config.fromNombre ?? "")
    }
  }, [config])

  const guardarMutation = useMutation({
    mutationFn: () => apiFetch("/api/ajustes/correo", {
      method: "POST",
      body:   JSON.stringify({ smtpHost, smtpPort, smtpUser, smtpPass, fromNombre }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ajustes-correo"] })
      setSmtpPass("")
      toast.success("Configuración SMTP guardada.")
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al guardar."),
  })

  const probarMutation = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; error?: string }>(
      "/api/ajustes/correo/probar", { method: "POST" }
    ),
    onSuccess: (r) => {
      if (r.ok) toast.success("Conexión SMTP verificada correctamente.")
      else      toast.error(`Conexión falló: ${r.error}`)
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al probar."),
  })

  const eliminarMutation = useMutation({
    mutationFn: () => apiFetch("/api/ajustes/correo", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["ajustes-correo"] })
      setSmtpHost(""); setSmtpPort(587); setSmtpUser(""); setSmtpPass(""); setFromNombre("")
      toast.success("Configuración eliminada.")
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Error al eliminar."),
  })

  function handleGuardar() {
    if (!smtpHost.trim() || !smtpUser.trim()) {
      toast.error("Servidor SMTP y usuario son obligatorios.")
      return
    }
    if (!config && !smtpPass.trim()) {
      toast.error("La contraseña es obligatoria al crear la configuración.")
      return
    }
    guardarMutation.mutate()
  }

  return (
    <Layout>
      <div className="space-y-4 max-w-2xl">
        <div className="bg-white rounded-lg border border-gray-200 p-4 flex items-center gap-2">
          <Settings className="w-4 h-4 text-sena-green" />
          <h1 className="text-sm font-semibold text-gray-900">Ajustes</h1>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
          <div className="flex items-center gap-2 border-b border-gray-100 pb-3">
            <Mail className="w-4 h-4 text-sena-green" />
            <h2 className="text-sm font-semibold text-gray-900">Configuración de correo saliente</h2>
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
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="smtp-host">Servidor SMTP *</Label>
                  <Input id="smtp-host" value={smtpHost} onChange={e => setSmtpHost(e.target.value)}
                    placeholder="smtp.gmail.com" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="smtp-port">Puerto</Label>
                  <Input id="smtp-port" type="number" value={smtpPort}
                    onChange={e => setSmtpPort(Number(e.target.value) || 587)} />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="smtp-user">Usuario (email) *</Label>
                <Input id="smtp-user" type="email" value={smtpUser}
                  onChange={e => setSmtpUser(e.target.value)}
                  placeholder="instructor@sena.edu.co" />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="smtp-pass">Contraseña</Label>
                <Input id="smtp-pass" type="password" value={smtpPass}
                  onChange={e => setSmtpPass(e.target.value)}
                  placeholder={config ? "••••••••  (dejar vacío para no cambiar)" : "Contraseña de aplicación (no tu contraseña normal)"} />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="from-nombre">Nombre del remitente</Label>
                <Input id="from-nombre" value={fromNombre}
                  onChange={e => setFromNombre(e.target.value)}
                  placeholder="Christiam Puentes — SENA" />
              </div>

              <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 space-y-1">
                <p className="font-semibold flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" /> Cómo obtener una contraseña SMTP</p>
                <p><strong>Gmail:</strong> activa la verificación en 2 pasos y genera una <em>Contraseña de aplicación</em> en <a className="underline" href="https://myaccount.google.com" target="_blank" rel="noreferrer">myaccount.google.com</a>.</p>
                <p><strong>Outlook / Office 365:</strong> usa <code>smtp.office365.com</code> en puerto <code>587</code>.</p>
                <p>La contraseña se guarda cifrada con AES-256-GCM en el servidor.</p>
              </div>

              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
                <Button size="sm" className="bg-sena-green hover:bg-sena-green/90 text-xs"
                  onClick={handleGuardar} disabled={guardarMutation.isPending}>
                  {guardarMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                  Guardar
                </Button>
                <Button size="sm" variant="outline" className="text-xs"
                  onClick={() => probarMutation.mutate()} disabled={probarMutation.isPending || !config}>
                  {probarMutation.isPending && <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />}
                  Probar conexión
                </Button>
                {config && (
                  <Button size="sm" variant="outline" className="text-xs gap-1.5 text-red-600 border-red-300 hover:bg-red-50 ml-auto"
                    onClick={() => { if (confirm("¿Eliminar configuración SMTP?")) eliminarMutation.mutate() }}
                    disabled={eliminarMutation.isPending}>
                    <Trash2 className="w-3 h-3" /> Eliminar
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Layout>
  )
}
