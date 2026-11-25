import { PrismaClient, Prisma } from '@prisma/client';
import { faker } from '@faker-js/faker';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { seedLiveCategories } from '../scripts/seed-live-categories.js';
import { seedRideshareTestAccounts } from './seed-rideshare-test-accounts.js';

dotenv.config();

const prisma = new PrismaClient();

const algorithm = 'aes-256-cbc';
const secretKey = Buffer.from(process.env.ENCRYPTION_KEY || '0'.repeat(64), 'hex');
const iv = Buffer.alloc(16, 0);

function encrypt(text) {
  if (!text) return text;
  const cipher = crypto.createCipheriv(algorithm, secretKey, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return encrypted;
}

async function main() {
  console.log('--- Starting Database Seed ---');

  const env = process.env.NODE_ENV ?? 'production';

  // Live browse categories (idempotent) — seed FIRST so they populate in every environment
  // even if a later taxonomy upsert throws (the deploy seed step is non-blocking and has a
  // pre-existing failure downstream, which would otherwise skip these).
  try {
    await seedLiveCategories(prisma);
  } catch (e) {
    console.error('[seed] live categories failed:', e?.message);
  }

  const passwordHash = await bcrypt.hash('password123', 10);
  const dec = (v) => new Prisma.Decimal(String(v));

  // --------- seeding freelance categories & subcategories ---------
  

  console.log('Seeding freelance categories & subcategories...');
  
  const freelanceCategories = [
    {
      name: 'Design & Creative',
      slug: 'design-creative',
      subCategories: [
        'Graphic Design',
        'UI/UX Design',
        'Logo Design',
        'Branding',
        'Illustration',
        'Web Design',
        'Motion Graphics',
        '3D Modeling',
        'Video Editing',
        'Animation'
      ]
    },
    {
      name: 'Development & IT',
      slug: 'development-it',
      subCategories: [
        'Web Development',
        'Mobile App Development',
        'Software Development',
        'WordPress',
        'Shopify',
        'React',
        'Node.js',
        'Python',
        'Java',
        'PHP',
        'Database Design',
        'DevOps',
        'Cybersecurity',
        'Cloud Services',
        'API Integration'
      ]
    },
    {
      name: 'Writing & Translation',
      slug: 'writing-translation',
      subCategories: [
        'Content Writing',
        'Copywriting',
        'Blog Writing',
        'Technical Writing',
        'Creative Writing',
        'Proofreading',
        'Editing',
        'Translation',
        'Transcription'
      ]
    },
    {
      name: 'Marketing & Sales',
      slug: 'marketing-sales',
      subCategories: [
        'Social Media Marketing',
        'SEO',
        'Email Marketing',
        'Content Marketing',
        'Digital Advertising',
        'Lead Generation',
        'Sales Funnel',
        'Market Research',
        'Brand Strategy',
        'Influencer Marketing'
      ]
    },
    {
      name: 'Video & Audio',
      slug: 'video-audio',
      subCategories: [
        'Video Production',
        'Video Editing',
        'Audio Editing',
        'Voice Over',
        'Music Production',
        'Sound Design',
        'Podcast Production',
        'Live Streaming'
      ]
    },
    {
      name: 'Business & Finance',
      slug: 'business-finance',
      subCategories: [
        'Business Consulting',
        'Financial Planning',
        'Accounting',
        'Tax Preparation',
        'Bookkeeping',
        'Legal Consulting',
        'Virtual Assistance',
        'Project Management',
        'HR Consulting'
      ]
    },
    {
      name: 'Data & Analytics',
      slug: 'data-analytics',
      subCategories: [
        'Data Entry',
        'Data Visualization',
        'Data Science',
        'Machine Learning',
        'AI Development',
        'Business Intelligence',
        'Excel Expert',
        'SQL Development'
      ]
    },
    {
      name: 'Engineering & Architecture',
      slug: 'engineering-architecture',
      subCategories: [
        'Architectural Design',
        'Interior Design',
        'Civil Engineering',
        'Mechanical Engineering',
        'Electrical Engineering',
        'CAD Design',
        'Structural Engineering'
      ]
    },
    {
      name: 'Health & Wellness',
      slug: 'health-wellness',
      subCategories: [
        'Fitness Training',
        'Nutrition Consulting',
        'Meditation Coaching',
        'Mental Health',
        'Yoga Instruction',
        'Holistic Health',
        'Diet Planning'
      ]
    },
    {
      name: 'Education & Training',
      slug: 'education-training',
      subCategories: [
        'Tutoring',
        'Course Creation',
        'Language Teaching',
        'Test Preparation',
        'Professional Training',
        'Online Education',
        'Curriculum Design'
      ]
    }
  ];

  // Create categories and subcategories.
  // Guard: the freelance_Category / freelance_SubCategory models were removed from
  // schema.prisma (baseline squash) but this seed data was left behind, so
  // `prisma.freelance_Category` is undefined and this loop crashed the entire seed
  // before admins / taxonomy / the test account (all seeded later) were ever created.
  // On a DB that already had data this went unnoticed; a fresh-DB reseed hit it hard.
  // Skip gracefully when the delegate is absent; still runs if the model is restored.
  if (!prisma.freelance_Category || !prisma.freelance_SubCategory) {
    console.log('⏭  Skipping freelance categories — model not present in schema.');
  } else {
  for (const catData of freelanceCategories) {
    // Create the category
    const category = await prisma.freelance_Category.upsert({
      where: { slug: catData.slug },
      update: {
        name: catData.name,
        icon: catData.icon
      },
      create: {
        name: catData.name,
        slug: catData.slug,
        icon: catData.icon
      }
    });

    // Create subcategories
    for (const subCatName of catData.subCategories) {
      const slug = subCatName.toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      await prisma.freelance_SubCategory.upsert({
        where: { slug: slug },
        update: {
          name: subCatName,
          category_id: category.id
        },
        create: {
          name: subCatName,
          slug: slug,
          category_id: category.id
        }
      });
    }
  }
  } // end freelance-model guard

  console.log('✅ Freelance categories & subcategories seeded');

  
  // --- Base types & taxonomies ---
  console.log('Seeding base types & taxonomies...');

  const platformTypes = ['Social', 'E-Commerce', 'Rideshare', 'Food Delivery', 'Services', 'Streaming', 'Real Estate', 'Jobs', 'Education'];
  await Promise.all(
    platformTypes.map((type, i) =>
      prisma.platform_type.upsert({
        where: { platform_type_id: i + 1 },
        update: {},
        create: { platform_type: type },
      }),
    ),
  );

  const bookingTypes = ['Scheduled', 'On-Demand', 'Carpool'];
  await Promise.all(
    bookingTypes.map((type, i) =>
      prisma.booking_type.upsert({
        where: { booking_type_id: i + 1 },
        update: {},
        create: { booking_type: type },
      }),
    ),
  );

  const vehicleTypes = [
    { name: 'Economy', rate: 1.5 },
    { name: 'Premium', rate: 3.0 },
    { name: 'Bike', rate: 0.8 },
    { name: 'Van', rate: 2.5 },
  ];
  await Promise.all(
    vehicleTypes.map((v, i) =>
      prisma.vehicle_types.upsert({
        where: { vehicle_type_id: i + 1 },
        update: {},
        create: { name: v.name, base_rate_per_km: v.rate, booking_type_id: 1 },
      }),
    ),
  );

  const eventTypes = ['Music', 'Technology', 'Sports', 'Art', 'Networking'];
  await Promise.all(
    eventTypes.map((type, i) =>
      prisma.event_type.upsert({
        where: { event_type_id: i + 1 },
        update: {},
        create: { event_type_name: type },
      }),
    ),
  );

  // Get-or-create vendor types by NAME. The old upsert keyed on vendor_type_id: i+1
  // but created without an explicit id, so autoincrement could drift Restaurant off
  // id 1 on a fresh DB — the root cause of the "restaurant hidden from /food" bug.
  // Must list every name the vertical browse resolves — utils/vendor-type.js falls back to
  // the literal name, and routes/food-routes.js applies NO type filter when the lookup finds
  // nothing, so a missing row makes /food/vendors?type=Floral return the whole catalogue
  // (the Floral page rendering steakhouses). scripts/seed-all.js is not wired to `prisma db
  // seed` and never runs, so the list has to live here.
  const vendorTypes = ['Restaurant', 'Grocery', 'Pharmacy', 'Liquor', 'Floral', 'Catering', 'Meal Kit'];
  for (const type of vendorTypes) {
    const existingType = await prisma.vendor_type.findFirst({
      where: { vendor_type: { equals: type, mode: 'insensitive' } },
    });
    if (!existingType) {
      await prisma.vendor_type.create({ data: { vendor_type: type } });
    }
  }

  const productTypes = ['Electronics', 'Clothing', 'Home', 'Books', 'Beauty'];
  await Promise.all(
    productTypes.map((type, i) =>
      prisma.product_type.upsert({
        where: { product_type_id: i + 1 },
        update: {},
        create: { product_type_name: type },
      }),
    ),
  );
  const createdProductTypes = await prisma.product_type.findMany({ select: { product_type_id: true } });
  const productTypeIds = createdProductTypes.map(pt => pt.product_type_id);

  const rentalType = await prisma.rental_type.create({
    data: { rental_type_name: 'Short-term' },
  });
  const rentalCategory = await prisma.rental_categories.create({
    data: { rental_category_name: 'Tools', rental_type_id: rentalType.rental_type_id },
  });

  const appointmentServiceCategory = await prisma.appointment_service_category.create({
    data: { service_category_name: 'Wellness' },
  });
  const calmCategory = await prisma.calm_category.create({
    data: { calm_category_name: 'Meditation' },
  });
  const talentCategory = await prisma.talent_category.create({
    data: { talent_category_name: 'Design' },
  });
  const clothCategory = await prisma.cloth_category.create({
    data: { cloth_category_name: 'Tops' },
  });
  const clothType = await prisma.cloth_type.create({
    data: { cloth_type_name: 'Cotton' },
  });
  const checkoutCategory = await prisma.categories.create({
    data: { category_name: 'General' },
  });
  await prisma.kickstarter_category.create({ data: { category_name: 'Hardware' } });
  const meetupCategory = await prisma.meetup_category.create({
    data: { meetup_category_name: 'Outdoors' },
  });
  // Job categories — idempotent (this block runs on every prod deploy; job_category_name has no
  // unique constraint, so find-or-create by name rather than blindly .create-ing duplicates).
  //
  // One-time self-heal: older seeds ran `job_categories.create('Engineering')` unconditionally on
  // every deploy, so staging/prod accumulated dozens of duplicate rows. Collapse any duplicates by
  // name (keep the lowest id, repoint jobs to it, delete the rest) so the category filter is clean.
  const existingCats = await prisma.job_categories.findMany({ orderBy: { job_category_id: 'asc' } });
  const keepByName = new Map();
  for (const c of existingCats) {
    if (keepByName.has(c.job_category_name)) {
      const keepId = keepByName.get(c.job_category_name);
      await prisma.jobs.updateMany({ where: { job_category_id: c.job_category_id }, data: { job_category_id: keepId } });
      await prisma.job_categories.delete({ where: { job_category_id: c.job_category_id } });
    } else {
      keepByName.set(c.job_category_name, c.job_category_id);
    }
  }

  const JOB_CATEGORY_NAMES = [
    'Engineering', 'Design', 'Product', 'Sales & Marketing',
    'Operations', 'Customer Support', 'Finance', 'Data & Analytics',
  ];
  let jobCategory = null;
  for (const name of JOB_CATEGORY_NAMES) {
    const existing = await prisma.job_categories.findFirst({ where: { job_category_name: name } });
    const row = existing ?? await prisma.job_categories.create({
      data: { job_category_name: name, job_category_image_url: null },
    });
    if (!jobCategory) jobCategory = row;
  }
  const language = await prisma.language.create({
    data: { language_name: 'English' },
  });
  const symptomType = await prisma.symptom_types.create({
    data: { symptom_name: 'Cramping' },
  });
  await prisma.stream_category.create({
    data: { stream_category_name: 'Gaming' },
  });
  const { LIVE_CATEGORY_CATALOG, twitchBoxArt } = await import('../data/live-category-catalog.js');
  await Promise.all(
    LIVE_CATEGORY_CATALOG.map((entry) =>
      prisma.live_stream_category.upsert({
        where: { category_name: entry.name },
        update: { icon_url: entry.icon_url ?? twitchBoxArt(entry.name), is_active: true },
        create: {
          category_name: entry.name,
          icon_url: entry.icon_url ?? twitchBoxArt(entry.name),
          is_active: true,
        },
      })
    )
  );
  const flashCardCategory = await prisma.flash_card_category.create({
    data: {
      flash_card_category_name: 'General Knowledge',
      flash_card_category_description: 'Mixed trivia',
      flash_card_category_image: faker.image.url(),
    },
  });
  const dgCategory = await prisma.dg_categories.create({
    data: { dg_category_name: 'Templates' },
  });
  const csType = await prisma.cs_type.create({
    data: { cs_type_name: 'Premium CS', subscription_price: 9.99 },
  });
  const csCategory = await prisma.cs_categories.create({
    data: { cs_category_name: 'Tutorials', cs_type_id: csType.cs_type_id },
  });
  const serviceType = await prisma.service_type.create({ data: { service_type_name: 'Home repair' } });
  const serviceCategory = await prisma.service_category.create({
    data: { service_category_name: 'Plumbing', service_type_id: serviceType.service_type_id },
  });
  const serviceOffering = await prisma.services.create({
    data: {
      service_name: 'Leak fix',
      amount: dec('49.99'),
      duration: 60,
      description: 'Fix minor leaks',
      service_category_id: serviceCategory.service_category_id,
      service_type_id: serviceType.service_type_id,
    },
  });

  // --- Admins & email verification / social tags ---
  console.log('Seeding admins & misc...');
  for (let i = 0; i < 3; i++) {
    const email = `admin${i + 1}@strug.ca`;
    await prisma.admin.upsert({
      where: { email },
      update: {},
      create: {
        name: `Admin User ${i + 1}`,
        email,
        password: passwordHash,
      },
    });
  }

  // Test account with a known password — development + staging only.
  // Never upsert a shared password into production (credential leak surface).
  const allowTestAccount = env === 'development' || env === 'staging' || process.env.SEED_TEST_ACCOUNT === '1';
  if (allowTestAccount) {
    const testPassword = await bcrypt.hash('Strug2026!', 10);
    await prisma.user.upsert({
      where: { email: encrypt('test@strug.ca') },
      update: { is_seller: true, is_creator: true, password: testPassword, has_seen_welcome: true },
      create: {
        name: 'Test User',
        email: encrypt('test@strug.ca'),
        password: testPassword,
        // Seeded accounts are not "new users" — without this they default to false and get the
        // one-time Welcome hub / "take a tour" prompt on every device (#416).
        has_seen_welcome: true,
        ref_code: 'TEST-STRUG',
        is_seller: true,
        is_creator: true,
      },
    });

    // Deterministic social identity for the test account. The `user` table has no avatar field —
    // the sidebar/profile photo comes from social_profile.profile_pic_url.
    const testAccount = await prisma.user.findUniqueOrThrow({ where: { email: encrypt('test@strug.ca') } });
    await prisma.social_profile.upsert({
      where: { user_id: testAccount.user_id },
      update: { display_name: 'Test User', profile_pic_url: null },
      create: {
        user_id: testAccount.user_id,
        handle: 'strug_test',
        display_name: 'Test User',
        profile_pic_url: null,
        accepted_terms: true,
      },
    });
  } else {
    console.log('Skipping test@strug.ca seed (production — set SEED_TEST_ACCOUNT=1 only if intentional).');
  }

  // ── On-Demand Work Categories (macros + leaves) — idempotent upsert ──
  console.log('Seeding on-demand work categories...');
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
  for (const macro of WORK_CATEGORIES) {
    const parent = await prisma.work_category.upsert({
      where: { slug: macro.slug },
      update: { name: macro.name, is_active: true },
      create: { name: macro.name, slug: macro.slug, is_active: true, is_live: true },
    });
    for (const childName of macro.children) {
      const childSlug = `${macro.slug}--${childName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      await prisma.work_category.upsert({
        where: { slug: childSlug },
        update: { name: childName, parent_id: parent.work_category_id },
        create: { name: childName, slug: childSlug, parent_id: parent.work_category_id, is_active: true, is_live: true },
      });
    }
  }
  console.log(`Seeded ${WORK_CATEGORIES.length} macro + ${WORK_CATEGORIES.reduce((a, c) => a + c.children.length, 0)} leaf work categories.`);

  // Stop here for staging/production — no faker users, no fake listings.
  if (env !== 'development') {
    console.log('--- Seed complete (non-dev: taxonomy + admins + test account only) ---');
    return;
  }

  const rideshareAccounts = await seedRideshareTestAccounts(prisma, {
    encryptionKey: process.env.ENCRYPTION_KEY,
  });
  console.log(`Seeded rideshare rider #${rideshareAccounts.rider.user_id} and driver #${rideshareAccounts.driver.user_id}.`);

  await prisma.email_verification.create({
    data: { email: 'verify@example.com', code: '123456' },
  });

  const socialTag = await prisma.social_tag.create({
    data: { name: 'seedtag', post_count: 1 },
  });

  // --- Users ---
  console.log('Seeding users...');
  const users = [];

  const testUser = await prisma.user.findUniqueOrThrow({ where: { email: encrypt('test@strug.ca') } });
  users.push(testUser);

  const USER_COUNT = 22;
  for (let i = 0; i < USER_COUNT; i++) {
    const rawEmail = faker.internet.email();
    const email = encrypt(rawEmail);
    const user = await prisma.user.create({
      data: {
        name: faker.person.fullName(),
        email,
        password: passwordHash,
        has_seen_welcome: true, // seeded accounts are not new users — see #416
        currency: 'CAD',
        country: 'Sri Lanka',
        city: faker.location.city(),
        ref_code: `STRUG-${faker.string.alphanumeric(8).toUpperCase()}`,
        is_seller: i < 5,
      },
    });
    users.push(user);
  }

  const sharedRef = await prisma.shared_ref_code.create({
    data: {
      shared_to: users[1].user_id,
      ref_code: users[0].ref_code,
    },
  });

  const checkout = await prisma.checkouts.create({
    data: {
      total: dec('199.50'),
      date: new Date(),
      category_id: checkoutCategory.category_id,
      share_id: sharedRef.share_id,
    },
  });

  // --- Social profiles & feed ---
  console.log('Seeding social profiles & feed...');
  const socialProfiles = [];
  for (let i = 0; i < 15; i++) {
    const user = users[i];
    // users[0] is the test account, whose social_profile is already upserted above with a clean,
    // deterministic identity — upsert (not create) so it isn't clobbered with a faker avatar here
    // and so the unique user_id doesn't collide. Faker users (i>0) still get a random avatar.
    const profile = await prisma.social_profile.upsert({
      where: { user_id: user.user_id },
      update: {},
      create: {
        user_id: user.user_id,
        handle: `${faker.internet.username({ firstName: user.name.split(' ')[0] }).substring(0, 12)}${i}`,
        display_name: user.name || `User ${i}`,
        bio: faker.lorem.sentence(),
        profile_pic_url: faker.image.avatar(),
        accepted_terms: true,
      },
    });
    socialProfiles.push(profile);
    for (let j = 0; j < 2; j++) {
      await prisma.social_feed.create({
        data: {
          profile_id: profile.profile_id,
          caption_text: faker.lorem.paragraph(),
          location_name: faker.location.city(),
          status: 'published',
          platform_type_id: 1,
          ...(j === 0 ? { tags: { connect: [{ tag_id: socialTag.tag_id }] } } : {}),
        },
      });
    }
  }

  const post = await prisma.social_feed.findFirst();
  const profA = socialProfiles[0];
  const profB = socialProfiles[1];
  const profC = socialProfiles[2];

  await prisma.follower.create({
    data: { follower_id: profA.profile_id, following_id: profB.profile_id },
  });
  await prisma.social_highlight.create({
    data: {
      profile_id: profA.profile_id,
      title: 'Trips',
      cover_url: faker.image.url(),
    },
  });
  const highlight = await prisma.social_highlight.findFirst();
  const story = await prisma.social_story.create({
    data: {
      profile_id: profA.profile_id,
      media_url: faker.image.url(),
      media_type: 'image',
      expires_at: new Date(Date.now() + 86400000),
      highlight_id: highlight.highlight_id,
    },
  });
  await prisma.story_view.create({
    data: { story_id: story.story_id, profile_id: profB.profile_id },
  });
  await prisma.social_bookmark.create({
    data: { profile_id: profB.profile_id, social_post_id: post.social_post_id },
  });
  await prisma.social_search_history.create({
    data: { profile_id: profA.profile_id, query: 'travel tips' },
  });
  await prisma.social_seen_post.create({
    data: { profile_id: profB.profile_id, post_id: post.social_post_id },
  });
  await prisma.social_block.create({
    data: { blocker_id: profC.profile_id, blocked_id: profB.profile_id },
  });
  await prisma.social_mute.create({
    data: { muter_id: profA.profile_id, muted_id: profC.profile_id },
  });
  await prisma.close_friend.create({
    data: { profile_id: profA.profile_id, friend_id: profC.profile_id },
  });
  await prisma.social_report.create({
    data: {
      reporter_id: profA.profile_id,
      target_type: 'POST',
      target_id: post.social_post_id,
      reason: 'Spam seed report',
    },
  });
  await prisma.content_appeal.create({
    data: {
      profile_id: profB.profile_id,
      target_type: 'POST',
      target_id: post.social_post_id,
      reason: 'Mistake',
    },
  });
  await prisma.social_notification.create({
    data: {
      receiver_id: profB.profile_id,
      sender_id: profA.profile_id,
      type: 'LIKE',
      target_id: post.social_post_id,
    },
  });
  await prisma.social_post_view.create({
    data: { post_id: post.social_post_id, profile_id: profB.profile_id },
  });
  await prisma.social_audit_log.create({
    data: {
      admin_id: 1,
      profile_id: profA.profile_id,
      action: 'SEED',
      description: 'Audit seed row',
      ip_address: '127.0.0.1',
    },
  });

  const parentComment = await prisma.social_comments.create({
    data: {
      social_post_id: post.social_post_id,
      profile_id: profA.profile_id,
      text: 'Nice post!',
      timestamp: new Date(),
      platform_type_id: 1,
    },
  });
  await prisma.social_comments.create({
    data: {
      social_post_id: post.social_post_id,
      profile_id: profB.profile_id,
      parent_comment_id: parentComment.comment_id,
      text: 'Thanks!',
      timestamp: new Date(),
      platform_type_id: 1,
    },
  });
  await prisma.social_interactions.create({
    data: {
      social_post_id: post.social_post_id,
      profile_id: profB.profile_id,
      reaction_type: 'like',
      platform_type_id: 1,
    },
  });
  await prisma.social_media_attachments.create({
    data: {
      social_post_id: post.social_post_id,
      media_url: faker.image.url(),
      media_type: 'image',
      sequence_order: 1,
      platform_type_id: 1,
    },
  });

  await prisma.connections.create({
    data: {
      requester_id: users[0].user_id,
      receiver_id: users[1].user_id,
      status: 'accepted',
      accepted_time: new Date(),
      platform_type_id: 1,
    },
  });

  await prisma.professional_profile.create({
    data: {
      user_id: users[2].user_id,
      headline: 'Full-stack developer',
      resume_url: 'https://example.com/cv.pdf',
      open_to_work: true,
      platform_type_id: 1,
      created_at: new Date(),
    },
  });

  await prisma.behance.create({
    data: {
      behance_user_id: users[3].user_id,
      is_hireable: true,
    },
  });
  const behRow = await prisma.behance.findFirst();
  await prisma.behance_contacted.create({
    data: {
      behance_id: behRow.behance_id,
      social_post_id: post.social_post_id,
      content: 'Interested in collaboration',
      contacted_date: new Date(),
    },
  });

  // --- Chat ---
  const chatChannel = await prisma.chat_channel.create({
    data: {
      type: 'dm',
      channel_name: 'seed-channel',
      platform_type_id: 1,
    },
  });
  await prisma.chat_participants.create({
    data: { channel_id: chatChannel.channel_id, user_id: users[0].user_id, role: 'member', platform_type_id: 1 },
  });
  await prisma.chat_participants.create({
    data: { channel_id: chatChannel.channel_id, user_id: users[1].user_id, role: 'member', platform_type_id: 1 },
  });
  await prisma.chat_messages.create({
    data: {
      channel_id: chatChannel.channel_id,
      sender_id: users[0].user_id,
      content: 'Hello',
      content_type: 'text',
      sent_at: new Date(),
      is_read: false,
      platform_type_id: 1,
    },
  });

  // --- HR / employees ---
  const employeeUser = users[15];
  const employee = await prisma.employees.create({
    data: {
      employee_user_id: employeeUser.user_id,
      employee_name: faker.person.fullName(),
      employee_email: 'employee@example.com',
      employee_job_title: 'Engineer',
    },
  });
  await prisma.bank_info.create({
    data: {
      employee_id: employee.employee_id,
      account_holder: employee.employee_name,
      account_type: 'checking',
      bank_name: 'Seed Bank',
      bank_account_number: '000123',
    },
  });
  await prisma.emergency_contact.create({
    data: {
      employee_id: employee.employee_id,
      name: 'Jane Doe',
      relationship: 'Spouse',
      phone_number: '+94110000000',
    },
  });
  await prisma.employee_attendance.create({
    data: {
      employee_id: employee.employee_id,
      clock_in: new Date(),
      clock_out: new Date(),
    },
  });
  await prisma.leave.create({
    data: {
      employee_id: employee.employee_id,
      from_date: new Date(),
      to_date: new Date(),
      type: 'annual',
      status: 'pending',
    },
  });
  await prisma.payrolls.create({
    data: {
      employee_id: employee.employee_id,
      net_salary: 2500,
      epf: true,
      etf: true,
      epf_amount: 100,
      etf_amount: 50,
      status: 'paid',
      tax_percentage: 10,
    },
  });
  await prisma.shift.create({
    data: {
      employee_id: employee.employee_id,
      from_time: new Date('1970-01-01T09:00:00Z'),
      to_time: new Date('1970-01-01T17:00:00Z'),
    },
  });

  // --- Flo / symptoms ---
  const flo = await prisma.flo_user.create({
    data: { user_id: users[4].user_id, avg_cycle_length: 28, avg_period_length: 5 },
  });
  await prisma.period.create({
    data: {
      flo_user_id: flo.flo_user_id,
      start_date: new Date(),
      end_date: new Date(),
      created_at: new Date(),
    },
  });
  await prisma.cycle_prediction.create({
    data: {
      flo_user_id: flo.flo_user_id,
      cycle_start_date: new Date(),
      predicted_period_start: new Date(),
      predicted_period_end: new Date(),
    },
  });
  await prisma.symptom_log.create({
    data: {
      flo_user_id: flo.flo_user_id,
      symptom_type_id: symptomType.symptom_type_id,
      date: new Date(),
    },
  });

  // --- Driver & vehicle & rides ---
  const driverUser = users[17];
  const driverProfile = await prisma.driver_profile.create({
    data: {
      user_id: driverUser.user_id,
      license_number: 'LIC-SEED-1',
      is_online: true,
      booking_type_id: 1,
    },
  });
  const vehicle = await prisma.vehicle.create({
    data: {
      driver_id: driverProfile.driver_profile_id,
      plate_number: 'SEED-01',
      model: 'Sedan',
      vehicle_type_id: 1,
      booking_type_id: 1,
    },
  });
  const rideRequest = await prisma.ride_request.create({
    data: {
      passenger_id: users[0].user_id,
      requested_type_id: 1,
      status: 'completed',
      pickup_lat: 6.9,
      pickup_long: 79.8,
      created_at: new Date(),
    },
  });
  const activeTrip = await prisma.active_trip.create({
    data: {
      request_id: rideRequest.ride_request_id,
      driver_id: driverProfile.driver_profile_id,
      vehicle_id: vehicle.vehicle_id,
      started_at: new Date(),
      total_fare: 500,
      payment_method: 'cash',
    },
  });
  await prisma.ride_rating.create({
    data: {
      trip_id: activeTrip.trip_id,
      user_id: users[0].user_id,
      rating: 5,
      review: 'Good trip',
    },
  });

  const carpoolOffer = await prisma.carpool_offer.create({
    data: {
      driver_id: driverProfile.driver_profile_id,
      vehicle_id: vehicle.vehicle_id,
      origin_city: 'Colombo',
      destination_city: 'Kandy',
      departure_time: new Date(),
      price_per_seat: 400,
      total_seats: 4,
      available_seats: 3,
    },
  });
  await prisma.carpool_waypoints.create({
    data: { offer_id: carpoolOffer.carpool_offer_id, city_name: 'Peradeniya', pickup_allowed: true },
  });
  await prisma.carpool_booking.create({
    data: {
      offer_id: carpoolOffer.carpool_offer_id,
      passenger_id: users[1].user_id,
      seats_booked: 1,
      total_cost: 400,
      status: 'confirmed',
    },
  });

  // --- Influencer / talent / cam ---
  const infl = await prisma.influencer.create({
    data: { user_id: users[5].user_id, influencer_description: 'Lifestyle', influencer_image_url: faker.image.url() },
  });
  await prisma.hire_influencer.create({
    data: {
      influencer_id: infl.influencer_id,
      user_id: users[6].user_id,
      hire_influencer_description: 'Campaign',
      hire_influencer_date: new Date(),
    },
  });
  const tal = await prisma.talent.create({
    data: {
      talent_user_id: users[7].user_id,
      talent_description: 'Illustration',
      talent_category_id: talentCategory.talent_category_id,
    },
  });
  const camPost = await prisma.cam_post.create({
    data: {
      talent_id: tal.talent_id,
      avg_duration: 30,
      description: 'Custom portrait',
      price: 99,
    },
  });
  await prisma.cam_post_image.create({
    data: { cam_post_id: camPost.cam_post_id, image_url: faker.image.url() },
  });
  await prisma.cam_post_order.create({
    data: {
      cam_post_id: camPost.cam_post_id,
      user_id: users[8].user_id,
      duration: 30,
      status: 'pending',
      order_time: new Date(),
      checkout_id: checkout.checkout_id,
    },
  });

  // --- Calm ---
  const calmProv = await prisma.calm_providers.create({
    data: {
      provider_user_id: users[9].user_id,
      calm_provider_category_id: calmCategory.calm_category_id,
    },
  });
  const calmLesson = await prisma.calm_lesson.create({
    data: {
      calm_provider_id: calmProv.calm_provider_id,
      lesson_name: 'Breathing',
      lesson_price: 5,
    },
  });
  await prisma.calm_lesson_image.create({
    data: { calm_lesson_id: calmLesson.calm_lesson_id, image_url: faker.image.url() },
  });
  await prisma.calm_lesson_parts.create({
    data: {
      calm_lesson_id: calmLesson.calm_lesson_id,
      lesson_part_order: 1,
      content_url: 'https://example.com/part1.mp4',
      part_name: 'Intro',
    },
  });
  await prisma.calm_lesson_order_buy.create({
    data: {
      calm_lesson_id: calmLesson.calm_lesson_id,
      user_id: users[10].user_id,
      order_time: new Date(),
      status: 'completed',
    },
  });

  // --- Appointments ---
  const apptProvider = await prisma.appointment_service_providers.create({
    data: {
      service_provider_user_id: users[11].user_id,
      company_name: 'Seed Spa',
      company_phone_number: '+94111222333',
    },
  });
  const apptService = await prisma.appointment_service.create({
    data: {
      service_name: 'Massage',
      service_price: 75,
      service_category_id: appointmentServiceCategory.service_category_id,
    },
  });
  const appointment = await prisma.appointments.create({
    data: {
      service_provider_id: apptProvider.service_provider_id,
      user_id: users[12].user_id,
      service_id: apptService.service_id,
      checkout_id: checkout.checkout_id,
      date: new Date(),
      time_from: new Date(),
      time_to: new Date(),
      status: 'confirmed',
    },
  });
  await prisma.appointment_rating.create({
    data: {
      user_id: users[12].user_id,
      appointment_id: appointment.appointment_id,
      rating: 5,
      review: 'Relaxing',
    },
  });
  await prisma.appointment_reviews.create({
    data: {
      user_id: users[12].user_id,
      appointment_id: appointment.appointment_id,
      review: 'Great service',
    },
  });

  // --- Cloth ---
  await prisma.cloth.create({
    data: {
      user_id: users[13].user_id,
      cloth_category_id: clothCategory.cloth_category_id,
      cloth_type_id: clothType.cloth_type_id,
      color: 'blue',
      cloth_image_url: faker.image.url(),
    },
  });

  // --- Courier (driver_profile + driver_courier_profile — unified driver identity) ---
  const courierDriverProfile = await prisma.driver_profile.create({
    data: { user_id: users[14].user_id },
  });
  await prisma.driver_courier_profile.create({
    data: {
      driver_profile_id: courierDriverProfile.driver_profile_id,
      display_name: 'Fast Courier',
      price_per_km: 50,
    },
  });
  const courierCust = await prisma.courier_customer.create({
    data: { user_id: users[0].user_id },
  });
  await prisma.courier_order.create({
    data: {
      customer_id: courierCust.customer_id,
      courier_service_provider_id: courierDriverProfile.driver_profile_id,
      status: 'picked_up',
      checkout_id: checkout.checkout_id,
      price: 1200,
    },
  });

  // --- DG content ---
  const dgContent = await prisma.dg_content.create({
    data: {
      content_title: 'Seed Asset Pack',
      content_url: 'https://example.com/asset.zip',
      price: 19.99,
      dg_category_id: dgCategory.dg_category_id,
      date: new Date(),
    },
  });
  await prisma.dg_cart.create({
    data: {
      buyer_id: users[1].user_id,
      content_id: dgContent.content_id,
      qty: 1,
      total: dec('19.99'),
      dg_category_id: dgCategory.dg_category_id,
    },
  });
  await prisma.dg_order.create({
    data: {
      buyer_id: users[1].user_id,
      content_id: dgContent.content_id,
      total: 19.99,
      qty: 1,
      dg_category_id: dgCategory.dg_category_id,
      checkout_id: checkout.checkout_id,
    },
  });

  await prisma.cs_content.create({
    data: {
      content_title: 'How-to',
      cs_category_id: csCategory.cs_category_id,
      cs_type_id: csType.cs_type_id,
      date: new Date(),
    },
  });
  await prisma.user_content_subscription_mapping.create({
    data: {
      user_id: users[2].user_id,
      cs_type_id: csType.cs_type_id,
      is_paid: true,
      expire_date: new Date(Date.now() + 30 * 86400000),
    },
  });

  // --- Delivery driver & food extensions (driver_profile + driver_delivery_profile) ---
  let restaurantVendorType = await prisma.vendor_type.findFirst({
    where: { vendor_type: { equals: 'Restaurant', mode: 'insensitive' } },
  });
  if (!restaurantVendorType) {
    restaurantVendorType = await prisma.vendor_type.create({ data: { vendor_type: 'Restaurant' } });
  }
  const restaurantVendorTypeId = restaurantVendorType.vendor_type_id;

  const deliveryDriverProfile = await prisma.driver_profile.create({
    data: { user_id: users[16].user_id, is_online: true, accepts_food: true, accepts_product: true },
  });
  await prisma.driver_delivery_profile.create({
    data: {
      driver_profile_id: deliveryDriverProfile.driver_profile_id,
      vendor_type_id: restaurantVendorTypeId,
    },
  });

  // --- Discord ---
  const discord = await prisma.discord_server.create({
    data: {
      server_name: 'Seed Server',
      server_owner: users[3].user_id,
      created_at: new Date(),
    },
  });
  const member = await prisma.server_members.create({
    data: { server_id: discord.server_id, user_id: users[4].user_id },
  });
  await prisma.server_message.create({
    data: {
      server_id: discord.server_id,
      sender_user_id: users[4].user_id,
      message: 'Hi',
      sent_time: new Date(),
    },
  });
  await prisma.discord_stream.create({
    data: {
      server_member_id: member.server_member_id,
      is_audio: true,
      is_video: false,
      start_time: new Date(),
    },
  });

  // --- Projects / donations / property / loans ---
  const project = await prisma.projects.create({
    data: {
      owner_user_id: users[5].user_id,
      project_name: 'Community Garden',
      title: 'Green space',
      description: 'Building a garden',
      expected_amount: 10000,
      current_amount: 500,
      posted_date: new Date(),
    },
  });
  await prisma.donations.create({
    data: {
      donated_user_id: users[6].user_id,
      amount: 25,
      donated_date: new Date(),
      project_id: project.project_id,
    },
  });

  const prop = await prisma.property.create({
    data: {
      user_id: users[7].user_id,
      estimated_value: 250000,
      type: 'house',
      address: '123 Seed St',
    },
  });
  const loanProv = await prisma.loan_provider.create({
    data: { user_id: users[8].user_id, description: 'Seed Loans' },
  });
  const loan = await prisma.loans.create({
    data: {
      property_id: prop.property_id,
      user_id: users[7].user_id,
      loan_provider_id: loanProv.loan_provider_id,
      loan_amount: 50000,
      loan_term: 240,
      interest_rate: 8.5,
      status: 'active',
      created_at: new Date(),
    },
  });
  await prisma.loan_payment.create({
    data: { loan_id: loan.loan_id, amount_paid: 500, date: new Date() },
  });

  // --- Meetup ---
  const meetup = await prisma.meetup_event.create({
    data: {
      meetup_event_name: 'Hike',
      meetup_event_category_id: meetupCategory.meetup_category_id,
      meetup_event_organizer: users[9].user_id,
      meetup_event_start_time: new Date(),
      meetup_event_max_attendees: 20,
    },
  });
  await prisma.meetup_event_image.create({
    data: { meetup_event_id: meetup.meetup_event_id, image_url: faker.image.url() },
  });
  await prisma.meetup_attendees.create({
    data: { meetup_event_id: meetup.meetup_event_id, user_id: users[10].user_id, role: 'attendee' },
  });

  // --- Place booking ---
  const place = await prisma.place.create({
    data: {
      user_id: users[11].user_id,
      event_type_id: 1,
      location_address: 'Downtown hall',
      price_per_hour: 40,
    },
  });
  await prisma.place_pics.create({
    data: { place_id: place.place_id, place_pic_url: faker.image.url(), event_type_id: 1 },
  });
  await prisma.place_orders.create({
    data: {
      place_id: place.place_id,
      user_id: users[12].user_id,
      event_type_id: 1,
      no_of_hours: 2,
      price: 80,
      status: 'pending',
    },
  });

  // --- Jobs ---
  const agent = await prisma.agents.create({
    data: {
      agent_user_id: users[18].user_id,
      company_name: 'Seed Recruiters',
      role: 'agent',
      company_web_url: 'https://seed-recruiters.example.com',
      company_country: 'Canada',
      company_description: 'A demo employer used for seeding the jobs vertical.',
      company_size: '11-50',
      industry: 'Technology',
    },
  });
  const job = await prisma.jobs.create({
    data: {
      job_name: 'Backend Developer',
      description: 'Build and maintain Node.js services for the Strug platform.',
      job_category_id: jobCategory.job_category_id,
      agent_id: agent.agent_id,
      posted_date: new Date(),
      location: 'Toronto, ON',
      is_remote: true,
      employment_type: 'full_time',
      salary_min: 90000,
      salary_max: 130000,
      salary_period: 'year',
      experience_level: 'mid',
      status: 'open',
    },
  });
  const cand = await prisma.candidate.create({
    data: {
      candidate_user_id: users[19].user_id,
      headline: 'Full-stack developer',
      bio: 'Demo job-seeker profile seeded for the jobs vertical.',
      skills: 'JavaScript, Node.js, React, SQL',
      location: 'Toronto, ON',
      desired_salary: 110000,
      years_experience: 4,
    },
  });
  await prisma.job_application.create({
    data: {
      job_id: job.job_id,
      candidate_id: cand.candidate_id,
      application_date: new Date(),
      cv_url: 'https://example.com/cv.pdf',
      cover_letter: 'I am excited to apply for this role.',
      status: 'applied',
      updated_at: new Date(),
    },
  });

  // --- Flash cards & lessons ---
  const deck = await prisma.flash_card_deck.create({
    data: {
      flash_card_deck_name: 'Capitals',
      flash_card_deck_category_id: flashCardCategory.flash_card_category_id,
      flash_card_deck_creator: users[0].user_id,
    },
  });
  const flash = await prisma.flash_card.create({
    data: {
      flash_card_topic: 'World',
      flash_card_question: 'Capital of France?',
      flash_card_answer: 'Paris',
      flash_card_category_id: flashCardCategory.flash_card_category_id,
      flash_card_creator: users[0].user_id,
      flash_card_deck_id: deck.flash_card_deck_id,
    },
  });
  await prisma.flash_card_deck_user.create({
    data: { flash_card_deck_id: deck.flash_card_deck_id, user_id: users[1].user_id, is_complete: false },
  });
  await prisma.flash_card_user_do.create({
    data: { flash_card_id: flash.flash_card_id, user_id: users[1].user_id, rating: 4, no_of_appearance: 1 },
  });

  const lesson = await prisma.lesson.create({
    data: { lesson_name: 'Greetings', language_id: language.language_id, level: 'A1' },
  });
  const qo = await prisma.question_option.create({
    data: { lesson_id: lesson.lesson_id, question: 'Hello = ?' },
  });
  const qoa = await prisma.question_option_answer.create({
    data: { question_option_id: qo.question_option_id, answer: 'Hi', is_correct: true },
  });
  await prisma.lesson_user.create({
    data: { lesson_id: lesson.lesson_id, user_id: users[2].user_id, is_complete: false },
  });
  await prisma.question_answer_user.create({
    data: {
      question_option_id: qo.question_option_id,
      question_option_answer_id: qoa.question_option_answer_id,
      user_id: users[2].user_id,
      is_correct: true,
    },
  });

  // --- Rental ---
  const rentalListing = await prisma.rental_listing.create({
    data: {
      rental_category_id: rentalCategory.rental_category_id,
      owner_id: users[13].user_id,
      rental_listing_name: 'Power drill',
      amount: 15,
      rental_type_id: rentalType.rental_type_id,
    },
  });
  await prisma.rental_listing_pics.create({
    data: {
      rental_listing_id: rentalListing.rental_listing_id,
      url: faker.image.url(),
      rental_type_id: rentalType.rental_type_id,
    },
  });
  await prisma.rental_cart.create({
    data: {
      rental_listing_id: rentalListing.rental_listing_id,
      buyer_id: users[14].user_id,
      qty: 1,
      total: dec('15.00'),
      rental_type_id: rentalType.rental_type_id,
    },
  });
  const rentalOrder = await prisma.rental_order.create({
    data: {
      rental_listing_id: rentalListing.rental_listing_id,
      buyer_id: users[14].user_id,
      total: 15,
      qty: 1,
      rental_type_id: rentalType.rental_type_id,
      checkout_id: checkout.checkout_id,
    },
  });
  await prisma.rental_ratings.create({
    data: {
      order_id: rentalOrder.order_id,
      buyer_id: users[14].user_id,
      rating: 5,
      rental_type_id: rentalType.rental_type_id,
    },
  });

  // --- Streaming ---
  const streamer = await prisma.streamer.create({
    data: { streamer_user_id: users[20].user_id, is_save: true },
  });
  const stream = await prisma.stream.create({
    data: {
      streamer_id: streamer.streamer_id,
      stream_name: 'Seed Stream',
      start_time: new Date(),
      stream_url: 'https://example.com/live.m3u8',
    },
  });
  await prisma.stream_chat.create({
    data: { stream_id: stream.stream_id, user_id: users[0].user_id, message: 'glhf', sent_time: new Date() },
  });

  // --- Service marketplace ---
  const usp = await prisma.user_service_provider.create({
    data: {
      services_id: serviceOffering.services_id,
      user_id: users[21].user_id,
      service_type_id: serviceType.service_type_id,
      is_active: true,
    },
  });
  await prisma.service_cv.create({
    data: { provider_id: usp.provider_id, url: 'https://example.com/cert.pdf', service_type_id: serviceType.service_type_id },
  });
  await prisma.service_cart.create({
    data: {
      provider_id: usp.provider_id,
      buyer_id: users[0].user_id,
      qty: 1,
      total: dec('49.99'),
      service_type_id: serviceType.service_type_id,
    },
  });
  const svcOrder = await prisma.service_order.create({
    data: {
      provider_id: usp.provider_id,
      buyer_id: users[0].user_id,
      total: 49.99,
      qty: 1,
      service_type_id: serviceType.service_type_id,
      checkout_id: checkout.checkout_id,
    },
  });
  await prisma.service_ratings.create({
    data: {
      provider_id: usp.provider_id,
      order_id: svcOrder.order_id,
      buyer_id: users[0].user_id,
      rating: 5,
      service_type_id: serviceType.service_type_id,
    },
  });

  // --- E-commerce (listings / cart / order / ratings) ---
  console.log('Seeding shop listings...');
  const sellers = users.filter((u) => u.is_seller);
  let firstVariation = null;
  for (const seller of sellers) {
    for (let i = 0; i < 2; i++) {
      const listing = await prisma.product_listing.create({
        data: {
          name: faker.commerce.productName(),
          description: faker.commerce.productDescription(),
          availability: 100,
          product_type_id: faker.helpers.arrayElement(productTypeIds),
        },
      });
      const v = await prisma.product_variation.create({
        data: {
          listing_id: listing.listing_id,
          price: parseFloat(faker.commerce.price()),
          vname: 'Default',
          product_type_id: listing.product_type_id,
        },
      });
      if (!firstVariation) firstVariation = v;
    }
  }
  await prisma.product_cart.create({
    data: {
      seller_id: sellers[0].user_id,
      buyer_id: users[1].user_id,
      variation_id: firstVariation.variation_id,
      qty: 1,
      total: dec('50.00'),
      product_type_id: firstVariation.product_type_id,
    },
  });
  const prodOrder = await prisma.product_order.create({
    data: {
      seller_id: sellers[0].user_id,
      buyer_id: users[1].user_id,
      variation_id: firstVariation.variation_id,
      total: 50,
      qty: 1,
      product_type_id: firstVariation.product_type_id,
      checkout_id: checkout.checkout_id,
    },
  });
  await prisma.product_ratings.create({
    data: {
      seller_id: sellers[0].user_id,
      buyer_id: users[1].user_id,
      order_id: prodOrder.order_id,
      rating: 4,
      product_type_id: firstVariation.product_type_id,
    },
  });

  // --- Food ---
  console.log('Seeding food vendors...');
  let firstFoodItem = null;
  let firstVendor = null;
  for (let i = 0; i < 5; i++) {
    const vendor = await prisma.food_vendor.create({
      data: {
        owner_id: users[i].user_id,
        vendor_name: `${faker.company.name()} Restaurant`,
        cuisine_type: 'International',
        is_open: true,
        is_active: true,
        location: faker.location.streetAddress(),
        vendor_type_id: restaurantVendorTypeId,
      },
    });
    if (!firstVendor) firstVendor = vendor;
    const category = await prisma.food_category.create({
      data: {
        vendor_id: vendor.vendor_id,
        name: 'Main Course',
        vendor_type_id: restaurantVendorTypeId,
      },
    });
    for (let j = 0; j < 3; j++) {
      const fi = await prisma.food_item.create({
        data: {
          vendor_id: vendor.vendor_id,
          food_category_id: category.food_category_id,
          name: faker.food.dish(),
          description: faker.food.description(),
          price: parseFloat(faker.commerce.price({ min: 5, max: 50 })),
          is_available: true,
          stock_qty: 50,
          vendor_type_id: restaurantVendorTypeId,
        },
      });
      if (!firstFoodItem) firstFoodItem = fi;
    }
  }
  await prisma.food_item_pics.create({
    data: { food_item_id: firstFoodItem.food_item_id, url: faker.image.url(), vendor_type_id: restaurantVendorTypeId },
  });
  const foodOrder = await prisma.food_order.create({
    data: {
      user_id: users[15].user_id,
      vendor_id: firstVendor.vendor_id,
      driver_id: deliveryDriverProfile.driver_profile_id,
      vendor_type_id: restaurantVendorTypeId,
      order_status: 'delivered',
      total_amount: 1500,
      created_at: new Date(),
      ispaid: true,
    },
  });
  await prisma.food_order_items.create({
    data: {
      order_id: foodOrder.food_order_id,
      food_item_id: firstFoodItem.food_item_id,
      qty: 2,
      price_item: firstFoodItem.price,
      vendor_type_id: restaurantVendorTypeId,
    },
  });
  await prisma.food_cart.create({
    data: {
      buyer_id: users[16].user_id,
      vendor_id: firstVendor.vendor_id,
      food_item_id: firstFoodItem.food_item_id,
      qty: 1,
    },
  });

  // --- Video / channel / wallet / ads ---
  console.log('Seeding video & wallet...');
  const videos = [];
  for (let i = 0; i < 5; i++) {
    const channel = await prisma.channel.create({
      data: {
        user_id: users[i + 5].user_id,
        handle: `creator_${i}_${faker.string.alphanumeric(4)}`,
        display_name: `Creator ${i}`,
        description: faker.lorem.sentence(),
      },
    });
    for (let j = 0; j < 2; j++) {
      const vid = await prisma.video.create({
        data: {
          channel_id: channel.channel_id,
          title: faker.lorem.words(3),
          description: faker.lorem.paragraph(),
          raw_video_url: 'https://example.com/video.mp4',
          status: 'safe',
          video_type: 'long',
          ad_revenue: dec('0'),
        },
      });
      videos.push(vid);
    }
  }
  const video = videos[0];
  await prisma.subscription.create({
    data: { user_id: users[0].user_id, channel_id: video.channel_id },
  });
  await prisma.video_comments.create({
    data: { video_id: video.video_id, user_id: users[1].user_id, content: 'Nice video' },
  });
  await prisma.video_likes.create({
    data: { video_id: video.video_id, user_id: users[2].user_id, is_like: true },
  });
  await prisma.video_analytics.create({
    data: { video_id: video.video_id, watch_time_sec: 120, viewer_country: 'LK', device_type: 'mobile' },
  });
  await prisma.watch_history.create({
    data: { user_id: users[3].user_id, video_id: video.video_id, last_position: 30 },
  });

  await prisma.strug_wallet.create({
    data: { user_id: users[0].user_id, balance: dec('1000.00'), currency: 'CAD' },
  });
  await prisma.wallet_transaction.create({
    data: {
      user_id: users[0].user_id,
      amount: dec('50.00'),
      type: 'credit',
      source: 'ad_revenue',
      description: 'Seed txn',
    },
  });

  const ad = await prisma.ads.create({
    data: {
      advertiser_id: users[4].user_id,
      title: 'Seed Ad',
      ad_type: 'banner',
      vertical: 'video',
      media_url: faker.image.url(),
      target_url: 'https://example.com',
    },
  });
  await prisma.ad_impressions.create({
    data: {
      ad_id: ad.ad_id,
      video_id: video.video_id,
      viewer_id: users[5].user_id,
      revenue_generated: dec('1.2500'),
    },
  });
  await prisma.revenue_share_log.create({
    data: {
      video_id: video.video_id,
      total_earned: dec('10.0000'),
      creator_share: dec('7.0000'),
      platform_share: dec('3.0000'),
    },
  });

  console.log('--- Seeding Completed Successfully ---');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
