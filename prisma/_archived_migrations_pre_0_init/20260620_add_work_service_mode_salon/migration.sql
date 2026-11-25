-- Reversed-map mode + Salon services (Codezero). Additive + idempotent.

-- service_mode: 'mobile' (worker comes to you) | 'in_shop' (you go to the provider, e.g.
-- in-salon / auto shop). Default mobile so existing jobs are unaffected.
ALTER TABLE "work_job" ADD COLUMN IF NOT EXISTS "service_mode" VARCHAR(10) DEFAULT 'mobile';

-- Salon & Spa categories (in-salon = reversed map; mobile = comes to you).
INSERT INTO "work_category" ("name", "slug", "parent_id", "is_active", "is_live") VALUES
 ('Salon & Spa','salon-spa',NULL,true,false)
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "work_category" ("name", "slug", "parent_id", "is_active", "is_live")
SELECT v.name, v.slug, p."work_category_id", true, false
FROM (VALUES
 ('Haircut','salon-haircut','salon-spa'),
 ('Hair Colour','salon-hair-colour','salon-spa'),
 ('Blowout / Styling','salon-blowout','salon-spa'),
 ('Manicure','salon-manicure','salon-spa'),
 ('Pedicure','salon-pedicure','salon-spa'),
 ('Facial','salon-facial','salon-spa'),
 ('Waxing','salon-waxing','salon-spa'),
 ('Lashes','salon-lashes','salon-spa'),
 ('Massage','salon-massage','salon-spa'),
 ('Makeup','salon-makeup','salon-spa'),
 ('Spray Tan','salon-spray-tan','salon-spa'),
 ('Threading','salon-threading','salon-spa')
) AS v(name, slug, parent_slug)
JOIN "work_category" p ON p."slug" = v.parent_slug
ON CONFLICT ("slug") DO NOTHING;
