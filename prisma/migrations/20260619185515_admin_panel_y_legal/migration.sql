-- AlterTable
ALTER TABLE "User" ADD COLUMN     "aceptoTerminosAt" TIMESTAMP(3),
ADD COLUMN     "rol" TEXT NOT NULL DEFAULT 'instructor',
ADD COLUMN     "suspendedAt" TIMESTAMP(3);
