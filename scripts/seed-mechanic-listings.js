// Seed a few `mechanic` booking-engine listings so the Automotive → Mechanic
// flow has real, bookable services (otherwise the FE falls back to demo cards).
//
// Usage:  OWNER_USER_ID=<a real user_id> node scripts/seed-mechanic-listings.js
// The owner is the workshop/provider; pass a real user_id via OWNER_USER_ID
// (defaults to 1). Safe to re-run — it skips listings that already exist by title.
//
// Field shape mirrors exactly what the Add/Edit Mechanic Service modal in
// strug-final-frontend (SellerAutomotiveDashboard.jsx) sends on create, so every
// field the detail modal renders (category, subcategory, service type, estimated
// time, what's included, highlights, requirements, availability, workshop
// address/city/zip) has real data instead of showing "—".
import prisma from '../utils/prisma-client.js';

const OWNER_USER_ID = Number(process.env.OWNER_USER_ID || 1);

// One shared workshop address for the on-site listings — matches the shape the FE
// builds from workshop_address/workshop_city/workshop_zip via splitProfileAddress.
const WORKSHOP = { address: '45 Danforth Ave', city: 'Toronto', zip: 'M4K 1N2' };

const LISTINGS = [
  {
    title: 'Brake Pad Replacement',
    price: 180,
    category: 'Repairs',
    subcategory: 'Brake Repair',
    service_type: 'workshop',
    estimated_time: '2 hours',
    whats_included: ['OEM brake pads', 'Brake fluid top-up', 'Multi-point safety check'],
    highlights: ['Quality Parts Used', 'Warranty Included'],
    requirements: 'Vehicle make, model, and year',
    availability: 'Mon–Sat, 9am–6pm',
  },
  {
    title: 'Oil Change (Synthetic)',
    price: 90,
    category: 'Maintenance & Service',
    subcategory: 'Oil Change',
    service_type: 'workshop',
    estimated_time: '30 minutes',
    whats_included: ['Full synthetic oil (5L)', 'Oil filter replacement', 'Fluid level check'],
    highlights: ['Quick Service', 'Expert Technicians'],
    requirements: 'Vehicle make, model, and mileage',
    availability: 'Mon–Fri, 8am–5pm',
  },
  {
    title: 'Engine Diagnostics',
    price: 75,
    category: 'Electrical & Diagnostics',
    subcategory: 'Computer Diagnostics',
    service_type: 'mobile',
    estimated_time: '1 hour',
    whats_included: ['OBD-II scan', 'Error code readout', 'Written diagnostic report'],
    highlights: ['Expert Technicians', '24/7 Support'],
    requirements: 'Access to the vehicle and ignition key',
    availability: 'By appointment, 7 days a week',
  },
  {
    title: 'Tire Rotation & Balance',
    price: 60,
    category: 'Tires & Wheels',
    subcategory: 'Tire Rotation',
    service_type: 'workshop',
    estimated_time: '1 hour',
    whats_included: ['4-wheel rotation', 'Wheel balancing', 'Tire pressure check'],
    highlights: ['Quick Service', 'Quality Parts Used'],
    requirements: 'None',
    availability: 'Mon–Sat, 9am–6pm',
  },
  {
    title: 'AC Recharge & Check',
    price: 130,
    category: 'AC & Heating',
    subcategory: 'AC Recharge',
    service_type: 'workshop',
    estimated_time: '1 hour',
    whats_included: ['R-134a refrigerant recharge', 'Leak inspection', 'Cabin filter check'],
    highlights: ['Warranty Included', 'Expert Technicians'],
    requirements: 'Vehicle make and model',
    availability: 'Mon–Sat, 9am–6pm',
  },
];

async function main() {
  const owner = await prisma.user.findUnique({ where: { user_id: OWNER_USER_ID }, select: { user_id: true } });
  if (!owner) {
    console.error(`OWNER_USER_ID ${OWNER_USER_ID} not found — pass a real user_id.`);
    process.exit(1);
  }
  let created = 0;
  for (const l of LISTINGS) {
    const exists = await prisma.booking_listing.findFirst({
      where: { vertical: 'mechanic', owner_id: OWNER_USER_ID, title: l.title },
      select: { booking_listing_id: true },
    });
    if (exists) { console.log(`skip (exists): ${l.title}`); continue; }

    const isWorkshop = l.service_type === 'workshop';
    const location = isWorkshop ? `${WORKSHOP.address}, ${WORKSHOP.city}, ${WORKSHOP.zip}` : null;

    const row = await prisma.booking_listing.create({
      data: {
        vertical: 'mechanic',
        owner_id: OWNER_USER_ID,
        title: l.title,
        description: `Certified ${l.title.toLowerCase()} — flat per-visit price, book a date and time.`,
        location,
        price: l.price,
        price_unit: 'visit',
        currency: 'USD',
        fulfillment: 'onsite',
        is_active: true,
        attributes: {
          category: l.category,
          subcategory: l.subcategory,
          service_type: l.service_type,
          estimated_time: l.estimated_time,
          whats_included: l.whats_included,
          highlights: l.highlights,
          tags: l.highlights,
          requirements: l.requirements,
          availability: l.availability,
          ...(isWorkshop ? {
            workshop_address: WORKSHOP.address,
            workshop_city: WORKSHOP.city,
            workshop_zip: WORKSHOP.zip,
          } : {}),
        },
        images: [],
      },
    });
    created++;
    console.log(`created mechanic listing #${row.booking_listing_id}: ${l.title}`);
  }
  console.log(`Done. ${created} created.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
