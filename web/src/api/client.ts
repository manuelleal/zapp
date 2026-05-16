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
