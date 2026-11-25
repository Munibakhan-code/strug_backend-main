// Seed real, bookable rows for the verticals that were rerouted onto the booking
// engine (Influencer, Artist Corner, Wedding) plus Raise crowdfunding campaigns.
//
// Why: those pages used to charge a card and then write the WRONG / a non-existent
// record. They now load real `booking_listing` rows (Influencer/Artwork/Wedding)
// and real `projects` rows (Raise) and route the charge through the booking engine
// / donation flow. Without these rows the grids are empty and nothing is buyable.
//
// Idempotent: re-running skips rows that already exist (matched by vertical+title+owner,
// or project title). Listings are owned by a platform/seed user so a buyer is never
// booking their own listing (the engine forbids that).
//
// Usage:
//   node scripts/seed-money-safety-listings.js
//   SEED_OWNER_USER_ID=42 node scripts/seed-money-safety-listings.js   # explicit owner
//
// Run against staging (main DB) and prod the same way the team applies migrations.

import prisma from '../utils/prisma-client.js';

const PRICE_UNIT = 'event'; // dated wedding bookings (one unit per day)

// Global sample markets (aligned with seed-wedding-vendors.js). Stored charge
// currency remains the platform baseline (CAD); guest UI converts via regionConfig.
const WEDDING_VENDORS = [
  { name: 'The Grand Orangery', type: 'Venue', max_attendees: 200, price: 8500, rating: 4.97, reviews: 143, location: 'London, United Kingdom', thumb: 'linear-gradient(135deg,#1e1b4b,#7c3aed,#c4b5fd)' },
  { name: 'Bella Floral Studio', type: 'Florist', max_attendees: null, price: 2200, rating: 4.95, reviews: 312, location: 'Paris, France', thumb: 'linear-gradient(135deg,#052e16,#16a34a,#bbf7d0)' },
  { name: 'Luminary Films', type: 'Videography', max_attendees: null, price: 3500, rating: 4.98, reviews: 87, location: 'Los Angeles, United States', thumb: 'linear-gradient(135deg,#0c1a2e,#2563eb)' },
  { name: 'Villa Soleil', type: 'Venue', max_attendees: 120, price: 6200, rating: 4.93, reviews: 209, location: 'Tuscany, Italy', thumb: 'linear-gradient(135deg,#451a03,#f59e0b,#fde68a)' },
  { name: 'Chef Marco & Co.', type: 'Catering', max_attendees: 300, price: 4800, rating: 4.91, reviews: 184, location: 'New York, United States', thumb: 'linear-gradient(135deg,#1c1917,#ef4444)' },
  { name: 'Grace & Lens', type: 'Photography', max_attendees: null, price: 2900, rating: 4.99, reviews: 421, location: 'Sydney, Australia', thumb: 'linear-gradient(135deg,#0f172a,#06b6d4)' },
  { name: 'Luxe Tent & Drape Co.', type: 'Rental', max_attendees: null, price: 1800, rating: 4.92, reviews: 178, location: 'Dubai, United Arab Emirates', thumb: 'linear-gradient(135deg,#1e293b,#334155,#94a3b8)' },
  { name: 'Golden Hour Rentals', type: 'Rental', max_attendees: null, price: 950, rating: 4.88, reviews: 93, location: 'Singapore', thumb: 'linear-gradient(135deg,#451a03,#92400e,#fbbf24)' },
];

const ARTWORKS = [
  { title: 'Neon Drift', artist: 'Kenji Mori', medium: 'Digital', price: 180, thumb: 'linear-gradient(135deg,#0d1b35,#2563eb,#7c3aed)' },
  { title: 'Harmattan', artist: 'Adaeze Chukwu', medium: 'Oil', price: 420, thumb: 'linear-gradient(135deg,#451a03,#f59e0b,#fef3c7)' },
  { title: 'Silence IV', artist: 'Leila Nazari', medium: 'Watercolor', price: 95, thumb: 'linear-gradient(135deg,#0f172a,#06b6d4,#e0f2fe)' },
  { title: 'Grid Memory', artist: 'Sam Delacroix', medium: 'Digital', price: 220, thumb: 'linear-gradient(135deg,#1a1a2e,#e50914,#ff6b6b)' },
  { title: 'Sacred Geometry', artist: 'Amara Diallo', medium: 'Mixed', price: 340, thumb: 'linear-gradient(135deg,#052e16,#16a34a,#bbf7d0)' },
  { title: 'Urban Fracture', artist: 'Leo Park', medium: 'Photography', price: 75, thumb: 'linear-gradient(135deg,#1c1917,#78716c,#d4d4d8)' },
  { title: 'Bloom Protocol', artist: 'Iris Voss', medium: 'Digital', price: 150, thumb: 'linear-gradient(135deg,#4a044e,#ec4899,#fce7f3)' },
  { title: 'Threshold', artist: 'Omar Bakr', medium: 'Oil', price: 550, thumb: 'linear-gradient(135deg,#172554,#3b82f6,#bfdbfe)' },
];

const INFLUENCERS = [
  {
    name: 'Maya Reyes', niche: 'Lifestyle', followers: '480K', engRate: '4.2%', avgViews: '120K',
    bio: 'Lifestyle & travel creator partnering with mindful brands.', platforms: ['Instagram', 'TikTok'], pastWork: ['Aesop', 'Away'],
    thumb: 'linear-gradient(135deg,#ec4899,#7c3aed)',
    packages: [
      { name: 'Story Mention', desc: '3-frame story with link sticker', price: 350 },
      { name: 'In-Feed Reel', desc: '30s reel + 24h story', price: 1200 },
      { name: 'Full Campaign', desc: '3 reels + 5 stories over 2 weeks', price: 3800 },
    ],
  },
  {
    name: 'Dev Kapoor', niche: 'Tech', followers: '910K', engRate: '3.6%', avgViews: '300K',
    bio: 'Consumer tech reviews and honest unboxings.', platforms: ['YouTube', 'Instagram'], pastWork: ['Samsung', 'Anker'],
    thumb: 'linear-gradient(135deg,#06b6d4,#2563eb)',
    packages: [
      { name: 'Shoutout', desc: 'Dedicated 60s segment in a video', price: 900 },
      { name: 'Dedicated Review', desc: 'Full standalone review video', price: 4500 },
    ],
  },
  {
    name: 'Sofia Marchetti', niche: 'Fashion', followers: '1.3M', engRate: '5.1%', avgViews: '500K',
    bio: 'Editorial fashion and styling for emerging labels.', platforms: ['Instagram'], pastWork: ['Mango', 'Sézane'],
    thumb: 'linear-gradient(135deg,#a855f7,#db2777)',
    packages: [
      { name: 'Story Set', desc: '5 styled stories', price: 800 },
      { name: 'Grid Post', desc: 'Editorial carousel post', price: 2200 },
      { name: 'Lookbook Collab', desc: 'Co-created lookbook + 3 posts', price: 6500 },
    ],
  },
  {
    name: 'Tunde Bello', niche: 'Fitness', followers: '620K', engRate: '6.0%', avgViews: '210K',
    bio: 'Strength & mobility coach, supplement and gear partnerships.', platforms: ['TikTok', 'YouTube'], pastWork: ['Gymshark', 'MyProtein'],
    thumb: 'linear-gradient(135deg,#16a34a,#059669)',
    packages: [
      { name: 'Story Promo', desc: '3 stories with discount code', price: 400 },
      { name: 'Workout Integration', desc: 'Product woven into a full workout video', price: 1500 },
    ],
  },
];

// Professional services — scheduled single sessions (price_unit 'session'); the
// buyer picks a date/time and is charged the flat per-session price.
const PROFESSIONAL_SERVICES = [
  { title: 'Home Deep Clean',        category: 'Cleaning',     unit: 'per visit',   price: 85, rating: 4.9, reviews: 1203, provider: 'SparkleTeam',  location: 'Toronto, ON',  thumb: 'linear-gradient(135deg,#0c1a2e,#2563eb)' },
  { title: 'TV Mounting & Setup',    category: 'Handyman',     unit: 'per job',     price: 60, rating: 4.8, reviews: 876,  provider: 'FixItFast',    location: 'Toronto, ON',  thumb: 'linear-gradient(135deg,#1c1917,#ef4444)' },
  { title: 'Personal Training (1hr)',category: 'Fitness',      unit: 'per session', price: 70, rating: 4.9, reviews: 541,  provider: 'EliteCoach',   location: 'Mississauga, ON', thumb: 'linear-gradient(135deg,#052e16,#16a34a)' },
  { title: 'Dog Walking (60 min)',   category: 'Pet Care',     unit: 'per walk',    price: 30, rating: 4.7, reviews: 2104, provider: 'PawPals',      location: 'Toronto, ON',  thumb: 'linear-gradient(135deg,#451a03,#f59e0b)' },
  { title: 'Furniture Assembly',     category: 'Handyman',     unit: 'per job',     price: 55, rating: 4.8, reviews: 689,  provider: 'BuildRight',   location: 'Brampton, ON', thumb: 'linear-gradient(135deg,#1e1b4b,#7c3aed)' },
  { title: 'Garden Tidy & Mow',      category: 'Gardening',    unit: 'per visit',   price: 65, rating: 4.6, reviews: 412,  provider: 'GreenScene',   location: 'Oakville, ON', thumb: 'linear-gradient(135deg,#052e16,#16a34a,#86efac)' },
  { title: 'Grocery Run & Delivery', category: 'Errands',      unit: 'per trip',    price: 20, rating: 4.8, reviews: 3401, provider: 'QuickRunners', location: 'Toronto, ON',  thumb: 'linear-gradient(135deg,#0f172a,#06b6d4)' },
  { title: 'Laptop Repair & Tune-up',category: 'Tech Support', unit: 'per job',     price: 90, rating: 4.9, reviews: 234,  provider: 'TechFixPro',   location: 'Toronto, ON',  thumb: 'linear-gradient(135deg,#1c1917,#78716c)' },
];

// Décor — one 'decor' vertical, attributes.type distinguishes the sub-mode.
// services/seasonal = flat session price; rental = per-day date range.
const DECOR_SERVICES = [
  { title: 'Full Home Interior Styling', category: 'Interior',    price: 450, unit: 'project', rating: 4.9, reviews: 86,  provider: 'StudioNord',  tags: ['Consultation', 'Styling'], gradient: 'linear-gradient(135deg,#1a1028,#0e0918)' },
  { title: 'Event Décor & Setup',        category: 'Event Décor', price: 800, unit: 'event',   rating: 4.8, reviews: 142, provider: 'LushEvents',  tags: ['On-site', 'Teardown'],     gradient: 'linear-gradient(135deg,#2a0a1a,#1c0610)' },
  { title: 'Lighting Design',            category: 'Lighting',    price: 220, unit: 'room',    rating: 4.7, reviews: 53,  provider: 'GlowLab',     tags: ['Ambient', 'Smart'],        gradient: 'linear-gradient(135deg,#2a1e0a,#1c1406)' },
  { title: 'Wall Art Curation',          category: 'Wall Art',    price: 180, unit: 'wall',    rating: 4.9, reviews: 71,  provider: 'FrameWorks',  tags: ['Curation', 'Hanging'],     gradient: 'linear-gradient(135deg,#0d2a1a,#06180c)' },
];

const DECOR_RENTALS = [
  { title: 'Velvet Lounge Sofa',   category: 'Furniture', perDay: 45, deposit: 100, gradient: 'linear-gradient(135deg,#1e1b4b,#7c3aed)' },
  { title: 'Crystal Chandelier',   category: 'Lighting',  perDay: 35, deposit: 150, gradient: 'linear-gradient(135deg,#2a1e0a,#1c1406)' },
  { title: 'Gold Arch Backdrop',   category: 'Furniture', perDay: 60, deposit: 120, gradient: 'linear-gradient(135deg,#3a2a0a,#241a06)' },
  { title: 'Persian Area Rug',     category: 'Rugs',      perDay: 25, deposit: 80,  gradient: 'linear-gradient(135deg,#2a0a0a,#1c0606)' },
  { title: 'Abstract Canvas Set',  category: 'Wall Art',  perDay: 20, deposit: 60,  gradient: 'linear-gradient(135deg,#1a0a2a,#100618)' },
];

const DECOR_SEASONAL = [
  { season: 'Christmas', name: 'Classic Cozy Christmas', price: 299, accent: '#dc2626', thumb: 'linear-gradient(135deg, #2a0a0a, #1c0606)', items: ['7ft Pre-lit Tree', 'Garland Set (3pc)', 'Wreath (24in)', '50 Ornaments', 'Tree Topper', 'Table Runner'] },
  { season: 'Christmas', name: 'Winter Wonderland',      price: 449, accent: '#2563eb', thumb: 'linear-gradient(135deg, #0a1a2a, #06101c)', items: ['8ft Flocked Tree', 'Snowflake Ornaments (60pc)', 'Fairy Light Set (400 LED)', 'Faux Snow Blanket', 'Ice Crystal Wreath', 'Icicle Garland (10ft)'] },
  { season: 'Halloween', name: 'Haunted House Pro',      price: 299, accent: '#7c3aed', thumb: 'linear-gradient(135deg, #1a0a2a, #100618)', items: ['Giant Skeleton 12ft', 'Tombstone Set (6pc)', 'Strobe Light', 'Sound Effects Speaker', 'Bat Garland', 'Black Muslin Draping'] },
  { season: 'Easter',    name: 'Spring Garden',          price: 129, accent: '#ec4899', thumb: 'linear-gradient(135deg, #2a0a1a, #1c0610)', items: ['Giant Egg Display (12pc)', 'Pastel Wreath', 'Bunny Topiaries (2pc)', 'Easter Basket Set', 'Floral Garland'] },
  { season: 'Diwali',    name: 'Festival of Lights',     price: 179, accent: '#f59e0b', thumb: 'linear-gradient(135deg, #2a1e0a, #1c1406)', items: ['Diya Set (20pc)', 'Rangoli Kit', 'Lantern Garland (10ft)', 'Marigold Garland (15ft)', 'LED Diyas (12pc)'] },
];

// Medical — each doctor becomes two 'medical' listings: an online consultation
// (priced) and an in-person visit (free / $0). Grouped on the FE by group_id.
const MEDICAL_PROVIDERS = [
  { name: 'Dr. Sarah Chen',   specialty: 'General Practice', price: 60,  rating: 4.9, reviews: 312, bio: 'Board-certified GP focused on preventive care and family medicine.',        photo: 'linear-gradient(135deg,#0d1b35,#2563eb)', credentials: 'MD, CCFP', insurance: 'OHIP, Self-pay', address: '200 Bay St, Toronto', lat: 43.6532, lng: -79.3832 },
  { name: 'Dr. Amara Okafor', specialty: 'Dermatology',      price: 95,  rating: 4.8, reviews: 188, bio: 'Dermatologist specialising in skin health, acne, and cosmetic concerns.',     photo: 'linear-gradient(135deg,#2a0a1a,#db2777)', credentials: 'MD, FRCPC', insurance: 'OHIP, Aetna', address: '100 Queen St W, Toronto', lat: 43.6526, lng: -79.3849 },
  { name: 'Dr. Liam Walsh',   specialty: 'Cardiology',       price: 140, rating: 4.9, reviews: 96,  bio: 'Cardiologist with 15 years treating heart conditions and hypertension.',       photo: 'linear-gradient(135deg,#2a0a0a,#dc2626)', credentials: 'MD, FRCPC', insurance: 'OHIP', address: '500 University Ave, Toronto', lat: 43.6561, lng: -79.3900 },
  { name: 'Dr. Priya Nair',   specialty: 'Psychiatry',       price: 110, rating: 4.9, reviews: 241, bio: 'Psychiatrist offering compassionate mental health and therapy support.',        photo: 'linear-gradient(135deg,#1a0a2a,#7c3aed)', credentials: 'MD, FRCPC', insurance: 'OHIP, Blue Cross', address: '250 Dundas St W, Toronto', lat: 43.6544, lng: -79.3890 },
  { name: 'Dr. Marcus Lee',   specialty: 'Pediatrics',       price: 70,  rating: 4.8, reviews: 174, bio: 'Pediatrician caring for newborns through adolescents.',                        photo: 'linear-gradient(135deg,#0a1a2a,#0891b2)', credentials: 'MD, FAAP', insurance: 'OHIP', address: '555 University Ave, Toronto', lat: 43.6572, lng: -79.3886 },
  { name: 'Dr. Elena Rossi',  specialty: 'Orthopedics',      price: 120, rating: 4.7, reviews: 132, bio: 'Orthopedic specialist for joints, sports injuries, and mobility.',              photo: 'linear-gradient(135deg,#2a1e0a,#d97706)', credentials: 'MD, FRCSC', insurance: 'OHIP, Self-pay', address: '399 Bathurst St, Toronto', lat: 43.6534, lng: -79.4057 },
];

const RAISE_CAMPAIGNS = [
  { title: 'Solara — Solar Lanterns for Off-Grid Communities', goal: 25000, raised: 19400, daysLeft: 14, description: 'Power the world one lantern at a time.' },
  { title: 'Roots: A Graphic Novel About Diaspora Identity', goal: 8000, raised: 11250, daysLeft: 30, description: 'Stories that cross borders.' },
  { title: 'Help Rebuild the Nakuru Youth Music Centre', goal: 15000, raised: 6820, daysLeft: 22, description: 'Music changes lives. Help us rebuild.' },
  { title: 'BrewBot — Home Brewing Automation Device', goal: 40000, raised: 38100, daysLeft: 6, description: 'Craft beer, perfectly automated.' },
  { title: 'Medical Fund for Maya Rodriguez', goal: 30000, raised: 22500, daysLeft: 45, description: 'Help Maya get the treatment she needs.' },
  { title: 'Aurelia — Minimal Mechanical Keyboard', goal: 60000, raised: 71200, daysLeft: 9, description: 'Type beautifully.' },
];

async function resolveOwner() {
  if (process.env.SEED_OWNER_USER_ID) return Number(process.env.SEED_OWNER_USER_ID);
  const u = await prisma.user.findFirst({ orderBy: { user_id: 'asc' }, select: { user_id: true } });
  if (!u) throw new Error('No users found — set SEED_OWNER_USER_ID to a platform/admin user id.');
  return u.user_id;
}

async function ensureListing(data) {
  const existing = await prisma.booking_listing.findFirst({
    where: { vertical: data.vertical, title: data.title, owner_id: data.owner_id },
  });
  if (existing) return { created: false };
  await prisma.booking_listing.create({ data });
  return { created: true };
}

async function main() {
  const owner_id = await resolveOwner();
  console.log(`Seeding with owner_id=${owner_id}`);
  let created = 0, skipped = 0;
  const tally = (r) => { r.created ? created++ : skipped++; };

  // Wedding vendors — capacity is always 1 (one bookable unit); people live in max_attendees.
  for (const v of WEDDING_VENDORS) {
    const attrs = {
      vendor_type: v.type,
      thumb: v.thumb,
    };
    if (v.max_attendees != null) attrs.max_attendees = v.max_attendees;
    tally(await ensureListing({
      vertical: 'wedding', owner_id, title: v.name, description: `${v.type} for weddings`,
      location: v.location, price: v.price, price_unit: PRICE_UNIT, currency: 'CAD',
      capacity: 1, fulfillment: 'onsite',
      attributes: attrs, images: [],
    }));
  }

  // Artworks
  for (const a of ARTWORKS) {
    tally(await ensureListing({
      vertical: 'artwork', owner_id, title: a.title, description: `${a.medium} artwork by ${a.artist}`,
      price: a.price, price_unit: PRICE_UNIT, currency: 'CAD', capacity: 1, fulfillment: 'pickup_delivery',
      attributes: { artist: a.artist, medium: a.medium, thumb: a.thumb }, images: [],
    }));
  }

  // Influencers — one listing per package, grouped via attributes.group_id
  for (const inf of INFLUENCERS) {
    const group_id = `inf_${inf.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    for (const pkg of inf.packages) {
      tally(await ensureListing({
        vertical: 'influencer', owner_id, title: `${inf.name} — ${pkg.name}`, description: pkg.desc,
        price: pkg.price, price_unit: PRICE_UNIT, currency: 'CAD', fulfillment: 'remote',
        attributes: {
          group_id, influencer_name: inf.name, niche: inf.niche, followers: inf.followers,
          eng_rate: inf.engRate, avg_views: inf.avgViews, bio: inf.bio, platforms: inf.platforms,
          past_work: inf.pastWork, package_name: pkg.name, package_desc: pkg.desc, thumb: inf.thumb,
        }, images: [],
      }));
    }
  }

  // Professional services — one `session` listing each (scheduled date/time, flat price)
  for (const s of PROFESSIONAL_SERVICES) {
    tally(await ensureListing({
      vertical: 'professional', owner_id, title: s.title, description: `${s.title} — ${s.category} service by ${s.provider}`,
      location: s.location, price: s.price, price_unit: 'session', currency: 'CAD', fulfillment: 'onsite',
      attributes: { category: s.category, provider: s.provider, unit: s.unit, rating: s.rating, reviews: s.reviews, thumb: s.thumb }, images: [],
    }));
  }

  // Décor — services (session), rentals (per-day), seasonal packages (session)
  for (const s of DECOR_SERVICES) {
    tally(await ensureListing({
      vertical: 'decor', owner_id, title: s.title, description: `${s.category} décor service by ${s.provider}`,
      price: s.price, price_unit: 'session', currency: 'CAD', fulfillment: 'onsite',
      attributes: { type: 'services', category: s.category, provider: s.provider, unit: s.unit, rating: s.rating, reviews: s.reviews, tags: s.tags, gradient: s.gradient }, images: [],
    }));
  }
  for (const r of DECOR_RENTALS) {
    tally(await ensureListing({
      vertical: 'decor', owner_id, title: r.title, description: `${r.category} décor rental`,
      price: r.perDay, price_unit: 'day', currency: 'CAD', fulfillment: 'pickup_delivery',
      requires_deposit: true, deposit_amount: r.deposit,
      attributes: { type: 'rental', category: r.category, deposit: r.deposit, thumb: r.gradient, available: true }, images: [],
    }));
  }
  for (const p of DECOR_SEASONAL) {
    tally(await ensureListing({
      vertical: 'decor', owner_id, title: p.name, description: `${p.season} seasonal décor package`,
      price: p.price, price_unit: 'session', currency: 'CAD', fulfillment: 'pickup_delivery',
      attributes: { type: 'seasonal', season: p.season, items: p.items, accent: p.accent, thumb: p.thumb }, images: [],
    }));
  }

  // Medical — two listings per doctor (online priced, in-person $0)
  for (const d of MEDICAL_PROVIDERS) {
    const group_id = `med_${d.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    // Do not set user_id to the shared seed owner — that routed every
    // "Message Doctor" DM to one account. Chat appears once real providers list.
    const shared = {
      type: 'medical', group_id, doctor_name: d.name, specialty: d.specialty, bio: d.bio, photo: d.photo, available: true,
      credentials: d.credentials, verified: true, rating: d.rating, reviews: d.reviews,
      insurance: d.insurance, insurance_plans: String(d.insurance || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      address: d.address, latitude: d.lat, longitude: d.lng,
    };
    tally(await ensureListing({
      vertical: 'medical', owner_id, title: `${d.name} — Online Consultation`, description: `${d.specialty} online consultation`,
      location: d.address, latitude: d.lat, longitude: d.lng,
      price: d.price, price_unit: 'session', currency: 'CAD', fulfillment: 'remote',
      instant_book: false,
      attributes: { ...shared, mode: 'online' }, images: [],
    }));
    tally(await ensureListing({
      vertical: 'medical', owner_id, title: `${d.name} — In-Person Visit`, description: `${d.specialty} in-person visit`,
      location: d.address, latitude: d.lat, longitude: d.lng,
      price: 0, price_unit: 'session', currency: 'CAD', fulfillment: 'onsite',
      instant_book: false,
      attributes: { ...shared, mode: 'inperson' }, images: [],
    }));
  }

  // Raise campaigns (real `projects` rows so donations satisfy the FK)
  for (const c of RAISE_CAMPAIGNS) {
    const existing = await prisma.projects.findFirst({ where: { title: c.title } });
    if (existing) { skipped++; continue; }
    await prisma.projects.create({
      data: {
        project_name: c.title, title: c.title, description: c.description, owner_user_id: owner_id,
        expected_amount: c.goal, current_amount: c.raised, posted_date: new Date(),
        deadline: new Date(Date.now() + c.daysLeft * 86400000),
      },
    });
    created++;
  }

  console.log(`Done. Created ${created}, skipped ${skipped} (already existed).`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
