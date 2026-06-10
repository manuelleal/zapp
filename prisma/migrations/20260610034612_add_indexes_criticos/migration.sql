-- CreateIndex
CREATE INDEX "ActaSeguimiento_fichaId_idx" ON "ActaSeguimiento"("fichaId");

-- CreateIndex
CREATE INDEX "Aprendiz_fichaId_idx" ON "Aprendiz"("fichaId");

-- CreateIndex
CREATE INDEX "Entrega_aprendizId_idx" ON "Entrega"("aprendizId");

-- CreateIndex
CREATE INDEX "Evidencia_fichaId_idx" ON "Evidencia"("fichaId");

-- CreateIndex
CREATE INDEX "Ficha_userId_idx" ON "Ficha"("userId");

-- CreateIndex
CREATE INDEX "HistorialEstado_entregaId_idx" ON "HistorialEstado"("entregaId");

-- CreateIndex
CREATE INDEX "Job_userId_idx" ON "Job"("userId");

-- CreateIndex
CREATE INDEX "MatchingPropuesta_rapId_estado_idx" ON "MatchingPropuesta"("rapId", "estado");

-- CreateIndex
CREATE INDEX "RapEvidenciaRel_rapId_idx" ON "RapEvidenciaRel"("rapId");

-- CreateIndex
CREATE INDEX "RapEvidenciaRel_evidenciaId_idx" ON "RapEvidenciaRel"("evidenciaId");
