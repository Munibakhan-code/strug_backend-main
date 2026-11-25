/**
 * Seed the minimum data to exercise the Shared Event (v1) flow end to end:
 *   - one bookable venue  (booking_listing, vertical='venue')
 *   - one Catering food_vendor + menu items
 *   - one Floral   food_vendor + menu items
 *
 * Idempotent — safe to re-run. Owner defaults to the lowest user_id;
 * override with SEED_OWNER_USER_ID.
 *
 *   node scripts/seed-shared-event.js
 */
import prisma from '../utils/prisma-client.js';

// Toronto core, so the vendors fall inside the delivery radius for a TO test pin.
const CITY = 'Toronto';
const GEO = { lat: 43.6532, lng: -79.3832 };

async function owner() {
  if (process.env.SEED_OWNER_USER_ID) return Number(process.env.SEED_OWNER_USER_ID);
  const u = await prisma.user.findFirst({ orderBy: { user_id: 'asc' }, select: { user_id: true } });
  if (!u) throw new Error('No users in DB — create one or set SEED_OWNER_USER_ID.');
  return u.user_id;
}

async function vendorTypeId(name) {
  const existing = await prisma.vendor_type.findFirst({ where: { vendor_type: name } });
  if (existing) return existing.vendor_type_id;
  const created = await prisma.vendor_type.create({ data: { vendor_type: name } });
  return created.vendor_type_id;
}

async function ensureVenue(owner_id) {
  const title = 'The Loft on King (Shared Event demo)';
  const found = await prisma.booking_listing.findFirst({ where: { vertical: 'venue', title } });
  if (found) return { id: found.booking_listing_id, created: false };
  const row = await prisma.booking_listing.create({
    data: {
      vertical: 'venue',
      owner_id,
      title,
      description: 'Sunlit 3,000 sq ft loft with a rooftop terrace — demo venue for the shared event flow.',
      location: `120 King St W, ${CITY}`,
      latitude: GEO.lat,
      longitude: GEO.lng,
      price: 900,
      price_unit: 'event',
      currency: 'CAD',
      instant_book: false,
      capacity: 1, // single bookable unit; people count lives in attributes
      service_fee_pct: 10,
      is_active: true,
      attributes: { category: 'Rooftop', venue_type: 'Rooftop', max_attendees: 120, square_feet: 3000 },
      images: [],
    },
  });
  return { id: row.booking_listing_id, created: true };
}

async function ensureFoodVendor(owner_id, { name, typeName, typeId, items }) {
  let vendor = await prisma.food_vendor.findFirst({ where: { vendor_name: name } });
  let created = false;
  if (!vendor) {
    vendor = await prisma.food_vendor.create({
      data: {
        owner_id,
        vendor_name: name,
        vendor_type_id: typeId,
        cuisine_type: typeName,
        location: `200 Spadina Ave, ${CITY}`,
        lat: GEO.lat,
        long: GEO.lng,
        is_open: true,
        is_active: true,
        is_paused: false,
        min_order_value: 0,
      },
    });
    created = true;
  }
  const existingItems = await prisma.food_item.count({ where: { vendor_id: vendor.vendor_id } });
  if (existingItems === 0) {
    for (const it of items) {
      await prisma.food_item.create({
        data: {
          vendor_id: vendor.vendor_id,
          name: it.name,
          description: it.description,
          price: it.price,
          is_available: true,
          vendor_type_id: typeId,
        },
      });
    }
  }
  return { id: vendor.vendor_id, created, items: existingItems || items.length };
}

async function main() {
  const owner_id = await owner();
  console.log(`Seeding shared-event demo data (owner_id=${owner_id})\n`);

  const venue = await ensureVenue(owner_id);
  console.log(`venue   booking_listing_id=${venue.id} ${venue.created ? '(created)' : '(exists)'}`);

  const cateringTypeId = await vendorTypeId('Catering');
  const catering = await ensureFoodVendor(owner_id, {
    name: 'Maple & Thyme Catering (demo)',
    typeName: 'Catering',
    typeId: cateringTypeId,
    items: [
      { name: 'Grazing Table (per 10 guests)', description: 'Seasonal cheese, charcuterie, crudité, breads.', price: 180 },
      { name: 'Plated Dinner (per guest)', description: 'Three courses, choice of protein.', price: 62 },
      { name: 'Cocktail Canapés (per dozen)', description: "Chef's selection of six styles.", price: 42 },
    ],
  });
  console.log(`catering vendor_id=${catering.id} ${catering.created ? '(created)' : '(exists)'} items=${catering.items}`);

  const floralTypeId = await vendorTypeId('Floral');
  const floral = await ensureFoodVendor(owner_id, {
    name: 'Fern & Fig Floral (demo)',
    typeName: 'Floral',
    typeId: floralTypeId,
    items: [
      { name: 'Head Table Runner (6 ft)', description: 'Lush garden runner, seasonal blooms.', price: 320 },
      { name: 'Guest Table Centrepiece', description: 'Low compote arrangement.', price: 85 },
      { name: 'Welcome Arch Install', description: 'Freestanding floral arch, setup + teardown.', price: 640 },
    ],
  });
  console.log(`floral   vendor_id=${floral.id} ${floral.created ? '(created)' : '(exists)'} items=${floral.items}`);

  console.log('\nDone. Open /event-plan, then add the venue + a catering package + a bouquet.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
