-- AlterTable
ALTER TABLE "Evidencia" ADD COLUMN     "configCache" JSONB,
ADD COLUMN     "configCacheAt" TIMESTAMP(3);
