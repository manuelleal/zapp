import { create } from "zustand"

const JWT_KEY = "zajuna_jwt"

interface User {
  id: string
  nombre: string
  email: string
  competenciaNombre: string
  competenciaCodigo: string
}

interface AuthState {
  jwt: string | null
  user: User | null
  setAuth: (jwt: string, user: User) => void
  clearAuth: () => void
  getJwt: () => string | null
}

export const useAuthStore = create<AuthState>((set) => ({
  jwt: localStorage.getItem(JWT_KEY),
  user: null,
  setAuth: (jwt, user) => {
    localStorage.setItem(JWT_KEY, jwt)
    set({ jwt, user })
  },
  clearAuth: () => {
    localStorage.removeItem(JWT_KEY)
    set({ jwt: null, user: null })
  },
  getJwt: () => localStorage.getItem(JWT_KEY),
}))
