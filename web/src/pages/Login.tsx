import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { useAuthStore } from "@/store/auth"

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
  const [regPass2, setRegPass2] = useState("")
  const [regZajunaUser, setRegZajunaUser] = useState("")
  const [regZajunaPass, setRegZajunaPass] = useState("")
  // Consentimiento obligatorio (Ley 1581): el botón de registro queda deshabilitado
  // hasta marcar la casilla. La competencia ya NO se pide aquí (se elige en Ajustes).
  const [regAcepto, setRegAcepto] = useState(false)
  const [regError, setRegError] = useState("")
  const [regOk, setRegOk]       = useState("")
  const [regLoading, setRegLoading] = useState(false)

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
    setRegOk("")
    // Validar que las dos contraseñas coincidan antes de enviar.
    if (regPass !== regPass2) {
      setRegError("Las contraseñas no coinciden.")
      return
    }
    // El consentimiento (Ley 1581) es obligatorio para registrarse.
    if (!regAcepto) {
      setRegError("Debes aceptar los Términos y el tratamiento de datos personales.")
      return
    }
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
          aceptoTerminos: true,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setRegError(data.error || "Error al crear la cuenta.")
        return
      }
      setRegPass("")
      setRegPass2("")
      setRegZajunaPass("")
      // Registro cerrado: si la cuenta quedó pendiente de aprobación, NO se inicia
      // sesión; se muestra el aviso y el instructor espera a que el admin lo apruebe.
      if (data.pendiente) {
        setRegOk(data.message || "Tu cuenta fue creada y está pendiente de aprobación por el administrador.")
        return
      }
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
            <div className="font-bold text-lg text-gray-900">Helper</div>
            <div className="text-sm text-gray-500">Gestión de fichas de formación</div>
          </div>
        </div>

        <Card>
          {/* Tabs */}
          <CardHeader className="pb-0">
            <div className="flex gap-1 border-b">
              <button
                type="button"
                onClick={() => { setTab("login"); setLoginError(""); setRegError(""); setRegOk("") }}
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
                onClick={() => { setTab("register"); setLoginError(""); setRegError(""); setRegOk("") }}
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-pass">Contraseña</Label>
                    <Input
                      id="reg-pass"
                      type="password"
                      placeholder="Mínimo 6 caracteres"
                      required
                      autoComplete="new-password"
                      value={regPass}
                      onChange={(e) => setRegPass(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-pass2">Repetir contraseña</Label>
                    <Input
                      id="reg-pass2"
                      type="password"
                      placeholder="••••••••"
                      required
                      autoComplete="new-password"
                      value={regPass2}
                      onChange={(e) => setRegPass2(e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-xs text-gray-500 pt-1">
                  Credenciales de tu plataforma institucional (para escanear tus fichas). Se guardan cifradas y no se comparten.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-zajuna-user">Documento (usuario institucional)</Label>
                    <Input
                      id="reg-zajuna-user"
                      placeholder="Número de documento"
                      required
                      value={regZajunaUser}
                      onChange={(e) => setRegZajunaUser(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="reg-zajuna-pass">Contraseña SENA</Label>
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
                {/* Consentimiento obligatorio (Ley 1581). El link abre /terminos en
                    pestaña nueva (página pública, sin sesión). */}
                <label className="flex items-start gap-2.5 cursor-pointer pt-1">
                  <input
                    type="checkbox"
                    checked={regAcepto}
                    onChange={(e) => setRegAcepto(e.target.checked)}
                    className="mt-0.5 h-4 w-4 text-sena-green"
                  />
                  <span className="text-xs text-gray-600 leading-relaxed">
                    Acepto los{" "}
                    <a
                      href="/terminos"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-sena-green underline hover:text-sena-green/80"
                    >
                      Términos y el tratamiento de datos personales
                    </a>{" "}
                    (Ley 1581 de 2012).
                  </span>
                </label>
                {regOk && (
                  <p className="text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-md">{regOk}</p>
                )}
                {regError && (
                  <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-md">{regError}</p>
                )}
                <Button type="submit" className="w-full bg-sena-green hover:bg-sena-green/90" disabled={regLoading || !regAcepto}>
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
