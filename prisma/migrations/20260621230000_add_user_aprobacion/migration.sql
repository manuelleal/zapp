-- Registro cerrado: las cuentas deben ser aprobadas por el superadmin para entrar.
-- AlterTable
ALTER TABLE "User" ADD COLUMN "aprobadoAt" TIMESTAMP(3);

-- Backfill: los usuarios que YA existían quedan aprobados (no bloquear a nadie).
-- Solo las cuentas creadas DESPUÉS de esta migración entran como pendientes.
UPDATE "User" SET "aprobadoAt" = CURRENT_TIMESTAMP WHERE "aprobadoAt" IS NULL;
