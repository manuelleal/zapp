const { PrismaClient } = require("@prisma/client")
const prisma = new PrismaClient()

async function main() {
  // Vamos a borrar todos los RAPs que tengan " o" al final o que sean de la competencia TIC (220501046)
  // para que la interfaz quede limpia con los nuevos que extrajimos.
  
  const rapsAEliminar = await prisma.rAP.findMany({
    where: {
      OR: [
        { codigo: { startsWith: '22050' } },
        { codigo: { startsWith: '240201' } }, // matemáticas, ética
        { codigo: { startsWith: '22020' } }, // física
        { codigo: { startsWith: '21020' } },
        { descripcion: { endsWith: ' o' } }
      ]
    }
  });

  console.log(`Encontrados ${rapsAEliminar.length} RAPs viejos/sucios.`);

  for(const rap of rapsAEliminar) {
    // Para poder borrar el RAP, primero borramos las relaciones
    await prisma.rapEvidenciaRel.deleteMany({ where: { rapId: rap.id } });
    await prisma.matchingPropuesta.deleteMany({ where: { rapId: rap.id } });
    await prisma.rAP.delete({ where: { id: rap.id } });
  }

  console.log('RAPs viejos eliminados correctamente. Solo quedan los nuevos limpios.');
}

main().catch(console.error).finally(() => prisma.$disconnect())
