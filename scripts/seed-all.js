import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();
const PASSWORD = 'Strug2026!';

function encryptEmail(text) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = Buffer.alloc(16, 0);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(text, 'utf8', 'hex');
  enc += cipher.final('hex');
  return enc;
}

async function createUser({ email, name, handle, isSeller = false }) {
  const encEmail = encryptEmail(email);
  const existing = await prisma.user.findUnique({ where: { email: encEmail } });
  if (existing) return existing;

  const hashed = await bcrypt.hash(PASSWORD, 10);
  // #428: seeded accounts must not advertise themselves. The referral code is PUBLIC on every
  // profile since #423, so a 'SEED...' / 'DUMMY-...' prefix tells any visitor the account is fake.
  // Use the same shape real accounts get.
  const refCode = 'STRUG-' + Math.random().toString(36).slice(2, 10).toUpperCase();
  const user = await prisma.user.create({
    data: {
      name,
      email: encEmail,
      password: hashed,
      ref_code: refCode,
      is_seller: isSeller,
      has_seen_welcome: true, // seeded accounts are not new users — see #416
    },
  });

  await prisma.social_profile.upsert({
    where: { handle },
    update: {},
    create: { user_id: user.user_id, handle, display_name: name, accepted_terms: true },
  });

  return user;
}

async function main() {
  // Idempotency guard — skip only if accounts AND content are all fully created
  // Only skip if every major content type is present
  const [accountsCnt, productsCnt, channelsCnt, vendorsCnt, rentalsCnt, vehiclesCnt, talentCnt] = await Promise.all([
    prisma.social_profile.count({ where: { handle: 'stylehaus' } }),
    prisma.product_listing.count(),
    prisma.channel.count(),
    prisma.food_vendor.count(),
    prisma.rental_listing.count(),
    prisma.vehicle.count(),
    prisma.talent.count(),
  ]);
  if (accountsCnt > 0 && productsCnt >= 15 && channelsCnt >= 5 && vendorsCnt >= 5 && rentalsCnt >= 5 && vehiclesCnt >= 7 && talentCnt >= 5) {
    console.log(`\n⚠️  Seed data fully present. Skipping.\n`);
    return;
  }

  // Check which steps already ran to avoid duplicates on partial re-runs
  const usersAlreadySeeded = await prisma.social_profile.count({ where: { handle: 'sofiadelmar' } }) > 0;
  const postsAlreadySeeded = usersAlreadySeeded && (await prisma.social_feed.count({ where: { status: 'published' } })) >= 10;
  const storiesAlreadySeeded = usersAlreadySeeded && (await prisma.social_story.count()) >= 5;
  const videosAlreadySeeded = usersAlreadySeeded && (await prisma.channel.count()) >= 5;

  console.log('🌱 Seeding database...\n');

  // ============================================================
  // STEP 0 — Reference / lookup tables (safe to upsert always)
  // ============================================================

  console.log('Ensuring reference tables...');

  // product_type
  const productTypeRows = [
    { product_type_id: 1, product_type_name: 'Clothing & Fashion' },
    { product_type_id: 2, product_type_name: 'Electronics' },
    { product_type_id: 3, product_type_name: 'Home & Living' },
    { product_type_id: 4, product_type_name: 'Sports & Outdoors' },
    { product_type_id: 5, product_type_name: 'Handmade & Crafts' },
    { product_type_id: 6, product_type_name: 'Books & Media' },
    { product_type_id: 7, product_type_name: 'Beauty & Health' },
  ];
  for (const r of productTypeRows) {
    await prisma.product_type.upsert({
      where: { product_type_id: r.product_type_id },
      update: {},
      create: r,
    });
  }

  // meetup_category
  await prisma.meetup_category.upsert({
    where: { meetup_category_id: 1 },
    update: {},
    create: { meetup_category_id: 1, meetup_category_name: 'General' },
  }).catch(() => {});

  // calm_category
  await prisma.calm_category.upsert({
    where: { calm_category_id: 1 },
    update: {},
    create: { calm_category_id: 1 },
  }).catch(() => {});

  // talent_category
  await prisma.talent_category.upsert({
    where: { talent_category_id: 1 },
    update: {},
    create: { talent_category_id: 1, talent_category_name: 'General' },
  }).catch(() => {});

  // vendor_type — resolve/create by NAME (IDs are not stable across environments).
  // Seed the full food-family set so vertical browse (Food / Groceries / Floral / …)
  // resolves type ids on a fresh database instead of returning empty.
  const FOOD_FAMILY_VENDOR_TYPES = [
    'Restaurant', 'Grocery', 'Floral', 'Catering', 'Meal Kit', 'Pharmacy', 'Liquor',
  ];
  const vendorTypeIdsByName = {};
  for (const name of FOOD_FAMILY_VENDOR_TYPES) {
    let row = await prisma.vendor_type.findFirst({
      where: { vendor_type: { equals: name, mode: 'insensitive' } },
    });
    if (!row) {
      row = await prisma.vendor_type.create({ data: { vendor_type: name } });
    }
    vendorTypeIdsByName[name] = row.vendor_type_id;
  }
  const restaurantVendorTypeId = vendorTypeIdsByName.Restaurant;

  // rental_type
  await prisma.rental_type.upsert({
    where: { rental_type_id: 1 },
    update: {},
    create: { rental_type_id: 1, rental_type_name: 'Entire Place' },
  }).catch(() => {});

  // vehicle_types (IDs 1=SUV, 2=Electric, 3=Sedan)
  for (const [id, name] of [[1, 'SUV'], [2, 'Electric'], [3, 'Sedan']]) {
    await prisma.vehicle_types.upsert({
      where: { vehicle_type_id: id },
      update: {},
      create: { vehicle_type_id: id, name },
    }).catch(() => {});
  }

  console.log('✓ Reference tables ready\n');

  // ============================================================
  // STEP 1 — Create user accounts
  // ============================================================

  console.log('Creating user accounts...');

  const uSofia    = await createUser({ email: 'seed_sofia@strug.ca',   name: 'Sofia del Mar',        handle: 'sofiadelmar' });
  const uMarcus   = await createUser({ email: 'seed_marcus@strug.ca',  name: 'Marcus Osei',           handle: 'marcosei' });
  const uAdaeze   = await createUser({ email: 'seed_adaeze@strug.ca',  name: 'Adaeze Eats',           handle: 'adaezeeats' });
  const uNova     = await createUser({ email: 'seed_nova@strug.ca',    name: 'TechWithNova',          handle: 'techwithnova' });
  const uCoach    = await createUser({ email: 'seed_coach@strug.ca',   name: 'Coach Adebayo',         handle: 'coachadebayo' });
  const uZara     = await createUser({ email: 'seed_zara@strug.ca',    name: 'Zara Vibe',             handle: 'zaravibe' });
  const uPriya    = await createUser({ email: 'seed_priya@strug.ca',   name: 'Priya W.',              handle: 'priyaw' });
  const uVince    = await createUser({ email: 'seed_vince@strug.ca',   name: 'Vince V.',              handle: 'vincevibe' });
  const uRiley    = await createUser({ email: 'seed_riley@strug.ca',   name: 'CodeWithRiley',         handle: 'codewithriley' });
  const uJordan   = await createUser({ email: 'seed_jordan@strug.ca',  name: 'Jordan Eats',           handle: 'jordaneats' });
  const uMorgan   = await createUser({ email: 'seed_morgan@strug.ca',  name: 'FitWithMorgan',         handle: 'fitwithmorgan' });
  const uAlex     = await createUser({ email: 'seed_alex@strug.ca',    name: 'Alex Rivera',           handle: 'alexrivera' });
  const uChef     = await createUser({ email: 'seed_chef@strug.ca',    name: 'Chef Lorenzo',          handle: 'cheflorenzo' });
  const uGreen    = await createUser({ email: 'seed_green@strug.ca',   name: 'The Green Bowl',        handle: 'thegreenbowl' });
  const uSweet    = await createUser({ email: 'seed_sweet@strug.ca',   name: 'Sweet Dreams Bakery',   handle: 'sweetdreamsbakery' });
  const uShop1    = await createUser({ email: 'seed_shop1@strug.ca',   name: 'StyleHaus Shop',        handle: 'stylehaus', isSeller: true });
  const uShop2    = await createUser({ email: 'seed_shop2@strug.ca',   name: 'TechGadgetsPro',        handle: 'techgadgetspro', isSeller: true });
  const uShop3    = await createUser({ email: 'seed_shop3@strug.ca',   name: 'HomeDecor Hub',         handle: 'homedecorhub', isSeller: true });
  const uShop4    = await createUser({ email: 'seed_shop4@strug.ca',   name: 'FreshKicks Store',      handle: 'freshkicks', isSeller: true });
  const uShop5    = await createUser({ email: 'seed_shop5@strug.ca',   name: 'Crafted Goods Co.',     handle: 'craftedgoods', isSeller: true });
  const uHost1    = await createUser({ email: 'seed_host1@strug.ca',   name: 'EventHive',             handle: 'eventhive' });
  const uHost2    = await createUser({ email: 'seed_host2@strug.ca',   name: 'The Venue Lab',         handle: 'thevenuelab' });
  const uHost3    = await createUser({ email: 'seed_host3@strug.ca',   name: 'Urban Spaces TO',       handle: 'urbanspacesto' });
  const uMed1     = await createUser({ email: 'seed_med1@strug.ca',    name: 'Dr. Amir Patel',        handle: 'dramirpatel' });
  const uMed2     = await createUser({ email: 'seed_med2@strug.ca',    name: 'Dr. Nadia Chen',        handle: 'drnadiachen' });
  const uMed3     = await createUser({ email: 'seed_med3@strug.ca',    name: 'Dr. Samuel Torres',     handle: 'drsamueltorres' });
  const uMed4     = await createUser({ email: 'seed_med4@strug.ca',    name: 'Dr. Fatima Al-Rashid',  handle: 'drfatimaralrashid' });
  const uMed5     = await createUser({ email: 'seed_med5@strug.ca',    name: 'Dr. Leo Williams',      handle: 'drleowilliams' });
  const uTalent1  = await createUser({ email: 'seed_talent1@strug.ca', name: 'Maya Starfield',        handle: 'mayastarfield' });
  const uTalent2  = await createUser({ email: 'seed_talent2@strug.ca', name: 'DJ Kontrol',            handle: 'djkontrol' });
  const uTalent3  = await createUser({ email: 'seed_talent3@strug.ca', name: 'Nia Speaks',            handle: 'niaspeaks' });
  const uTalent4  = await createUser({ email: 'seed_talent4@strug.ca', name: 'Visual by Victor',      handle: 'visualbyvictor' });
  const uTalent5  = await createUser({ email: 'seed_talent5@strug.ca', name: 'The Wedding Trio',      handle: 'thewedingtrio' });
  const uInf1     = await createUser({ email: 'seed_inf1@strug.ca',    name: 'Lena Luxe',             handle: 'lenaluxe' });
  const uInf2     = await createUser({ email: 'seed_inf2@strug.ca',    name: 'BuildWithBen',          handle: 'buildwithben' });
  const uInf3     = await createUser({ email: 'seed_inf3@strug.ca',    name: 'FoodieByFaith',          handle: 'foodiebyfaith' });
  const uInf4     = await createUser({ email: 'seed_inf4@strug.ca',    name: 'GlowUpGrace',           handle: 'glowupgrace' });

  console.log('✓ Users created\n');

  const PLACEHOLDER_URL = 'https://www.w3schools.com/html/mov_bbb.mp4';
  const PLACEHOLDER_THUMB = 'https://picsum.photos/seed/strug/400/300';

  // Lookup social profile IDs
  const profile = async (uid) => prisma.social_profile.findUnique({ where: { user_id: uid } });
  const pSofia  = await profile(uSofia.user_id);
  const pMarcus = await profile(uMarcus.user_id);
  const pAdaeze = await profile(uAdaeze.user_id);
  const pNova   = await profile(uNova.user_id);
  const pCoach  = await profile(uCoach.user_id);
  const pZara   = await profile(uZara.user_id);
  const pPriya  = await profile(uPriya.user_id);
  const pVince  = await profile(uVince.user_id);

  // ============================================================
  // STEP 2 — Social posts (social_feed)
  // ============================================================

  if (postsAlreadySeeded) { console.log('⏭  Social posts already seeded — skipping\n'); }
  else { console.log('Seeding social posts...');
  const postsData = [
    { profile_id: pSofia.profile_id,  caption_text: "Morning light in the city hits differently ☀️ Starting this week with gratitude and good energy. What's your go-to morning ritual?" },
    { profile_id: pMarcus.profile_id, caption_text: "Just wrapped up a 12-hour coding session. The product is alive — shipping next week. Hard work always pays off." },
    { profile_id: pAdaeze.profile_id, caption_text: "New jollof recipe drop! 🍚 Secret ingredient: patience and joyful ancestors. Comment below if you want the full recipe." },
    { profile_id: pNova.profile_id,   caption_text: "AI tools I'm using in 2026 that changed how I work completely. Thread below 👇 #tech #productivity" },
    { profile_id: pCoach.profile_id,  caption_text: "3 things no one tells you about discipline: 1. It's a skill, not a trait. 2. It compounds. 3. It starts with one small win today." },
    { profile_id: pZara.profile_id,   caption_text: "Outfit of the day — thrifted blazer, vintage denim. Sustainable fashion is style, full stop. 🌿" },
    { profile_id: pPriya.profile_id,  caption_text: "Spent the weekend volunteering at the community garden. Reminder that slowing down is also moving forward." },
    { profile_id: pVince.profile_id,  caption_text: "New EP out Friday. Four tracks, zero filler. 🎵 Been working on this for 8 months — can't wait for you to hear it." },
    { profile_id: pCoach.profile_id,  caption_text: "Progress update: 60 days into the challenge. The community support has been unreal. You all keep me going 💪" },
    { profile_id: pSofia.profile_id,  caption_text: "Book recommendation: The Midnight Library. Read it in one sitting. Some stories just hit you at the right moment." },
  ];
  for (const post of postsData) {
    await prisma.social_feed.create({ data: { ...post, status: 'published' } });
  }
  console.log('✓ Social posts seeded\n');
  } // end postsAlreadySeeded guard

  // ============================================================
  // STEP 3 — Social stories
  // ============================================================

  if (storiesAlreadySeeded) { console.log('⏭  Social stories already seeded — skipping\n'); }
  else { console.log('Seeding social stories...');
  const storiesData = [
    { profile_id: pSofia.profile_id,  media_url: PLACEHOLDER_THUMB, media_type: 'image', expires_at: new Date(Date.now() + 24*60*60*1000) },
    { profile_id: pMarcus.profile_id, media_url: PLACEHOLDER_THUMB, media_type: 'image', expires_at: new Date(Date.now() + 24*60*60*1000) },
    { profile_id: pAdaeze.profile_id, media_url: PLACEHOLDER_THUMB, media_type: 'image', expires_at: new Date(Date.now() + 24*60*60*1000) },
    { profile_id: pZara.profile_id,   media_url: PLACEHOLDER_THUMB, media_type: 'image', expires_at: new Date(Date.now() + 24*60*60*1000) },
    { profile_id: pCoach.profile_id,  media_url: PLACEHOLDER_THUMB, media_type: 'image', expires_at: new Date(Date.now() + 24*60*60*1000) },
  ];
  for (const story of storiesData) {
    await prisma.social_story.create({ data: story });
  }
  console.log('✓ Social stories seeded\n');
  } // end storiesAlreadySeeded guard

  // ============================================================
  // STEP 4 — Channels + Videos
  // ============================================================

  if (videosAlreadySeeded) { console.log('⏭  Channels and videos already seeded — skipping\n'); }
  else { console.log('Seeding channels and videos...');
  const channelOwners = [
    { user: uRiley,  handle: 'codewithriley',   display_name: 'CodeWithRiley',   description: 'Software tutorials, career tips, and side project builds.' },
    { user: uJordan, handle: 'jordaneatstv',     display_name: 'Jordan Eats TV',  description: 'Food reviews, restaurant tours, and recipe experiments.' },
    { user: uMorgan, handle: 'fitwithmorgan',    display_name: 'FitWithMorgan',   description: 'Fitness journey, workout routines, and wellness content.' },
    { user: uAlex,   handle: 'alexriveracreates', display_name: 'Alex Rivera',    description: 'Creative vlogs, travel, and behind-the-scenes content.' },
    { user: uNova,   handle: 'techwithnova_tv',  display_name: 'TechWithNova',    description: 'AI, tools, and tech that actually matters in 2026.' },
  ];

  const channels = [];
  for (const co of channelOwners) {
    const existing = await prisma.channel.findUnique({ where: { user_id: co.user.user_id } });
    if (existing) { channels.push(existing); continue; }
    const ch = await prisma.channel.create({
      data: { user_id: co.user.user_id, handle: co.handle, display_name: co.display_name, description: co.description },
    });
    channels.push(ch);
  }

  const videosData = [
    // Riley (channels[0])
    { channel_id: channels[0].channel_id, title: 'Build a Full-Stack App in 2 Hours', description: 'We scaffold a complete Next.js + Prisma project from scratch.', video_type: 'long' },
    { channel_id: channels[0].channel_id, title: '10 VS Code Extensions Every Dev Needs', description: 'My curated list for maximum productivity.', video_type: 'long' },
    { channel_id: channels[0].channel_id, title: 'React Hooks Explained in 60 Seconds', description: 'Quick guide to useState, useEffect, and useRef.', video_type: 'shorts' },
    // Jordan (channels[1])
    { channel_id: channels[1].channel_id, title: 'Top 5 Jerk Chicken Spots in Toronto', description: 'We visited every spot so you don\'t have to.', video_type: 'long' },
    { channel_id: channels[1].channel_id, title: 'Making Suya at Home', description: 'Step-by-step West African street food at home.', video_type: 'long' },
    { channel_id: channels[1].channel_id, title: 'Best Street Food Bite Ever 🔥', description: 'You won\'t believe this spot.', video_type: 'shorts' },
    // Morgan (channels[2])
    { channel_id: channels[2].channel_id, title: '30-Day Transformation Results', description: 'What actually happens when you stay consistent.', video_type: 'long' },
    { channel_id: channels[2].channel_id, title: 'Morning Routine for Peak Energy', description: 'My 6am routine that changed everything.', video_type: 'long' },
    { channel_id: channels[2].channel_id, title: '5-Minute Ab Workout', description: 'No equipment needed.', video_type: 'shorts' },
    // Alex (channels[3])
    { channel_id: channels[3].channel_id, title: '48 Hours in Lisbon', description: 'The food, people, and hidden gems.', video_type: 'long' },
    { channel_id: channels[3].channel_id, title: 'My Creative Process', description: 'How I plan, shoot, and edit a video in a day.', video_type: 'long' },
    { channel_id: channels[3].channel_id, title: 'Lisbon Sunset Timelapse', description: 'Shot from Miradouro da Graça.', video_type: 'shorts' },
    // Nova (channels[4])
    { channel_id: channels[4].channel_id, title: 'AI Tools That Replaced My Entire Workflow', description: 'Honest review of tools I use daily.', video_type: 'long' },
    { channel_id: channels[4].channel_id, title: 'How I Built an App with Zero Code', description: 'No-code to prototype in 3 hours.', video_type: 'long' },
    { channel_id: channels[4].channel_id, title: 'ChatGPT Prompt That Blew My Mind', description: 'You need to try this.', video_type: 'shorts' },
  ];

  for (const v of videosData) {
    await prisma.video.create({
      data: {
        ...v,
        raw_video_url: PLACEHOLDER_URL,
        thumbnail_url: PLACEHOLDER_THUMB,
        status: 'safe',
        views_count: Math.floor(Math.random() * 50000) + 100,
        duration_sec: v.video_type === 'shorts' ? 58 : 720,
      },
    });
  }
  console.log('✓ Channels and videos seeded\n');
  } // end videosAlreadySeeded guard

  // ============================================================
  // STEP 5 — Product listings + variations
  // ============================================================

  console.log('Seeding product listings...');
  const productsData = [
    // Clothing
    { product_type_id: 1, name: 'Oversized Linen Blazer',    description: 'Premium linen in sand, slate, and cream.',           price: 129.99, vname: 'Sand / M',          image_url: PLACEHOLDER_THUMB },
    { product_type_id: 1, name: 'Ribbed Knit Maxi Dress',    description: 'Stretch ribbed knit, flattering silhouette.',         price: 89.99,  vname: 'Black / S',         image_url: PLACEHOLDER_THUMB },
    { product_type_id: 1, name: 'Wide-Leg Trousers',         description: 'High-waisted tailored fit.',                          price: 74.99,  vname: 'Charcoal / M',      image_url: PLACEHOLDER_THUMB },
    { product_type_id: 1, name: 'Retro Runner Sneakers',     description: 'Vintage-inspired low-top with chunky sole.',          price: 159.99, vname: 'White/Red / US10',  image_url: PLACEHOLDER_THUMB },
    { product_type_id: 1, name: 'Slip-On Canvas Shoe',       description: 'Lightweight canvas daily driver.',                    price: 49.99,  vname: 'Navy / US9',        image_url: PLACEHOLDER_THUMB },
    { product_type_id: 1, name: 'Cropped Denim Jacket',      description: 'Classic denim with a modern crop.',                   price: 99.99,  vname: 'Light Wash / M',    image_url: PLACEHOLDER_THUMB },
    // Electronics
    { product_type_id: 2, name: 'Wireless Charging Pad 15W', description: 'Universal Qi charging for all devices.',              price: 39.99,  vname: 'White',             image_url: PLACEHOLDER_THUMB },
    { product_type_id: 2, name: 'Noise-Cancelling Earbuds',  description: '40hr battery, active noise cancellation.',            price: 119.99, vname: 'Matte Black',       image_url: PLACEHOLDER_THUMB },
    { product_type_id: 2, name: 'Mechanical Keyboard TKL',   description: 'Tactile switches, RGB backlight.',                    price: 149.99, vname: 'Space Gray',        image_url: PLACEHOLDER_THUMB },
    // Home
    { product_type_id: 3, name: 'Rattan Pendant Light',      description: 'Handwoven rattan shade with brass fitting.',          price: 199.99, vname: 'Natural',           image_url: PLACEHOLDER_THUMB },
    { product_type_id: 3, name: 'Concrete Planter Set',      description: 'Set of 3, textured modern aesthetic.',                price: 59.99,  vname: 'Grey',              image_url: PLACEHOLDER_THUMB },
    { product_type_id: 3, name: 'Linen Throw Blanket',       description: 'Stonewashed 100% linen, 130×180cm.',                 price: 84.99,  vname: 'Terracotta',        image_url: PLACEHOLDER_THUMB },
    // Handmade
    { product_type_id: 5, name: 'Hand-Poured Soy Candle',    description: 'Cedar & sandalwood, 60hr burn time.',                 price: 28.99,  vname: 'Cedar & Sandalwood', image_url: PLACEHOLDER_THUMB },
    { product_type_id: 5, name: 'Macramé Wall Hanging',      description: 'Large hand-knotted cotton, 90cm wide.',               price: 64.99,  vname: 'Cream',             image_url: PLACEHOLDER_THUMB },
    { product_type_id: 5, name: 'Leather Card Wallet',       description: 'Slim full-grain leather, 4 card slots.',              price: 44.99,  vname: 'Cognac',            image_url: PLACEHOLDER_THUMB },
    { product_type_id: 1, name: 'High-Top Basketball Shoe',  description: 'Premium leather upper, cushioned sole.',              price: 189.99, vname: 'Black/Gold / US10', image_url: PLACEHOLDER_THUMB },
  ];

  for (const p of productsData) {
    const { price, vname, image_url, product_type_id, name, description } = p;
    const listing = await prisma.product_listing.create({
      data: { product_type_id, name, description, availability: 1 },
    });
    await prisma.product_variation.create({
      data: { listing_id: listing.listing_id, price, vname, image_url, product_type_id },
    });
  }
  console.log('✓ Product listings seeded\n');

  // ============================================================
  // STEP 6 — Food vendors + items
  // ============================================================

  console.log('Seeding food vendors...');
  const vendorsData = [
    { user: uAdaeze, vendor_name: "Adaeze's Kitchen",       cuisine_type: 'West African', location: '220 King St W, Toronto' },
    { user: uJordan, vendor_name: "Jordan's Jerk Shack",    cuisine_type: 'Caribbean',    location: '150 Ossington Ave, Toronto' },
    { user: uChef,   vendor_name: "Chef Lorenzo's Table",   cuisine_type: 'Italian',      location: '75 Front St E, Toronto' },
    { user: uGreen,  vendor_name: 'The Green Bowl',          cuisine_type: 'Vegan',        location: '430 Spadina Ave, Toronto' },
    { user: uSweet,  vendor_name: 'Sweet Dreams Bakery',    cuisine_type: 'Bakery',       location: '88 Queen St E, Toronto' },
  ];

  const menuItems = [
    // Adaeze's Kitchen
    [
      { name: 'Jollof Rice Bowl', description: 'Party jollof with fried plantain and coleslaw.', price: 18.99 },
      { name: 'Egusi Soup + Eba', description: 'Traditional ground melon seed soup served with eba.', price: 21.99 },
      { name: 'Puff Puff (6pcs)', description: 'Fried dough balls dusted with sugar.', price: 6.99 },
      { name: 'Pepper Soup', description: 'Spiced goat meat broth, West African style.', price: 16.99 },
      { name: 'Chin Chin Bag', description: 'Crunchy fried snack — sweet or spicy.', price: 5.99 },
    ],
    // Jordan's Jerk Shack
    [
      { name: 'Jerk Chicken Platter', description: 'Half chicken, festival, rice & peas.', price: 22.99 },
      { name: 'Oxtail Stew', description: 'Slow braised oxtail with butter beans.', price: 27.99 },
      { name: 'Roti Wrap', description: 'Curried chickpea or chicken in soft roti.', price: 13.99 },
      { name: 'Plantain Chips', description: 'Thinly sliced, lightly salted.', price: 4.99 },
      { name: 'Sorrel Drink', description: 'Traditional hibiscus and spice drink.', price: 3.99 },
    ],
    // Chef Lorenzo
    [
      { name: 'Cacio e Pepe', description: 'Fresh tonnarelli, pecorino, and black pepper.', price: 19.99 },
      { name: 'Osso Buco', description: 'Braised veal shank, gremolata, saffron risotto.', price: 34.99 },
      { name: 'Burrata Caprese', description: 'Creamy burrata, heirloom tomatoes, basil oil.', price: 16.99 },
      { name: 'Tiramisu', description: 'Classic house-made tiramisu.', price: 9.99 },
      { name: 'Margherita Pizza', description: 'San Marzano tomato, fior di latte, fresh basil.', price: 18.99 },
    ],
    // The Green Bowl
    [
      { name: 'Buddha Bowl', description: 'Quinoa, roasted chickpeas, tahini, seasonal veg.', price: 16.99 },
      { name: 'Green Goddess Wrap', description: 'Spinach tortilla, avocado, sprouts, herb dressing.', price: 13.99 },
      { name: 'Acai Bowl', description: 'Frozen acai, granola, fresh banana, coconut flakes.', price: 14.99 },
      { name: 'Lentil Soup', description: 'Red lentil with cumin and lemon.', price: 9.99 },
      { name: 'Energy Balls (3pcs)', description: 'Date, oat, and almond — no refined sugar.', price: 6.99 },
    ],
    // Sweet Dreams Bakery
    [
      { name: 'Croissant (Butter)', description: 'Laminated, flaky, freshly baked.', price: 4.50 },
      { name: 'Cinnamon Roll', description: 'Oversized pull-apart roll with cream cheese glaze.', price: 6.50 },
      { name: 'Banana Bread Loaf', description: 'Walnut and chocolate chip.', price: 12.99 },
      { name: 'Pain au Chocolat', description: 'Dark chocolate encased in butter pastry.', price: 5.50 },
      { name: 'Custom Celebration Cake', description: '6-inch layered cake — 72hr advance order.', price: 64.99 },
    ],
  ];

  for (let i = 0; i < vendorsData.length; i++) {
    const vd = vendorsData[i];
    const vendor = await prisma.food_vendor.create({
      data: {
        owner_id: vd.user.user_id,
        vendor_name: vd.vendor_name,
        cuisine_type: vd.cuisine_type,
        location: vd.location,
        is_open: true,
        is_active: true,
        min_order_value: 12,
        vendor_type_id: restaurantVendorTypeId,
      },
    });
    for (const item of menuItems[i]) {
      await prisma.food_item.create({
        data: {
          vendor_id: vendor.vendor_id,
          name: item.name,
          description: item.description,
          price: item.price,
          is_available: true,
          vendor_type_id: restaurantVendorTypeId,
        },
      });
    }
  }
  console.log('✓ Food vendors seeded\n');

  // ============================================================
  // STEP 7 — Meetup events
  // ============================================================

  console.log('Seeding meetup events...');
  const eventsData = [
    { organizer: uHost1, name: 'Toronto Tech Mixer 2026',        desc: 'Network with founders, developers, and investors shaping the local tech scene.', price: 0,    category_id: 1, location: '111 Richmond St W, Toronto',       start: new Date('2026-06-14T18:00:00Z') },
    { organizer: uHost1, name: 'Summer Rooftop Concert Series',  desc: 'Live music on the best rooftop in the city. Cocktails, views, and good vibes.', price: 25,   category_id: 1, location: '483 Bay St Rooftop, Toronto',         start: new Date('2026-07-05T20:00:00Z') },
    { organizer: uHost2, name: 'Makers & Artisans Market',       desc: 'Support local makers — ceramics, candles, jewelry, prints, and vintage finds.', price: 0,    category_id: 1, location: 'Distillery District, Toronto',         start: new Date('2026-06-21T10:00:00Z') },
    { organizer: uHost2, name: 'Photography Walk: Kensington',   desc: 'Guided neighbourhood photo walk with portfolio critique at the end.', price: 15,   category_id: 1, location: 'Kensington Market, Toronto',           start: new Date('2026-06-07T09:00:00Z') },
    { organizer: uHost3, name: 'Community Yoga in the Park',     desc: 'Free all-levels yoga session every Saturday morning. Bring your mat.', price: 0,    category_id: 1, location: 'Trinity Bellwoods Park, Toronto',      start: new Date('2026-06-07T08:00:00Z') },
    { organizer: uHost3, name: 'Startup Pitch Night',            desc: 'Five early-stage founders pitch their vision. Public vote decides the winner.', price: 10,   category_id: 1, location: 'MaRS Discovery District, Toronto',    start: new Date('2026-06-28T17:00:00Z') },
    { organizer: uHost1, name: 'African Food Festival TO',       desc: 'Two days of authentic cuisine, music, and cultural showcases from across Africa.', price: 20,   category_id: 1, location: 'Harbourfront Centre, Toronto',        start: new Date('2026-08-02T11:00:00Z') },
    { organizer: uHost2, name: 'Book Club: Summer Reading List', desc: 'Monthly meetup — July pick is "Tomorrow, and Tomorrow, and Tomorrow."', price: 0,    category_id: 1, location: 'TPL Reference Library, Toronto',       start: new Date('2026-07-19T14:00:00Z') },
  ];

  for (const e of eventsData) {
    await prisma.meetup_event.create({
      data: {
        meetup_event_organizer: e.organizer.user_id,
        meetup_event_name: e.name,
        meetup_event_description: e.desc,
        meetup_event_price: e.price,
        meetup_event_category_id: e.category_id,
        meetup_event_start_time: e.start,
        meetup_event_location: e.location,
      },
    });
  }
  console.log('✓ Meetup events seeded\n');

  // ============================================================
  // STEP 8 — Rental listings
  // ============================================================

  console.log('Seeding rental listings...');
  const rentalsData = [
    { owner: uHost1, name: 'Furnished Studio — King & Bathurst',  desc: 'Modern studio, full kitchen, all-inclusive. 30-day minimum.', amount: 1950, duration: 30, location: 'King & Bathurst, Toronto' },
    { owner: uHost1, name: '1-Bed in Leslieville',                desc: 'Sunny 1-bed apartment, hardwood floors, private patio.', amount: 2350, duration: 30, location: 'Leslieville, Toronto' },
    { owner: uHost2, name: 'Downtown 2-Bed Condo',                desc: 'High-floor condo, city views, gym access included.', amount: 3100, duration: 30, location: 'Downtown Core, Toronto' },
    { owner: uHost2, name: 'Cozy Midtown Basement Suite',         desc: 'Quiet, private basement suite with separate entrance.', amount: 1600, duration: 30, location: 'Midtown, Toronto' },
    { owner: uHost3, name: 'East End Loft',                       desc: 'Open-concept brick loft, exposed beams, natural light.', amount: 2750, duration: 30, location: 'East End, Toronto' },
    { owner: uHost3, name: 'Liberty Village Studio',              desc: 'Brand-new studio steps from shops and transit.', amount: 1850, duration: 30, location: 'Liberty Village, Toronto' },
  ];

  for (const r of rentalsData) {
    await prisma.rental_listing.create({
      data: {
        owner_id: r.owner.user_id,
        rental_listing_name: r.name,
        description: r.desc,
        amount: r.amount,
        duration: r.duration,
        location: r.location,
        is_available: true,
        rental_type_id: 1,
      },
    });
  }
  console.log('✓ Rental listings seeded\n');

  // ============================================================
  // STEP 9 — Properties
  // ============================================================

  console.log('Seeding properties...');
  const propertiesData = [
    { user: uHost1, address: '210 King St W #1201, Toronto, ON M5H 1K7', value: 895000,  type: 'Condo' },
    { user: uHost2, address: '88 Davenport Rd #503, Toronto, ON M5R 1H7', value: 1250000, type: 'Condo' },
    { user: uHost3, address: '334 Queen St E #202, Toronto, ON M5A 1S8', value: 749000,  type: 'Condo' },
    { user: uHost1, address: '45 Balliol St #1104, Toronto, ON M4S 1C2', value: 1100000, type: 'Condo' },
    { user: uHost2, address: '12 Strachan Ave #408, Toronto, ON M6K 1M3', value: 699000,  type: 'Condo' },
  ];

  for (const p of propertiesData) {
    await prisma.property.create({
      data: {
        user_id: p.user.user_id,
        estimated_value: p.value,
        type: p.type,
        address: p.address,
        image: PLACEHOLDER_THUMB,
      },
    });
  }
  console.log('✓ Properties seeded\n');

  // ============================================================
  // STEP 10 — Vehicles
  // ============================================================

  console.log('Seeding vehicles...');
  const vehiclesData = [
    { model: 'Toyota RAV4 Hybrid',   color: 'Pearl White',  year: 2023, max_passengers: 5, vehicle_type_id: 1 },
    { model: 'Honda Civic',           color: 'Sonic Grey',   year: 2024, max_passengers: 5, vehicle_type_id: 1 },
    { model: 'Tesla Model 3',         color: 'Midnight Black', year: 2023, max_passengers: 5, vehicle_type_id: 2 },
    { model: 'Ford F-150',            color: 'Velocity Blue', year: 2022, max_passengers: 5, vehicle_type_id: 1 },
    { model: 'BMW 330i',              color: 'Alpine White',  year: 2023, max_passengers: 5, vehicle_type_id: 3 },
    { model: 'Hyundai Tucson Hybrid', color: 'Phantom Black', year: 2024, max_passengers: 5, vehicle_type_id: 1 },
    { model: 'Mazda CX-5',           color: 'Soul Red',      year: 2022, max_passengers: 5, vehicle_type_id: 1 },
    { model: 'Kia EV6',              color: 'Runway Red',    year: 2023, max_passengers: 5, vehicle_type_id: 2 },
  ];

  for (const v of vehiclesData) {
    await prisma.vehicle.create({
      data: {
        model: v.model,
        color: v.color,
        year: v.year,
        max_passengers: v.max_passengers,
        vehicle_type_id: v.vehicle_type_id,
        vehicle_pic_url: PLACEHOLDER_THUMB,
      },
    });
  }
  console.log('✓ Vehicles seeded\n');

  // ============================================================
  // STEP 11 — Medical providers
  // ============================================================

  console.log('Seeding medical providers...');
  const medicsData = [
    { user: uMed1, company: 'Patel Family Clinic',        type: 'General Practice', spec: 'Family Medicine',         fee: 120, pic: PLACEHOLDER_THUMB, address: '200 Bay St, Toronto', lat: 43.6532, lng: -79.3832, insurance: 'OHIP, Self-pay' },
    { user: uMed2, company: 'Chen Dermatology',           type: 'Dermatology',      spec: 'Skin & Laser',            fee: 180, pic: PLACEHOLDER_THUMB, address: '100 Queen St W, Toronto', lat: 43.6526, lng: -79.3849, insurance: 'OHIP, Aetna' },
    { user: uMed3, company: 'Torres Physiotherapy',       type: 'Physiotherapy',    spec: 'Sports Rehabilitation',   fee: 95,  pic: PLACEHOLDER_THUMB, address: '220 King St W, Toronto', lat: 43.6472, lng: -79.3860, insurance: 'OHIP' },
    { user: uMed4, company: 'Al-Rashid Mental Health',    type: 'Psychiatry',       spec: 'Anxiety & Depression',    fee: 200, pic: PLACEHOLDER_THUMB, address: '250 Dundas St W, Toronto', lat: 43.6544, lng: -79.3890, insurance: 'OHIP, Blue Cross' },
    { user: uMed5, company: 'Williams Dental Care',       type: 'Dentistry',        spec: 'Cosmetic & General',      fee: 150, pic: PLACEHOLDER_THUMB, address: '1 Adelaide St E, Toronto', lat: 43.6505, lng: -79.3772, insurance: 'Self-pay' },
  ];

  for (const m of medicsData) {
    await prisma.appointment_service_providers.create({
      data: {
        service_provider_user_id: m.user.user_id,
        company_name: m.company,
        service_type: 'sd-doctors',
        specialization: m.spec,
        appointment_fee: m.fee,
        profile_picture: m.pic,
        company_address: m.address,
      },
    });
    const group_id = `med_user_${m.user.user_id}`;
    const shared = {
      type: 'medical',
      group_id,
      user_id: m.user.user_id,
      doctor_name: m.company,
      specialty: m.type,
      bio: `${m.spec} consultations on Strug.`,
      photo: m.pic,
      available: true,
      appointment_fee: m.fee,
      credentials: 'MD',
      verified: true,
      address: m.address,
      insurance: m.insurance,
      insurance_plans: String(m.insurance || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      work_hours_from: '09:00',
      work_hours_to: '17:00',
      work_days_from: 'Mon',
      work_days_to: 'Fri',
      latitude: m.lat,
      longitude: m.lng,
    };
    await prisma.booking_listing.create({
      data: {
        vertical: 'medical',
        owner_id: m.user.user_id,
        title: `${m.company} — Online Consultation`,
        description: `${m.type} online consultation`,
        price: m.fee,
        price_unit: 'session',
        currency: 'CAD',
        fulfillment: 'remote',
        instant_book: false,
        location: m.address,
        latitude: m.lat,
        longitude: m.lng,
        attributes: { ...shared, mode: 'online' },
        images: [],
      },
    });
    await prisma.booking_listing.create({
      data: {
        vertical: 'medical',
        owner_id: m.user.user_id,
        title: `${m.company} — In-Person Visit`,
        description: `${m.type} in-person visit`,
        price: 0,
        price_unit: 'session',
        currency: 'CAD',
        fulfillment: 'onsite',
        instant_book: false,
        location: m.address,
        latitude: m.lat,
        longitude: m.lng,
        attributes: { ...shared, mode: 'inperson' },
        images: [],
      },
    });
  }
  console.log('✓ Medical providers seeded\n');

  // ============================================================
  // STEP 12 — Places (venues)
  // ============================================================

  console.log('Seeding places...');
  const placesData = [
    { user: uHost1, address: 'The Spoke Club, 600 King St W, Toronto', lat: '43.6447', long: '-79.4082', price_per_hour: 450 },
    { user: uHost2, address: 'Steam Whistle Brewery, 255 Bremner Blvd, Toronto', lat: '43.6418', long: '-79.3844', price_per_hour: 350 },
    { user: uHost3, address: 'The Great Hall, 1087 Queen St W, Toronto', lat: '43.6428', long: '-79.4284', price_per_hour: 275 },
    { user: uHost1, address: 'Berkeley Church, 315 Queen St E, Toronto', lat: '43.6507', long: '-79.3618', price_per_hour: 400 },
    { user: uHost2, address: 'Arcadian Court, 401 Bay St, Toronto', lat: '43.6505', long: '-79.3839', price_per_hour: 600 },
  ];

  for (const p of placesData) {
    await prisma.place.create({
      data: {
        user_id: p.user.user_id,
        location_address: p.address,
        location_lat: p.lat,
        location_long: p.long,
        price_per_hour: p.price_per_hour,
      },
    });
  }
  console.log('✓ Places seeded\n');

  // ============================================================
  // STEP 13 — Calm providers + lessons
  // ============================================================

  console.log('Seeding calm providers and lessons...');

  const calmProviderUsers = [uHost1, uHost2, uHost3];
  const calmProviders = [];
  for (const u of calmProviderUsers) {
    const cp = await prisma.calm_providers.create({
      data: { provider_user_id: u.user_id, calm_provider_category_id: 1 },
    });
    calmProviders.push(cp);
  }

  const lessonsData = [
    { pIdx: 0, name: 'Morning Mindfulness Meditation', desc: '20-minute guided session to start your day with clarity.', duration: 20, price: 0 },
    { pIdx: 1, name: 'Sleep & Relaxation Body Scan',   desc: 'Guided body scan to release tension and prepare for deep sleep.', duration: 30, price: 0 },
    { pIdx: 2, name: 'Breathwork for Anxiety',         desc: 'Box breathing and 4-7-8 techniques to calm the nervous system.', duration: 15, price: 0 },
    { pIdx: 0, name: 'Gratitude Journaling Practice',  desc: 'Structured reflection session with guided prompts.', duration: 25, price: 0 },
    { pIdx: 1, name: 'Yoga Nidra: Deep Rest',          desc: 'Yogic sleep — the most restorative 45 minutes you\'ll have.', duration: 45, price: 0 },
    { pIdx: 2, name: 'Stress-Release Visualisation',   desc: 'Guided imagery to dissolve daily stress and recenter focus.', duration: 20, price: 0 },
  ];

  for (const l of lessonsData) {
    await prisma.calm_lesson.create({
      data: {
        calm_provider_id: calmProviders[l.pIdx].calm_provider_id,
        lesson_name: l.name,
        lesson_description: l.desc,
        lesson_duration: l.duration,
        lesson_price: l.price,
        lesson_trailer_video_url: PLACEHOLDER_URL,
      },
    });
  }
  console.log('✓ Calm providers and lessons seeded\n');

  // ============================================================
  // STEP 14 — live_streamer_profile + community posts
  // ============================================================

  console.log('Seeding live streamer profiles and community posts...');

  // Get or create a live stream category (category_id 1 likely exists; fall back to creating one)
  let liveCategoryId = 1;
  try {
    const anyCategory = await prisma.live_stream_category.findFirst();
    if (anyCategory) {
      liveCategoryId = anyCategory.category_id;
    } else {
      const created = await prisma.live_stream_category.create({ data: { category_name: 'General' } });
      liveCategoryId = created.category_id;
    }
  } catch {
    // live_stream_category table might not exist yet — skip community posts
    console.log('⚠️  live_stream_category table unavailable — skipping live streamer profiles & community posts\n');
    liveCategoryId = null;
  }

  const liveProfiles = {};

  if (liveCategoryId !== null) {
    const liveStreamUsers = [
      { user: uRiley,  handle: 'live_riley',  display_name: 'CodeWithRiley Live' },
      { user: uMorgan, handle: 'live_morgan', display_name: 'FitWithMorgan Live' },
      { user: uAlex,   handle: 'live_alex',   display_name: 'Alex Rivera Live' },
      { user: uNova,   handle: 'live_nova',   display_name: 'TechWithNova Live' },
      { user: uJordan, handle: 'live_jordan', display_name: 'Jordan Eats Live' },
    ];

    for (const lsu of liveStreamUsers) {
      try {
        const existing = await prisma.live_streamer_profile.findUnique({ where: { user_id: lsu.user.user_id } });
        if (existing) { liveProfiles[lsu.user.user_id] = existing; continue; }
        const lp = await prisma.live_streamer_profile.create({
          data: {
            user_id: lsu.user.user_id,
            category_id: liveCategoryId,
            handle: lsu.handle,
            display_name: lsu.display_name,
          },
        });
        liveProfiles[lsu.user.user_id] = lp;
      } catch (e) {
        console.log(`  ⚠️  Could not create live_streamer_profile for ${lsu.handle}: ${e.message}`);
      }
    }
  }

  const communityPostsData = [
    { uid: uRiley.user_id,  content: 'Just hit 1000 subscribers! Thank you all so much — more tutorials dropping every week 🙏' },
    { uid: uMorgan.user_id, content: 'New workout program launches Monday. Who\'s joining the 30-day challenge?' },
    { uid: uAlex.user_id,   content: 'Lisbon video is out! The food scene there blew my mind — link in bio.' },
    { uid: uNova.user_id,   content: 'Reviewing 3 new AI tools this week. Drop suggestions below — what do you want me to cover?' },
    { uid: uJordan.user_id, content: 'The Suya recipe video took 4 attempts to get right 😅 But it\'s perfect now. Worth it.' },
    { uid: uRiley.user_id,  content: 'Poll: What should I build next? A. Full-stack SaaS B. Chrome Extension C. Mobile App' },
    { uid: uMorgan.user_id, content: 'Rest day reminder: recovery is part of the process. You\'re not falling behind — you\'re recharging.' },
    { uid: uAlex.user_id,   content: 'Tokyo trip booked for September — the vlog series is going to be something special.' },
  ];

  for (const cp of communityPostsData) {
    const lp = liveProfiles[cp.uid];
    if (!lp) continue;
    await prisma.community_post.create({
      data: { streamer_id: lp.streamer_id, content: cp.content, is_poll: false },
    });
  }
  console.log('✓ Live streamer profiles and community posts seeded\n');

  // ============================================================
  // STEP 15 — Live streams (via streamer model)
  // ============================================================

  console.log('Seeding live streams...');

  const streamUsers = [
    { user: uRiley,  name: 'LIVE: Building a SaaS from Scratch',   desc: 'Full-stack build session — come code with me.',  url: PLACEHOLDER_URL },
    { user: uMorgan, name: 'LIVE: Morning Workout Session',         desc: 'Full-body HIIT — all fitness levels welcome.',   url: PLACEHOLDER_URL },
    { user: uAlex,   name: 'LIVE: Tokyo Trip Planning + Q&A',       desc: 'Planning the Japan vlog series live with chat.', url: PLACEHOLDER_URL },
  ];

  for (const su of streamUsers) {
    const existingStreamer = await prisma.streamer.findFirst({ where: { streamer_user_id: su.user.user_id } });
    const streamerRecord = existingStreamer ?? await prisma.streamer.create({ data: { streamer_user_id: su.user.user_id } });
    await prisma.stream.create({
      data: {
        streamer_id: streamerRecord.streamer_id,
        stream_name: su.name,
        description: su.desc,
        stream_url: su.url,
        start_time: new Date(),
        is_ended: false,
      },
    });
  }
  console.log('✓ Live streams seeded\n');

  // ============================================================
  // STEP 16 — Talent
  // ============================================================

  console.log('Seeding talent...');
  const talentsData = [
    { user: uTalent1, desc: 'Actress, model, and brand ambassador. Available for film, TV, and live events.', category_id: 1 },
    { user: uTalent2, desc: 'DJ and music producer with 10 years on the circuit. Corporate events, clubs, and weddings.', category_id: 1 },
    { user: uTalent3, desc: 'Keynote speaker and podcast host. Expert in personal development and entrepreneurship.', category_id: 1 },
    { user: uTalent4, desc: 'Award-winning visual artist. Available for live painting, murals, and art installations.', category_id: 1 },
    { user: uTalent5, desc: 'Jazz trio specialising in weddings, corporate events, and private dinners.', category_id: 1 },
  ];

  for (const t of talentsData) {
    await prisma.talent.create({
      data: {
        talent_user_id: t.user.user_id,
        talent_description: t.desc,
        profile_image_url: PLACEHOLDER_THUMB,
        talent_category_id: t.category_id,
      },
    });
  }
  console.log('✓ Talent seeded\n');

  // ============================================================
  // STEP 17 — Influencers
  // ============================================================

  console.log('Seeding influencers...');
  const influencersData = [
    { user: uInf1, desc: 'Fashion and lifestyle creator. 280K followers across platforms. Brand deals open.' },
    { user: uInf2, desc: 'DIY and home renovation content. Authentic product reviews and build-along series.' },
    { user: uInf3, desc: 'Food blogger and recipe developer. Restaurant collabs, cookware sponsorships welcome.' },
    { user: uInf4, desc: 'Beauty and skincare specialist. Honest reviews, tutorials, and brand partnerships.' },
  ];

  for (const inf of influencersData) {
    await prisma.influencer.create({
      data: {
        user_id: inf.user.user_id,
        influencer_description: inf.desc,
        influencer_image_url: PLACEHOLDER_THUMB,
      },
    });
  }
  console.log('✓ Influencers seeded\n');

  // ============================================================
  // STEP 18 — Town hall posts
  // ============================================================

  console.log('Seeding town hall posts...');
  const townHallData = [
    { user_id: uSofia.user_id,  content: 'Can we get more local events added to the platform? The community here is amazing 🙌' },
    { user_id: uMarcus.user_id, content: 'Suggestion: a "Hire a Developer" section would be really useful for small businesses on here.' },
    { user_id: uAdaeze.user_id, content: 'Food vendor onboarding was smooth! Props to the team. Would love a promo feature for daily specials.' },
    { user_id: uCoach.user_id,  content: 'The seller dashboards are super clean. One thing — can we get email notifications when a new order drops?' },
    { user_id: uZara.user_id,   content: 'I love this platform but finding products sometimes feels like a lot of scrolling. Better search filters please?' },
    { user_id: uPriya.user_id,  content: 'Is there a plan for a mobile app? The PWA experience is fine but a native app would be 🔥' },
    { user_id: uVince.user_id,  content: 'Would love to see a "new releases" music section. There are artists here who are seriously talented.' },
    { user_id: uNova.user_id,   content: 'Question for the team: are there plans for API access / developer tools for building on top of Strug?' },
  ];

  for (const t of townHallData) {
    await prisma.town_hall_post.create({ data: t });
  }
  console.log('✓ Town hall posts seeded\n');

  // ============================================================
  // OUTPUT CREDENTIALS
  // ============================================================

  const credentials = [
    { email: 'seed_sofia@strug.ca',    password: PASSWORD, name: 'Sofia del Mar',       role: 'Social poster' },
    { email: 'seed_marcus@strug.ca',   password: PASSWORD, name: 'Marcus Osei',          role: 'Social poster' },
    { email: 'seed_adaeze@strug.ca',   password: PASSWORD, name: 'Adaeze Eats',          role: 'Social poster + food vendor' },
    { email: 'seed_nova@strug.ca',     password: PASSWORD, name: 'TechWithNova',         role: 'Social poster + video creator' },
    { email: 'seed_coach@strug.ca',    password: PASSWORD, name: 'Coach Adebayo',        role: 'Social poster' },
    { email: 'seed_zara@strug.ca',     password: PASSWORD, name: 'Zara Vibe',            role: 'Social poster' },
    { email: 'seed_priya@strug.ca',    password: PASSWORD, name: 'Priya W.',             role: 'Social poster' },
    { email: 'seed_vince@strug.ca',    password: PASSWORD, name: 'Vince V.',             role: 'Social poster' },
    { email: 'seed_riley@strug.ca',    password: PASSWORD, name: 'CodeWithRiley',        role: 'Video creator + channel' },
    { email: 'seed_jordan@strug.ca',   password: PASSWORD, name: 'Jordan Eats',          role: 'Video creator + food vendor' },
    { email: 'seed_morgan@strug.ca',   password: PASSWORD, name: 'FitWithMorgan',        role: 'Video creator' },
    { email: 'seed_alex@strug.ca',     password: PASSWORD, name: 'Alex Rivera',          role: 'Video creator' },
    { email: 'seed_chef@strug.ca',     password: PASSWORD, name: 'Chef Lorenzo',         role: 'Food vendor' },
    { email: 'seed_green@strug.ca',    password: PASSWORD, name: 'The Green Bowl',       role: 'Food vendor' },
    { email: 'seed_sweet@strug.ca',    password: PASSWORD, name: 'Sweet Dreams Bakery',  role: 'Food vendor' },
    { email: 'seed_shop1@strug.ca',    password: PASSWORD, name: 'StyleHaus Shop',       role: 'Product seller (is_seller:true)' },
    { email: 'seed_shop2@strug.ca',    password: PASSWORD, name: 'TechGadgetsPro',       role: 'Product seller (is_seller:true)' },
    { email: 'seed_shop3@strug.ca',    password: PASSWORD, name: 'HomeDecor Hub',        role: 'Product seller (is_seller:true)' },
    { email: 'seed_shop4@strug.ca',    password: PASSWORD, name: 'FreshKicks Store',     role: 'Product seller (is_seller:true)' },
    { email: 'seed_shop5@strug.ca',    password: PASSWORD, name: 'Crafted Goods Co.',    role: 'Product seller (is_seller:true)' },
    { email: 'seed_host1@strug.ca',    password: PASSWORD, name: 'EventHive',            role: 'Event host' },
    { email: 'seed_host2@strug.ca',    password: PASSWORD, name: 'The Venue Lab',        role: 'Event host' },
    { email: 'seed_host3@strug.ca',    password: PASSWORD, name: 'Urban Spaces TO',      role: 'Event host' },
    { email: 'seed_med1@strug.ca',     password: PASSWORD, name: 'Dr. Amir Patel',       role: 'Medical provider' },
    { email: 'seed_med2@strug.ca',     password: PASSWORD, name: 'Dr. Nadia Chen',       role: 'Medical provider' },
    { email: 'seed_med3@strug.ca',     password: PASSWORD, name: 'Dr. Samuel Torres',    role: 'Medical provider' },
    { email: 'seed_med4@strug.ca',     password: PASSWORD, name: 'Dr. Fatima Al-Rashid', role: 'Medical provider' },
    { email: 'seed_med5@strug.ca',     password: PASSWORD, name: 'Dr. Leo Williams',     role: 'Medical provider' },
    { email: 'seed_talent1@strug.ca',  password: PASSWORD, name: 'Maya Starfield',       role: 'Talent / celebrity' },
    { email: 'seed_talent2@strug.ca',  password: PASSWORD, name: 'DJ Kontrol',           role: 'Talent / celebrity' },
    { email: 'seed_talent3@strug.ca',  password: PASSWORD, name: 'Nia Speaks',           role: 'Talent / celebrity' },
    { email: 'seed_talent4@strug.ca',  password: PASSWORD, name: 'Visual by Victor',     role: 'Talent / celebrity' },
    { email: 'seed_talent5@strug.ca',  password: PASSWORD, name: 'The Wedding Trio',     role: 'Talent / celebrity' },
    { email: 'seed_inf1@strug.ca',     password: PASSWORD, name: 'Lena Luxe',            role: 'Influencer' },
    { email: 'seed_inf2@strug.ca',     password: PASSWORD, name: 'BuildWithBen',         role: 'Influencer' },
    { email: 'seed_inf3@strug.ca',     password: PASSWORD, name: 'FoodieByFaith',        role: 'Influencer' },
    { email: 'seed_inf4@strug.ca',     password: PASSWORD, name: 'GlowUpGrace',          role: 'Influencer' },
  ];

  console.log('\n=== SEED ACCOUNTS (all passwords: Strug2026!) ===\n');
  const colW = Math.max(...credentials.map(c => c.email.length)) + 2;
  for (const c of credentials) {
    console.log(`${c.email.padEnd(colW)} — ${c.name.padEnd(24)} (${c.role})`);
  }
  console.log('\n');

  writeFileSync(
    join(__dirname, 'seed-credentials.json'),
    JSON.stringify(credentials, null, 2)
  );
  console.log(`✅ Credentials written to scripts/seed-credentials.json\n`);
  console.log('🌱 Seed complete!\n');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
