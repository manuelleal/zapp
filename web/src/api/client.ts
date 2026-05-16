const JWT_KEY = "zajuna_jwt"

function getJwt(): string | null {
  return localStorage.getItem(JWT_KEY)
}

function clearJwt(): void {
  localStorage.removeItem(JWT_KEY)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export async function authFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    ...(opts.headers as Record<string, string> || {}),
  }

  if (opts.body != null && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json"
  }

  const jwt = getJwt()
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`

  const res = await fetch(url, { ...opts, headers })

  if (res.status === 401) {
    clearJwt()
    window.location.href = "/login"
    throw new ApiError(401, "Sesión expirada. Inicia sesión de nuevo.")
  }

  return res
}

export async function apiFetch<T>(url: string, opts: RequestInit = {}): Promise<T> {
  const res = await authFetch(url, opts)
  const data = await res.json()
  if (!res.ok) {
    throw new ApiError(res.status, data?.error || `Error ${res.status}`, data)
  }
  return data as T
}

// Retry wrapper (patron Extension Z `tn`): reintenta N veces con delay exponencial.
// Solo reintenta errores de red; errores HTTP ≥400 se lanzan inmediatamente.
export async function apiFetchWithRetry<T>(
  url: string,
  opts: RequestInit = {},
  { retries = 3, delay = 2000 }: { retries?: number; delay?: number } = {},
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await apiFetch<T>(url, opts)
    } catch (e) {
      if (e instanceof ApiError) throw e   // errores HTTP no se reintentan
      lastErr = e
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, delay * (attempt + 1)))
    }
  }
  throw lastErr
}

// Cache local de configuración de evidencias (patron Extension Z EZ_configEvs_).
// TTL: 4 horas — igual que el backend.
const CONFIG_CACHE_TTL_MS = 4 * 60 * 60 * 1000

export const configCache = {
  key: (evidenciaId: string) => `zajuna_configEvs_${evidenciaId}`,
  get(evidenciaId: string): unknown | null {
    try {
      const raw = localStorage.getItem(this.key(evidenciaId))
      if (!raw) return null
      const { value, ts } = JSON.parse(raw)
      if (Date.now() - ts > CONFIG_CACHE_TTL_MS) { localStorage.removeItem(this.key(evidenciaId)); return null }
      return value
    } catch { return null }
  },
  set(evidenciaId: string, value: unknown): void {
    try { localStorage.setItem(this.key(evidenciaId), JSON.stringify({ value, ts: Date.now() })) } catch { /* localStorage full */ }
  },
  invalidate(evidenciaId: string): void {
    localStorage.removeItem(this.key(evidenciaId))
  },
}
