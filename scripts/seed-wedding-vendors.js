// Seed initial Wedding vendor booking listings (global sample markets).
//
// The Wedding guest page is fully API-backed and contains no static vendor cards.
// These rows provide initial inventory across regions and remain editable through
// sd-wedding when logged in as their owner. Re-running updates matching rows
// instead of duplicating.
//
// Currency: listings are stored/charged in the platform base currency (CAD) —
// display conversion for each guest is handled client-side via useMoney/regionConfig.
// Override with SEED_CURRENCY=USD (etc.) only when intentionally seeding another charge currency.
//
// Optional owner override:
//   SEED_OWNER_USER_ID=68 node scripts/seed-wedding-vendors.js

import prisma from '../utils/prisma-client.js';

const SEED_CURRENCY = String(process.env.SEED_CURRENCY || 'CAD').trim().toUpperCase().slice(0, 3) || 'CAD';

// Do not seed fake rating/reviews — guests see stars only after real guest_rating events.
// Locations span major wedding markets worldwide (not Canada-only).
const VENDORS = [
  { title: 'The Grand Orangery', vendorType: 'Venue', maxAttendees: 200, price: 8500, location: 'London, United Kingdom', thumb: 'linear-gradient(135deg,#1e1b4b,#7c3aed,#c4b5fd)' },
  { title: 'Bella Floral Studio', vendorType: 'Florist', maxAttendees: null, price: 2200, location: 'Paris, France', thumb: 'linear-gradient(135deg,#052e16,#16a34a,#bbf7d0)' },
  { title: 'Luminary Films', vendorType: 'Videography', maxAttendees: null, price: 3500, location: 'Los Angeles, United States', thumb: 'linear-gradient(135deg,#0c1a2e,#2563eb)' },
  { title: 'Villa Soleil', vendorType: 'Venue', maxAttendees: 120, price: 6200, location: 'Tuscany, Italy', thumb: 'linear-gradient(135deg,#451a03,#f59e0b,#fde68a)' },
  { title: 'Chef Marco & Co.', vendorType: 'Catering', maxAttendees: 300, price: 4800, location: 'New York, United States', thumb: 'linear-gradient(135deg,#1c1917,#ef4444)' },
  { title: 'Grace & Lens', vendorType: 'Photography', maxAttendees: null, price: 2900, location: 'Sydney, Australia', thumb: 'linear-gradient(135deg,#0f172a,#06b6d4)' },
  { title: 'Luxe Tent & Drape Co.', vendorType: 'Rental', maxAttendees: null, price: 1800, location: 'Dubai, United Arab Emirates', thumb: 'linear-gradient(135deg,#1e293b,#334155,#94a3b8)' },
  { title: 'Golden Hour Rentals', vendorType: 'Rental', maxAttendees: null, price: 950, location: 'Singapore', thumb: 'linear-gradient(135deg,#451a03,#92400e,#fbbf24)' },
];

async function resolveOwner() {
  const explicit = Number(process.env.SEED_OWNER_USER_ID);
  if (Number.isInteger(explicit) && explicit > 0) {
    const user = await prisma.user.findUnique({
      where: { user_id: explicit },
      select: { user_id: true, name: true },
    });
    if (!user) throw new Error(`SEED_OWNER_USER_ID=${explicit} does not exist`);
    return user;
  }

  const namedSeller = await prisma.user.findFirst({
    where: { name: 'StyleHaus Shop', is_seller: true },
    select: { user_id: true, name: true },
  });
  if (namedSeller) return namedSeller;

  const preferred = await prisma.user.findFirst({
    where: {
      is_seller: true,
      NOT: [
        { name: { contains: 'test', mode: 'insensitive' } },
        { name: { contains: 'demo', mode: 'insensitive' } },
        { name: { contains: 'seed', mode: 'insensitive' } },
      ],
    },
    orderBy: { user_id: 'asc' },
    select: { user_id: true, name: true },
  });
  if (!preferred) {
    throw new Error('No real seller found; set SEED_OWNER_USER_ID to an existing user');
  }
  return preferred;
}

async function resyncSequence() {
  await prisma.$executeRawUnsafe(`
    SELECT setval(
      pg_get_serial_sequence('booking_listing', 'booking_listing_id'),
      COALESCE((SELECT MAX(booking_listing_id) FROM booking_listing), 0) + 1,
      false
    )
  `);
}

function listingData(ownerId, vendor) {
  const attributes = {
    vendor_type: vendor.vendorType,
    thumb: vendor.thumb,
    market: 'global',
  };
  if (vendor.maxAttendees != null) attributes.max_attendees = vendor.maxAttendees;

  return {
    vertical: 'wedding',
    owner_id: ownerId,
    title: vendor.title,
    description: `${vendor.vendorType} services for weddings worldwide`,
    location: vendor.location,
    price: vendor.price,
    price_unit: 'event',
    currency: SEED_CURRENCY,
    capacity: 1,
    fulfillment: 'onsite',
    requires_deposit: false,
    service_fee_pct: 10,
    is_active: true,
    attributes,
    images: [],
  };
}

async function main() {
  await resyncSequence();
  const owner = await resolveOwner();
  let created = 0;
  let updated = 0;

  console.log(`Wedding vendor owner: ${owner.name} (user_id=${owner.user_id})`);
  console.log(`Seed currency: ${SEED_CURRENCY} (platform charge baseline; guest display converts by region)`);

  for (const vendor of VENDORS) {
    const existing = await prisma.booking_listing.findFirst({
      where: { vertical: 'wedding', title: vendor.title },
      select: { booking_listing_id: true },
    });
    const data = listingData(owner.user_id, vendor);

    if (existing) {
      await prisma.booking_listing.update({
        where: { booking_listing_id: existing.booking_listing_id },
        data,
      });
      updated += 1;
    } else {
      await prisma.booking_listing.create({ data });
      created += 1;
    }
  }

  console.log(`Done. created=${created} updated=${updated}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
