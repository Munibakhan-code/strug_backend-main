import prisma from '../utils/prisma-client.js';

async function main() {
  const hasDelegate = !!prisma.wedding_try_on;
  console.log('PRISMA_WEDDING_TRY_ON=', hasDelegate);

  const cols = await prisma.$queryRawUnsafe(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'booking_listing'
      AND column_name IN ('avg_rating', 'review_count')
    ORDER BY 1
  `);
  console.log('COLS=', JSON.stringify(cols));

  const tables = await prisma.$queryRawUnsafe(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('wedding_try_on', 'booking_review')
    ORDER BY 1
  `);
  console.log('TABLES=', JSON.stringify(tables));

  if (hasDelegate) {
    const n = await prisma.wedding_try_on.count();
    console.log('TRY_ON_COUNT=', n);
  } else {
    // Fallback raw count if client not regenerated yet
    try {
      const raw = await prisma.$queryRawUnsafe('SELECT COUNT(*)::int AS c FROM wedding_try_on');
      console.log('TRY_ON_COUNT_RAW=', raw?.[0]?.c ?? raw);
    } catch (e) {
      console.log('TRY_ON_RAW_ERR=', e.message);
    }
  }

  const listings = await prisma.booking_listing.count({
    where: { vertical: 'wedding', is_active: true },
  });
  console.log('WEDDING_LISTINGS=', listings);

  const sample = await prisma.booking_listing.findMany({
    where: { vertical: 'wedding', is_active: true },
    take: 2,
    select: {
      booking_listing_id: true,
      title: true,
      avg_rating: true,
      review_count: true,
      price: true,
    },
  });
  console.log('SAMPLE=', JSON.stringify(sample));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('ERR', e);
  try { await prisma.$disconnect(); } catch { /* ignore */ }
  process.exit(1);
});
