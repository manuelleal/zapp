-- CreateTable
CREATE TABLE "EvidenciaConfig" (
    "id" TEXT NOT NULL,
    "evidenciaId" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EvidenciaConfig_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "EvidenciaConfig" ADD CONSTRAINT "EvidenciaConfig_evidenciaId_fkey" FOREIGN KEY ("evidenciaId") REFERENCES "Evidencia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
