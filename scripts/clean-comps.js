const { PrismaClient } = require("@prisma/client")
const prisma = new PrismaClient()

async function main() {
  const compTrash = await prisma.competencia.findMany({
    where: {
      OR: [
        { nombre: { startsWith: '[' } },
        { nombre: { contains: 'Página' } },
        { codigo: { startsWith: '240201530' } }, // that was a fake competencia
        { codigo: { startsWith: '220501094' } }, 
        { codigo: { startsWith: '220501095' } }, 
        { codigo: { startsWith: '220501096' } }, 
        { codigo: { startsWith: '220501097' } }, 
        { codigo: { startsWith: '220501098' } }, 
        { codigo: { startsWith: '240201524' } }, 
        { codigo: { startsWith: '240201526' } }, 
        { codigo: { startsWith: '240201528' } }, 
        { codigo: { startsWith: '240201529' } }
      ]
    }
  });

  for (const c of compTrash) {
    // Delete any RAPs associated
    const raps = await prisma.rAP.findMany({ where: { competenciaId: c.id } });
    for(const r of raps) {
      await prisma.rapEvidenciaRel.deleteMany({ where: { rapId: r.id } });
      await prisma.matchingPropuesta.deleteMany({ where: { rapId: r.id } });
      await prisma.criterio.deleteMany({ where: { rapId: r.id } });
      await prisma.rAP.delete({ where: { id: r.id } });
    }
    // Set users pointing to this to null or English
    await prisma.user.updateMany({ 
      where: { competenciaId: c.id },
      data: { competenciaId: null } 
    });
    
    await prisma.competencia.delete({ where: { id: c.id } });
  }

  console.log(`Borradas ${compTrash.length} competencias basura.`);
}

main().catch(console.error).finally(() => prisma.$disconnect())
