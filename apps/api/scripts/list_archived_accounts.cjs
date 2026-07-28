const { PrismaClient } = require('@prisma/client');
(async function(){
  try {
    const prisma = new PrismaClient();
    const rows = await prisma.tradingAccount.findMany({
      where: { archivedAt: { not: null } },
      orderBy: [{ archivedAt: 'desc' }],
      take: 50,
      select: { id:true, name:true, provider:true, accountType:true, status:true, connectionStatus:true, archivedAt:true, externalAccountId:true }
    });
    console.log(JSON.stringify(rows, null, 2));
    await prisma.$disconnect();
  } catch (e) {
    console.error('ERR', e);
    process.exit(1);
  }
})();
