-- Automotive & Roadside on-demand categories (Codezero: automotive "set your price"
-- routes into the same rideshare-style dispatch → nearest mechanic). Additive + idempotent.
-- (20260615 is reserved for the pending shared booking-engine migration.)

INSERT INTO "work_category" ("name", "slug", "parent_id", "is_active", "is_live") VALUES
 ('Automotive & Roadside','automotive-roadside',NULL,true,false)
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "work_category" ("name", "slug", "parent_id", "is_active", "is_live")
SELECT v.name, v.slug, p."work_category_id", true, false
FROM (VALUES
 ('Mobile Mechanic','mobile-mechanic','automotive-roadside'),
 ('Mechanic','mechanic','automotive-roadside'),
 ('Tire Change','tire-change','automotive-roadside'),
 ('Battery / Jump Start','battery-jumpstart','automotive-roadside'),
 ('Towing','towing','automotive-roadside'),
 ('Oil Change','oil-change','automotive-roadside'),
 ('Brakes','brakes','automotive-roadside'),
 ('Diagnostics','diagnostics','automotive-roadside'),
 ('Car Detailing','car-detailing','automotive-roadside'),
 ('Lockout Service','lockout-service','automotive-roadside'),
 ('Roadside Assistance','roadside-assistance','automotive-roadside'),
 ('Windshield / Glass','windshield-glass','automotive-roadside')
) AS v(name, slug, parent_slug)
JOIN "work_category" p ON p."slug" = v.parent_slug
ON CONFLICT ("slug") DO NOTHING;
