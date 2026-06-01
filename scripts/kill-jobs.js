const { PrismaClient } = require("@prisma/client")
const prisma = new PrismaClient()

async function main() {
  const result = await prisma.job.updateMany({
    where: {
      status: {
        in: ['queued', 'running']
      }
    },
    data: {
      status: 'error',
      errorMsg: 'Cancelado por reinicio de sistema'
    }
  })
  
  console.log(`\n¡Listo! Se cancelaron ${result.count} jobs colgados.`)
}

main().catch(console.error).finally(() => prisma.$disconnect())
