-- AlterTable
ALTER TABLE "AIFeedback" ADD COLUMN     "calificacionSugerida" TEXT,
ADD COLUMN     "rapId" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "competenciaId" TEXT;

-- CreateTable
CREATE TABLE "Competencia" (
    "id" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,

    CONSTRAINT "Competencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RAP" (
    "id" TEXT NOT NULL,
    "competenciaId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,

    CONSTRAINT "RAP_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Criterio" (
    "id" TEXT NOT NULL,
    "rapId" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Criterio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Competencia_codigo_key" ON "Competencia"("codigo");

-- CreateIndex
CREATE UNIQUE INDEX "RAP_competenciaId_codigo_key" ON "RAP"("competenciaId", "codigo");

-- CreateIndex
CREATE UNIQUE INDEX "Entrega_evidenciaId_aprendizId_key" ON "Entrega"("evidenciaId", "aprendizId");

-- CreateIndex
CREATE UNIQUE INDEX "Evidencia_fichaId_href_key" ON "Evidencia"("fichaId", "href");

-- AddForeignKey
ALTER TABLE "RAP" ADD CONSTRAINT "RAP_competenciaId_fkey" FOREIGN KEY ("competenciaId") REFERENCES "Competencia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Criterio" ADD CONSTRAINT "Criterio_rapId_fkey" FOREIGN KEY ("rapId") REFERENCES "RAP"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_competenciaId_fkey" FOREIGN KEY ("competenciaId") REFERENCES "Competencia"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIFeedback" ADD CONSTRAINT "AIFeedback_rapId_fkey" FOREIGN KEY ("rapId") REFERENCES "RAP"("id") ON DELETE SET NULL ON UPDATE CASCADE;
