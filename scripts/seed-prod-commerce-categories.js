// scripts/seed-prod-commerce-categories.js
//
// One-off, idempotent seed to give the category-isolated commerce verticals real
// inventory under the canonical category names the filters require:
//   product_type   -> 'Decor', 'Wedding'        (Decor.jsx / Wedding.jsx)
//   dg_categories  -> 'Books', 'DigitalProducts' (Books.jsx / DigitalProducts.jsx)
//
// It copies the existing staging rows into the target DB so prod matches staging.
// Safe to re-run: every insert is guarded by an existence check on a natural key
// (product_type/dg_category name, listing name, content_title).
//
// Usage:
//   SRC_DATABASE_URL='<staging url>' DST_DATABASE_URL='<prod url>' \
//     node scripts/seed-prod-commerce-categories.js
//   add DRY_RUN=1 to print what WOULD happen without writing.

import pg from 'pg';

const { Pool } = pg;
const DRY = process.env.DRY_RUN === '1';
const SRC = process.env.SRC_DATABASE_URL;
const DST = process.env.DST_DATABASE_URL;
if (!SRC || !DST) {
  console.error('Set SRC_DATABASE_URL (staging) and DST_DATABASE_URL (target).');
  process.exit(1);
}

const src = new Pool({ connectionString: SRC });
const dst = new Pool({ connectionString: DST });

const PRODUCT_TYPES = ['Decor', 'Wedding'];
const DG_CATEGORIES = ['Books', 'DigitalProducts'];
// Owner for seeded listings — must exist in the target DB (user_id 1 = Test User).
const FALLBACK_SELLER_ID = 1;

// Some tables were seeded with explicit ids, leaving their identity sequence
// behind max(id) — so a default-valued INSERT collides. Resync before inserting.
async function fixSequence(table, idCol) {
  if (DRY) return;
  await dst.query(
    `SELECT setval(pg_get_serial_sequence($1, $2),
                   GREATEST((SELECT COALESCE(MAX(${idCol}), 0) FROM ${table}), 1))`,
    [table, idCol]);
}

async function ensureProductType(name) {
  const found = await dst.query(
    'SELECT product_type_id FROM product_type WHERE product_type_name = $1 LIMIT 1', [name]);
  if (found.rows.length) return found.rows[0].product_type_id;
  if (DRY) { console.log(`  [dry] would create product_type '${name}'`); return -1; }
  const ins = await dst.query(
    'INSERT INTO product_type (product_type_name) VALUES ($1) RETURNING product_type_id', [name]);
  console.log(`  + product_type '${name}' = ${ins.rows[0].product_type_id}`);
  return ins.rows[0].product_type_id;
}

async function ensureDgCategory(name) {
  const found = await dst.query(
    'SELECT dg_category_id FROM dg_categories WHERE dg_category_name = $1 LIMIT 1', [name]);
  if (found.rows.length) return found.rows[0].dg_category_id;
  if (DRY) { console.log(`  [dry] would create dg_category '${name}'`); return -1; }
  const ins = await dst.query(
    'INSERT INTO dg_categories (dg_category_name) VALUES ($1) RETURNING dg_category_id', [name]);
  console.log(`  + dg_category '${name}' = ${ins.rows[0].dg_category_id}`);
  return ins.rows[0].dg_category_id;
}

async function sellerExists(id) {
  if (id == null) return false;
  const r = await dst.query('SELECT 1 FROM "user" WHERE user_id = $1', [id]);
  return r.rows.length > 0;
}

async function seedListings(typeName, dstTypeId) {
  const rows = (await src.query(
    `SELECT pl.name, pl.description, pl.availability, pl.image_url, pl.seller_id,
            pv.price, pv.description AS v_desc, pv.vname, pv.image_url AS v_image
       FROM product_listing pl
       JOIN product_type pt USING (product_type_id)
       LEFT JOIN product_variation pv USING (listing_id)
      WHERE pt.product_type_name = $1`, [typeName])).rows;

  for (const r of rows) {
    const exists = await dst.query(
      'SELECT listing_id FROM product_listing WHERE name = $1 AND product_type_id = $2 LIMIT 1',
      [r.name, dstTypeId]);
    if (exists.rows.length) { console.log(`  = listing exists: ${r.name}`); continue; }
    if (DRY) { console.log(`  [dry] would insert ${typeName} listing: ${r.name} ($${r.price ?? '—'})`); continue; }

    const seller = (await sellerExists(r.seller_id)) ? r.seller_id : FALLBACK_SELLER_ID;
    const ins = await dst.query(
      `INSERT INTO product_listing (name, description, availability, image_url, seller_id, product_type_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING listing_id`,
      [r.name, r.description, r.availability ?? 100, r.image_url, seller, dstTypeId]);
    const listingId = ins.rows[0].listing_id;
    if (r.price != null) {
      await dst.query(
        `INSERT INTO product_variation (listing_id, price, description, vname, image_url, product_type_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [listingId, r.price, r.v_desc, r.vname ?? 'Standard', r.v_image, dstTypeId]);
    }
    console.log(`  + ${typeName} listing: ${r.name} ($${r.price ?? '—'})`);
  }
}

async function seedContent(catName, dstCatId) {
  const rows = (await src.query(
    `SELECT d.content_title, d.content_description, d.content_url, d.author, d.price, d.cover_img_url
       FROM dg_content d JOIN dg_categories c USING (dg_category_id)
      WHERE c.dg_category_name = $1`, [catName])).rows;

  for (const r of rows) {
    const exists = await dst.query(
      'SELECT content_id FROM dg_content WHERE content_title = $1 AND dg_category_id = $2 LIMIT 1',
      [r.content_title, dstCatId]);
    if (exists.rows.length) { console.log(`  = content exists: ${r.content_title}`); continue; }
    if (DRY) { console.log(`  [dry] would insert ${catName} content: ${r.content_title} ($${r.price ?? '—'})`); continue; }

    await dst.query(
      `INSERT INTO dg_content (content_title, content_description, content_url, author, price, date, dg_category_id, cover_img_url)
       VALUES ($1,$2,$3,$4,$5,NOW(),$6,$7)`,
      [r.content_title, r.content_description, r.content_url, r.author, r.price, dstCatId, r.cover_img_url]);
    console.log(`  + ${catName} content: ${r.content_title} ($${r.price ?? '—'})`);
  }
}

async function main() {
  console.log(`\n🌱 Seeding commerce categories ${DRY ? '(DRY RUN)' : ''}\n`);
  for (const [t, c] of [
    ['product_type', 'product_type_id'],
    ['product_listing', 'listing_id'],
    ['product_variation', 'variation_id'],
    ['dg_categories', 'dg_category_id'],
    ['dg_content', 'content_id'],
  ]) await fixSequence(t, c);

  console.log('Product listings:');
  for (const t of PRODUCT_TYPES) {
    const id = await ensureProductType(t);
    await seedListings(t, id);
  }
  console.log('\nDigital content:');
  for (const c of DG_CATEGORIES) {
    const id = await ensureDgCategory(c);
    await seedContent(c, id);
  }
  console.log('\n✓ Done\n');
}

main()
  .catch((e) => { console.error('Seed failed:', e); process.exitCode = 1; })
  .finally(async () => { await src.end(); await dst.end(); });
