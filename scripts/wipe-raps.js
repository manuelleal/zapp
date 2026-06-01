const { PrismaClient } = require("@prisma/client")
const prisma = new PrismaClient()

async function main() {
  await prisma.rapEvidenciaRel.deleteMany()
  await prisma.matchingPropuesta.deleteMany()
  await prisma.criterio.deleteMany()
  await prisma.rAP.deleteMany()
  console.log("Todos los RAPs han sido borrados de la base de datos.")
}

main().catch(console.error).finally(() => prisma.$disconnect())
