-- CreateTable
CREATE TABLE "ConfigAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "evidenciaId" TEXT NOT NULL,
    "actId" TEXT NOT NULL,
    "antes" JSONB NOT NULL,
    "despues" JSONB NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigAudit_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ConfigAudit" ADD CONSTRAINT "ConfigAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigAudit" ADD CONSTRAINT "ConfigAudit_evidenciaId_fkey" FOREIGN KEY ("evidenciaId") REFERENCES "Evidencia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
