/**
 * One-time data backfill after marketplace_vertical_upgrades migration.
 * - Backfill property listing_status / city from legacy fields
 * - Seed a default hotel room type for hotel listings that have none
 * - Ensure food vendors accept reservations by default
 *
 * Usage: node scripts/migrate-marketplace-verticals.js
 */
import prisma from '../utils/prisma-client.js';

async function main() {
  console.log('Backfilling properties…');
  const props = await prisma.property.findMany({
    where: { OR: [{ listing_status: null }, { city: null }] },
  });
  for (const p of props) {
    const cityGuess = (p.address || '').split(',').map((s) => s.trim()).filter(Boolean).slice(-2, -1)[0] || null;
    await prisma.property.update({
      where: { property_id: p.property_id },
      data: {
        listing_status: p.listing_status || p.status || null,
        city: p.city || cityGuess,
        price_min: p.price_min ?? p.estimated_value ?? null,
        is_published: p.is_published ?? true,
      },
    });
  }
  console.log(`  updated ${props.length} properties`);

  console.log('Seeding hotel room types…');
  const hotels = await prisma.booking_listing.findMany({
    where: { vertical: 'hotel', is_active: true },
    include: { room_types: true },
  });
  let seeded = 0;
  for (const h of hotels) {
    if (h.room_types?.length) continue;
    await prisma.hotel_room_type.create({
      data: {
        booking_listing_id: h.booking_listing_id,
        name: h.attributes?.room_type || 'Standard Room',
        beds: h.attributes?.beds != null ? `${h.attributes.beds} bed` : '1 Queen Bed',
        max_guests: h.capacity || 2,
        quantity: h.capacity || 1,
        nightly_price: Number(h.price) || 100,
        amenities: Array.isArray(h.attributes?.amenities) ? h.attributes.amenities : [],
        images: h.images || [],
      },
    });
    seeded += 1;
  }
  console.log(`  seeded ${seeded} room types`);

  console.log('Enabling restaurant reservations…');
  const vendors = await prisma.food_vendor.updateMany({
    where: { accepts_reservations: false },
    data: { accepts_reservations: true },
  });
  console.log(`  enabled on ${vendors.count} vendors`);

  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
