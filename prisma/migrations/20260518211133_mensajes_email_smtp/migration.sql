-- AlterTable
ALTER TABLE "Aprendiz" ADD COLUMN     "email" TEXT,
ADD COLUMN     "ultimoAcceso" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ConfigCorreo" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "smtpUser" TEXT NOT NULL,
    "smtpPassEnc" TEXT NOT NULL,
    "fromNombre" TEXT,
    "creadaAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actualizadaAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfigCorreo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConfigCorreo_userId_key" ON "ConfigCorreo"("userId");

-- AddForeignKey
ALTER TABLE "ConfigCorreo" ADD CONSTRAINT "ConfigCorreo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
