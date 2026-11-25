/**
 * Idempotent seed for on-demand Work categories (macros + leaves).
 * Run: node scripts/seed-work-categories.js
 */
import dotenv from 'dotenv';
dotenv.config();
import prisma from '../utils/prisma-client.js';

const WORK_CATEGORIES = [
  { name: 'Home & Property Maintenance', slug: 'home-property-maintenance', children: ['Handyman','Plumber','Electrician','Painter','Carpenter','HVAC Technician','Roofer','Window Cleaner','Locksmith','Appliance Repair Tech'] },
  { name: 'Cleaning',                   slug: 'cleaning',                  children: ['House Cleaner','Office Cleaner','Carpet Cleaner','Window Washer','Post-Construction Cleaner','Pressure Washer','Deep Cleaner','Laundry Assistant'] },
  { name: 'Landscaping & Outdoor',      slug: 'landscaping-outdoor',       children: ['Lawn Mower','Gardener','Snow Shoveler','Tree Trimmer','Garden Planter','Leaf Raker','Irrigation Tech','Deck Builder'] },
  { name: 'Security & Surveillance',    slug: 'security-surveillance',     children: ['Security Guard','Patrol Officer','Event Security','Bodyguard','CCTV Installer','Alarm Installer'] },
  { name: 'Moving & Logistics',         slug: 'moving-logistics',          children: ['Mover','Furniture Assembler','Packer','Delivery Assistant','Truck Driver','Storage Helper'] },
  { name: 'Childcare',                  slug: 'childcare',                 children: ['Babysitter','Nanny','Tutor','After-School Helper','Homework Helper','Summer Camp Aide'] },
  { name: 'Elder & Personal Care',      slug: 'elder-personal-care',       children: ['Companion','Personal Carer','Errand Runner','Medication Assistant','Mobility Assistant','Home Health Aide'] },
  { name: 'Pet Care',                   slug: 'pet-care',                  children: ['Dog Walker','Pet Sitter','Pet Groomer','Pet Trainer','Vet Escort','Pet Boarder'] },
  { name: 'Food & Hospitality',         slug: 'food-hospitality',          children: ['Waitstaff','Bartender','Chef','Line Cook','Dishwasher','Barista','Catering Assistant','Food Runner','Host/Hostess','Prep Cook'] },
  { name: 'Events & Entertainment',     slug: 'events-entertainment',      children: ['Event Setup','Event Cleanup','DJ','Photographer','Videographer','Live Musician','Comedian','Magician','Decorator','Ticket Staff','MC / Host','Coat Check','DJ Assistant','Photography Assistant'] },
  { name: 'Construction & Trades',      slug: 'construction-trades',       children: ['General Laborer','Concrete Worker','Welder','Mason','Tile Installer','Drywaller','Insulator','Scaffolder'] },
  { name: 'IT & Tech On-Site',          slug: 'it-tech-onsite',            children: ['Tech Support','Network Installer','Computer Repair','Smart Home Installer','Cable Manager','AV Setup'] },
  { name: 'Health & Wellness',          slug: 'health-wellness',           children: ['Personal Trainer','Yoga Instructor','Massage Therapist','Nutritionist','Sports Coach','Meditation Guide'] },
  { name: 'Beauty & Grooming',          slug: 'beauty-grooming',           children: ['Makeup Artist','Hair Braider','Lash Technician','Nail Tech','Eyebrow Artist','Skincare Specialist'] },
  { name: 'Retail & Merchandising',     slug: 'retail-merchandising',      children: ['Sales Associate','Cashier','Stock Associate','Visual Merchandiser','Inventory Counter','Brand Ambassador'] },
  { name: 'Warehousing & Labor',        slug: 'warehousing-labor',         children: ['Warehouse Associate','Forklift Operator','Order Picker','Packer','Loader','Inventory Clerk'] },
  { name: 'Automotive & Roadside',      slug: 'automotive-roadside',       children: ['Car Detailer','Oil Change Tech','Tire Change','Jump Start','Tow Assist','Car Washer','Battery Replacement','General'] },
  { name: 'Salon & Spa',                slug: 'salon-spa',                 children: ['Hair Stylist','Barber','Massage Therapist','Nail Technician','Esthetician','Receptionist'] },
  { name: 'Driving School',             slug: 'driving-school',            children: ['Driving Instructor','Road Test Prep','Defensive Driving','Refresher Lessons'] },
];

export async function seedWorkCategories(client = prisma) {
  for (const macro of WORK_CATEGORIES) {
    const parent = await client.work_category.upsert({
      where: { slug: macro.slug },
      update: { name: macro.name, is_active: true },
      create: { name: macro.name, slug: macro.slug, is_active: true, is_live: true },
    });
    for (const childName of macro.children) {
      const childSlug = `${macro.slug}--${childName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      await client.work_category.upsert({
        where: { slug: childSlug },
        update: { name: childName, parent_id: parent.work_category_id, is_active: true },
        create: {
          name: childName,
          slug: childSlug,
          parent_id: parent.work_category_id,
          is_active: true,
          is_live: true,
        },
      });
    }
  }
  const leafCount = WORK_CATEGORIES.reduce((a, c) => a + c.children.length, 0);
  console.log(`Seeded ${WORK_CATEGORIES.length} macro + ${leafCount} leaf work categories.`);
  return { macros: WORK_CATEGORIES.length, leaves: leafCount };
}

const isDirect = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirect || process.argv[1]?.includes('seed-work-categories')) {
  seedWorkCategories()
    .then((r) => {
      console.log('Done', r);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
