import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { useAuthStore } from "@/store/auth"

const COMPETENCIAS = [
  { codigo: "240202501", nombre: "Inglés" },
  { codigo: "220501046", nombre: "Bases de datos" },
  { codigo: "220501040", nombre: "Análisis y desarrollo" },
  { codigo: "228118003", nombre: "Programación de software" },
]

type Tab = "login" | "register"

export default function Login() {
  const [tab, setTab] = useState<Tab>("login")
  const navigate = useNavigate()
  const setAuth = useAuthStore((s) => s.setAuth)

  // Login state
  const [loginEmail, setLoginEmail] = useState("")
  const [loginPass, setLoginPass] = useState("")
  const [loginError, setLoginError] = useState("")
  const [loginLoading, setLoginLoading] = useState(false)

  // Register state
  const [regNombre, setRegNombre] = useState("")
  const [regEmail, setRegEmail] = useState("")
  const [regPass, setRegPass] = useState("")
  const [regZajunaUser, setRegZajunaUser] = useState("")
  const [regZajunaPass, setRegZajunaPass] = useState("")
  const [regCompetencia, setRegCompetencia] = useState("")
  const [regCodigoManual, setRegCodigoManual] = useState("")
  const [regError, setRegError] = useState("")
  const [regLoading, setRegLoading] = useState(false)

  const competenciaEsOtra = regCompetencia === "otra"
  const codigoFinal = competenciaEsOtra ? regCodigoManual.trim() : regCompetencia
  const nombreFinal = competenciaEsOtra
    ? (regCodigoManual.trim() || "Otra")
    : (COMPETENCIAS.find(c => c.codigo === regCompetencia)?.nombre || "")

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoginError("")
    setLoginLoading(true)
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: loginEmail, password: loginPass }),
      })
      const data = await res.json()
      if (!res.ok) {
        setLoginError(data.error || "Error al iniciar sesión.")
        return
      }
      setAuth(data.token, data.user)
      navigate("/dashboard")
    } catch {
      setLoginError("No se pudo conectar al servidor.")
    } finally {
      setLoginLoading(false)
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    setRegError("")
    setRegLoading(true)
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nombre: regNombre,
          email: regEmail,
          password: regPass,
          zajunaUser: regZajunaUser,
          zajunaPass: regZajunaPass,
          competenciaCodigo: codigoFinal,
          competenciaNombre: nombreFinal,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setRegError(data.error || "Error al crear la cuenta.")
        return
      }
      setRegPass("")
      setRegZajunaPass("")
      setAuth(data.token, data.user)
      navigate("/dashboard")
    } catch {
      setRegError("No se pudo conectar al servidor.")
    } finally {
      setRegLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-sena-green rounded-lg flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-6 h-6 fill-white">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </div>
          <div>
            <div className="font-bold text-lg text-gray-900">Zajuna Manager</div>
            <div className="text-sm text-gray-500">Gestión de fichas SENA</div>
          </div>
        </div>

        <Card>
          {/* Tabs */}
          <CardHeader className="pb-0">
            <div className="flex gap-1 border-b">
              <button
                type="button"
                onClick={() => { setTab("login"); setLoginError(""); setRegError("") }}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === "login"
                    ? "border-sena-green text-sena-green"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Iniciar sesión
              </button>
              <button
                type="button"
                onClick={() => { setTab("register"); setLoginError(""); setRegError("") }}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === "register"
                    ? "border-sena-green text-sena-green"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                Registrarse
              </button>
            </div>
          </CardHeader>

          <CardContent className="pt-6">
            {tab === "login" ? (
              <form onSubmit={handleLogin} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="login-email">Email</Label>
                  <Input
                    id="login-email"
                    type="email"
                    placeholder="tu@email.com"
                    required
                    autoComplete="email"
                    value={loginEmail}
                    onChange={(e) => setLoginEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="login-pass">Contraseña</Label>
                  <Input
                    id="login-pass"
                    type="password"
                    placeholder="••••••••"
                    required
                    autoComplete="current-password"
                    value={loginPass}
                    onChange={(e) => setLoginPass(e.target.value)}
                  />
                </div>
                {loginError && (
                  <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">{loginError}</p>
                )}
                <Button type="submit" className="w-full bg-sena-green hover:bg-sena-green/90" disabled={loginLoading}>
                  {loginLoading ? "Entrando..." : "Entrar"}
                </Button>
              </form>
            ) : (
              <form onSubmit={handleRegister} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="reg-nombre">Nombre completo</Label>
                  <Input
                    id="reg-nombre"
                    placeholder="Juan Pérez"
                    required
                    value={regNombre}
                    onChange={(e) => setRegNombre(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-email">Email</Label>
                  <Input
                    id="reg-email"
                    type="email"
                    placeholder="tu@email.com"
                    required
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-pass">Contraseña (plataforma)</Label>
                  <Input
                    id="reg-pass"
                    type="password"
                    placeholder="••••••••"
                    required
                    value={regPass}
                    onChange={(e) => setRegPass(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-zajuna-user">Cédula Zajuna</Label>
                    <Input
                      id="reg-zajuna-user"
                      placeholder="1052499107"
                      required
                      value={regZajunaUser}
                      onChange={(e) => setRegZajunaUser(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-zajuna-pass">Contraseña Zajuna</Label>
                    <Input
                      id="reg-zajuna-pass"
                      type="password"
                      placeholder="••••••••"
                      required
                      value={regZajunaPass}
                      onChange={(e) => setRegZajunaPass(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="reg-competencia">Competencia</Label>
                  <select
                    id="reg-competencia"
                    required
                    value={regCompetencia}
                    onChange={(e) => setRegCompetencia(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  >
                    <option value="" disabled>Selecciona tu competencia</option>
                    {COMPETENCIAS.map((c) => (
                      <option key={c.codigo} value={c.codigo}>
                        {c.nombre} ({c.codigo})
                      </option>
                    ))}
                    <option value="otra">Otra (ingresar código manual)</option>
                  </select>
                  {competenciaEsOtra && (
                    <Input
                      className="mt-2"
                      placeholder="Código de competencia ej: 220501043"
                      value={regCodigoManual}
                      onChange={e => setRegCodigoManual(e.target.value)}
                      required
                    />
                  )}
                </div>
                {regError && (
                  <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">{regError}</p>
                )}
                <Button type="submit" className="w-full bg-sena-green hover:bg-sena-green/90" disabled={regLoading}>
                  {regLoading ? "Creando cuenta..." : "Crear cuenta"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
