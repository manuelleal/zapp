/**
 * api/src/lib/competencia.js — Resolución robusta de la competencia del instructor.
 *
 * PROBLEMA QUE RESUELVE (bug recurrente "cargo los RAPs y al instructor no le aparecen"):
 *   `User.competenciaId` es un FK al cuid de `Competencia`, pero ese cuid es VOLÁTIL:
 *   cambia cada vez que se (re)siembran las competencias/RAPs, porque los scripts de
 *   carga crean filas nuevas (cuid nuevo). El identificador ESTABLE es el código
 *   (`User.competenciaCodigo` ↔ `Competencia.codigo`, que es @unique).
 *
 *   Secuencia que rompía todo:
 *     1) El instructor se registra ANTES de que existan los RAPs de su programa →
 *        `register` deja `competenciaId = null` (solo lo setea si la competencia ya
 *        existe, ver auth.js).
 *     2) Después se CARGAN los RAPs (se crea la `Competencia` con un cuid nuevo).
 *     3) Pero `user.competenciaId` sigue en null (o apuntando a un cuid viejo) →
 *        `GET /api/raps` filtra por competenciaId → no encuentra nada → "No hay RAPs".
 *
 * SOLUCIÓN: resolver SIEMPRE por el código estable y AUTO-SANAR el FK (persistirlo),
 * para que el orden de operaciones (registrarse antes o después de cargar los RAPs)
 * deje de importar. Es idempotente: una vez sanado, el paso 1 corta sin reescribir.
 */
const prisma = require("../db/client");

/**
 * Devuelve la competenciaId VIGENTE del usuario, resolviéndola por código si el FK
 * está null u obsoleto, y persistiendo la corrección.
 *
 * @param {string} userId
 * @returns {Promise<string|null>} competenciaId vigente, o null si no hay forma de
 *          resolverla (usuario sin código, o ninguna Competencia con ese código en DB).
 */
async function resolverCompetenciaId(userId) {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { competenciaId: true, competenciaCodigo: true },
  });
  if (!user) return null;

  // 1) Si el FK ya apunta a una Competencia EXISTENTE, es válido: úsalo tal cual.
  if (user.competenciaId) {
    const existe = await prisma.competencia.findUnique({
      where:  { id: user.competenciaId },
      select: { id: true },
    });
    if (existe) return user.competenciaId;
    // Si no existe → cuid obsoleto (competencias re-sembradas): cae al paso 2.
  }

  // 2) Resolver por el código estable y auto-sanar SOLO el FK.
  //    OJO: no copiamos Competencia.nombre a user.competenciaNombre porque el nombre
  //    de varias competencias está sucio en DB (el extractor a veces guardó el texto
  //    completo de la guía, ~4000 chars). Propagar eso ensuciaría la etiqueta del
  //    instructor. El nombre se arregla aparte (limpieza del extractor/Competencia).
  if (user.competenciaCodigo) {
    const comp = await prisma.competencia.findUnique({
      where:  { codigo: user.competenciaCodigo },
      select: { id: true },
    });
    if (comp) {
      // Best-effort: si la escritura falla, no rompemos la lectura del instructor.
      await prisma.user.update({ where: { id: userId }, data: { competenciaId: comp.id } }).catch(() => {});
      return comp.id;
    }
  }

  return null;
}

module.exports = { resolverCompetenciaId };
