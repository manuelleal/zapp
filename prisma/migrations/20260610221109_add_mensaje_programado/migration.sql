-- CreateTable
CREATE TABLE "MensajeProgramado" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fichaId" TEXT NOT NULL,
    "canal" TEXT NOT NULL,
    "asunto" TEXT NOT NULL,
    "cuerpo" TEXT NOT NULL,
    "templateTipo" TEXT,
    "filtroDestinatarios" TEXT NOT NULL,
    "alcanceEvidencias" TEXT NOT NULL DEFAULT 'competencia',
    "evidenciaIds" JSONB,
    "incluirDesaprobadas" BOOLEAN NOT NULL DEFAULT false,
    "intervaloDias" INTEGER NOT NULL,
    "hora" TEXT NOT NULL,
    "proximaEjecucion" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "pausadoAt" TIMESTAMP(3),
    "creadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MensajeProgramado_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MensajeProgramado_proximaEjecucion_idx" ON "MensajeProgramado"("proximaEjecucion");

-- CreateIndex
CREATE INDEX "MensajeProgramado_userId_idx" ON "MensajeProgramado"("userId");

-- AddForeignKey
ALTER TABLE "MensajeProgramado" ADD CONSTRAINT "MensajeProgramado_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MensajeProgramado" ADD CONSTRAINT "MensajeProgramado_fichaId_fkey" FOREIGN KEY ("fichaId") REFERENCES "Ficha"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
