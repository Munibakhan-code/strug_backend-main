import prisma from '../utils/prisma-client.js';

const SERVICE_DATA = [
  {
    type: "Cleaning",
    categories: ["Apartment Cleaning", "Deep Cleaning", "Office Cleaning", "Carpet Cleaning", "Window Cleaning"],
  },
  {
    type: "Trades",
    categories: ["Plumbing", "Electrical", "HVAC", "Carpentry", "Painting"],
  },
  {
    type: "Outdoor",
    categories: ["Lawn Care", "Landscaping", "Snow Removal", "Pressure Washing", "Tree Trimming"],
  },
  {
    type: "Moving",
    categories: ["Local Move", "Furniture Assembly", "Junk Removal", "Packing & Unpacking"],
  },
  {
    type: "Beauty & Wellness",
    categories: ["Haircut", "Makeup", "Massage", "Nail Care", "Personal Training"],
  },
  {
    type: "Tutoring",
    categories: ["Math", "Science", "Languages", "Music", "Test Prep"],
  },
  {
    type: "Tech & IT",
    categories: ["Computer Repair", "Network Setup", "Phone Repair", "Smart Home", "Web Development"],
  },
  {
    type: "Events",
    categories: ["Photography", "Catering", "DJ & Music", "Decoration", "Event Planning"],
  },
  {
    type: "Pet Care",
    categories: ["Dog Walking", "Pet Sitting", "Grooming", "Veterinary Visit", "Training"],
  },
  {
    type: "Auto",
    categories: ["Oil Change", "Detailing", "Tire Change", "Jump Start", "Mobile Mechanic"],
  },
];

async function main() {
  console.log("Seeding service types and categories...");
  for (const { type, categories } of SERVICE_DATA) {
    const st = await prisma.service_type.upsert({
      where: { service_type_id: (await prisma.service_type.findFirst({ where: { service_type_name: type } }))?.service_type_id ?? -1 },
      update: {},
      create: { service_type_name: type },
    });
    console.log(`  Type: ${type} (id=${st.service_type_id})`);
    for (const cat of categories) {
      const existing = await prisma.service_category.findFirst({
        where: { service_category_name: cat, service_type_id: st.service_type_id },
      });
      if (!existing) {
        await prisma.service_category.create({
          data: { service_category_name: cat, service_type_id: st.service_type_id },
        });
        console.log(`    + ${cat}`);
      } else {
        console.log(`    ~ ${cat} (exists)`);
      }
    }
  }
  console.log("Done.");
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
