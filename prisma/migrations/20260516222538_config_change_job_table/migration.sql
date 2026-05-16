-- CreateTable
CREATE TABLE "ConfigChangeJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fichaId" TEXT,
    "evidenciaIds" JSONB NOT NULL,
    "campo" TEXT NOT NULL,
    "valorDespues" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "errorMsg" TEXT,
    "progreso" INTEGER NOT NULL DEFAULT 0,
    "detalle" JSONB,
    "creadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigChangeJob_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ConfigChangeJob" ADD CONSTRAINT "ConfigChangeJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
