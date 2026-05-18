-- AlterTable
ALTER TABLE "ActaParticipante" ADD COLUMN     "hasUngraded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rapStatus" JSONB;

-- AlterTable
ALTER TABLE "ActaSeguimiento" ADD COLUMN     "archivadaAt" TIMESTAMP(3),
ADD COLUMN     "notas" TEXT;
