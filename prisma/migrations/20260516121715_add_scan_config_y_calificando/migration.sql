-- AlterTable
ALTER TABLE "Evidencia" ADD COLUMN     "activaParaScan" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "calificandoAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastAutoScanAt" TIMESTAMP(3);
