# Plan de despliegue — Lote plan 010 (pendiente)

> **Qué se despliega:** el lote `plan 010` ya en `origin/master` (commit `4868793`): estados en Excel (BD/RE/FP/RV), página de Ayuda + tour, registro sin competencia, y la parte legal (consentimiento + `/terminos`).
> **Estado:** en GitHub, **NO desplegado** al VPS. El VPS (`167.233.61.39`, `/opt/helper`) sigue corriendo lo anterior (`bb7b270`).
> **Diferencia clave con el último deploy:** ⚠️ hay **dependencia NUEVA** (`driver.js`) → hace falta `npm install`. 🟢 **NO hay migración** de base de datos.

---

## 0. Antes de empezar (1 min)
- Tené claro que esto **sí afecta a los instructores** en cuanto reinicies pm2.
- ✅ Ya verificado en local: build TS, motor de actas 29/29, Excel probado en vivo, smoke test de registro/competencia/términos OK.
- ⚠️ El **texto legal de `/terminos` es borrador** — si lo querés ajustar, hacelo ANTES (editar → commit → push) o después (editar → redeploy). No bloquea el deploy.

## 1. Conectarse
```bash
ssh root@167.233.61.39
cd /opt/helper
```

## 2. Traer el código
```bash
git pull origin master      # debe traer hasta 4868793
git log --oneline -1        # confirmá: 4868793 docs(plan): marcar plan 010...
```

## 3. Instalar la dependencia nueva (driver.js) — ⚠️ NO saltar
```bash
cd web && npm install && cd ..
```
> Si te saltás esto, el build del front falla con "Cannot find module 'driver.js'".

## 4. Rebuild del front
```bash
cd web && npm run build && cd ..
```
> Regenera `web/dist` (que el VPS sirve) con la página de Ayuda, `/terminos`, el tour y el Excel nuevo. (`lang="es"` ya venía del deploy anterior.)

## 5. Reiniciar
```bash
pm2 restart all     # recarga api + workers
pm2 ls              # confirmá ambos "online"
```
> 🟢 **No corras `prisma migrate deploy`** — este lote no toca la base de datos.

## 6. Verificar (2 min, con caché limpia)
En el navegador, **Ctrl + Shift + R** (o incógnito), y comprobá:
- [ ] Aparece **"Ayuda"** en el menú → la página abre con las 6 guías.
- [ ] El **tour** sale la primera vez (o con "Ver tutorial de nuevo").
- [ ] `http://167.233.61.39:3000/terminos` abre **sin estar logueado**.
- [ ] En **Registro**: ya **no** pide competencia, y aparece la **casilla de consentimiento** (el botón "Crear cuenta" queda gris hasta marcarla).
- [ ] En **Ajustes** (como instructor, no superadmin): aparece la tarjeta **"Mi competencia"**.
- [ ] Descargá un **Excel** de una ficha → la **Leyenda** trae BD/RE/FP/RV.

## 7. Si algo sale mal — rollback rápido
```bash
cd /opt/helper
git reset --hard bb7b270    # vuelve al estado anterior (ya probado en prod)
cd web && npm run build && cd ..
pm2 restart all
```
> `bb7b270` es el commit que estaba corriendo bien antes de este lote.

---

## Notas
- **Caché del navegador**: tras CADA deploy hay que limpiarla (Ctrl+Shift+R) o se ve el JS viejo — pasó la vez anterior.
- **Texto legal**: borrador alineado con Ley 1581; conviene revisión de alguien calificado del SENA. Editable sin riesgo (es solo contenido).
