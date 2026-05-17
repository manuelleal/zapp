-- CreateTable
CREATE TABLE "RapEvidenciaRel" (
    "id" TEXT NOT NULL,
    "rapId" TEXT NOT NULL,
    "evidenciaId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RapEvidenciaRel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchingPropuesta" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "evidenciaId" TEXT NOT NULL,
    "rapId" TEXT NOT NULL,
    "confianza" INTEGER NOT NULL,
    "razon" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'propuesto',
    "decidedAt" TIMESTAMP(3),
    "creadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchingPropuesta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActaSeguimiento" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fichaId" TEXT NOT NULL,
    "numero" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "hora" TEXT NOT NULL,
    "lugar" TEXT NOT NULL DEFAULT 'Videoconferencia / Plataforma Zajuna',
    "objetivo" TEXT NOT NULL,
    "conclusiones" TEXT,
    "compromisos" JSONB,
    "rapIds" JSONB NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'borrador',
    "creadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActaSeguimiento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActaParticipante" (
    "id" TEXT NOT NULL,
    "actaId" TEXT NOT NULL,
    "aprendizId" TEXT NOT NULL,
    "juicio" TEXT NOT NULL,

    CONSTRAINT "ActaParticipante_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MensajeFormativo" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actaId" TEXT,
    "fichaId" TEXT NOT NULL,
    "canal" TEXT NOT NULL,
    "asunto" TEXT NOT NULL,
    "cuerpo" TEXT NOT NULL,
    "destinatarios" JSONB NOT NULL,
    "enviadoAt" TIMESTAMP(3),
    "estado" TEXT NOT NULL DEFAULT 'pendiente',
    "errorMsg" TEXT,
    "creadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MensajeFormativo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RapEvidenciaRel_rapId_evidenciaId_key" ON "RapEvidenciaRel"("rapId", "evidenciaId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchingPropuesta_userId_evidenciaId_rapId_key" ON "MatchingPropuesta"("userId", "evidenciaId", "rapId");

-- CreateIndex
CREATE UNIQUE INDEX "ActaParticipante_actaId_aprendizId_key" ON "ActaParticipante"("actaId", "aprendizId");

-- AddForeignKey
ALTER TABLE "RapEvidenciaRel" ADD CONSTRAINT "RapEvidenciaRel_rapId_fkey" FOREIGN KEY ("rapId") REFERENCES "RAP"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RapEvidenciaRel" ADD CONSTRAINT "RapEvidenciaRel_evidenciaId_fkey" FOREIGN KEY ("evidenciaId") REFERENCES "Evidencia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchingPropuesta" ADD CONSTRAINT "MatchingPropuesta_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchingPropuesta" ADD CONSTRAINT "MatchingPropuesta_evidenciaId_fkey" FOREIGN KEY ("evidenciaId") REFERENCES "Evidencia"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchingPropuesta" ADD CONSTRAINT "MatchingPropuesta_rapId_fkey" FOREIGN KEY ("rapId") REFERENCES "RAP"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActaSeguimiento" ADD CONSTRAINT "ActaSeguimiento_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActaSeguimiento" ADD CONSTRAINT "ActaSeguimiento_fichaId_fkey" FOREIGN KEY ("fichaId") REFERENCES "Ficha"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActaParticipante" ADD CONSTRAINT "ActaParticipante_actaId_fkey" FOREIGN KEY ("actaId") REFERENCES "ActaSeguimiento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActaParticipante" ADD CONSTRAINT "ActaParticipante_aprendizId_fkey" FOREIGN KEY ("aprendizId") REFERENCES "Aprendiz"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MensajeFormativo" ADD CONSTRAINT "MensajeFormativo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MensajeFormativo" ADD CONSTRAINT "MensajeFormativo_actaId_fkey" FOREIGN KEY ("actaId") REFERENCES "ActaSeguimiento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MensajeFormativo" ADD CONSTRAINT "MensajeFormativo_fichaId_fkey" FOREIGN KEY ("fichaId") REFERENCES "Ficha"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
