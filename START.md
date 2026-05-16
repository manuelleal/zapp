# 🚀 Levantar el servidor — guía corta

## Cada vez que empiezas a trabajar

```powershell
# 1. Asegurar que Redis está corriendo (Docker Desktop)
docker start zajuna-redis-1

# 2. Matar nodes viejos (importante: workers de BullMQ leen config solo al arrancar)
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

# 3. Arrancar el server (incluye los 4 workers in-process)
node api/src/server.js
```

Abre <http://localhost:3000> y haz **hard refresh** (`Ctrl+Shift+R`) si cambiaste algo del frontend.

---

## Verificación rápida (si algo falla)

```powershell
# ¿Redis vivo?
docker exec zajuna-redis-1 redis-cli PING        # debe responder PONG

# ¿Postgres vivo? (si tienes un compose o servicio local)
# El server fallará con error de Prisma si no lo está.

# ¿Puerto 3000 libre?
Test-NetConnection 127.0.0.1 -Port 3000 -InformationLevel Quiet
```

---

## Rebuild del frontend (cuando edites `web/`)

```powershell
cd web
npm run build
cd ..
# El server ya sirve web/dist, no hace falta reiniciarlo si solo cambian archivos estáticos
```

---

## Apagado limpio

```powershell
# Ctrl+C en la terminal del server. O si quedó suelto:
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force

# Redis lo puedes dejar corriendo; si quieres pararlo:
docker stop zajuna-redis-1
```

---

## Cosas que se rompen seguido

| Síntoma | Causa | Fix |
|---|---|---|
| `ECONNREFUSED 6379` | Redis no está corriendo | `docker start zajuna-redis-1` |
| `/dashboard` da 404 | Server viejo (sin SPA fallback) | Mata nodes y relanza |
| Workers usan código viejo tras un commit | `concurrency` y handlers se leen al arrancar | Mata nodes y relanza |
| `Bind 6379 already allocated` al hacer `docker run` | Ya hay un Redis arriba | Usa `docker start zajuna-redis-1` (no `run`) |
