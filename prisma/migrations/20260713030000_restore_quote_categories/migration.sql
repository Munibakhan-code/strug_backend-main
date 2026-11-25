-- Restore the Insurance/Mortgage quote categories that the 0_init squash dropped (#424).
--
-- These 13 rows (2 macro + 11 leaf sub-types, each with its dynamic form_schema) were only ever
-- created by the DML at the bottom of 20260627_add_insurance_mortgage_quotes, which now lives in
-- prisma/_archived_migrations_pre_0_init/ and is therefore never applied. 0_init was generated
-- from schema.prisma, so it creates the `quote_category` TABLE but inserts nothing, and no seed
-- script has ever touched it.
--
-- On the old prod DB the rows survived (data outlives deploys), so nobody noticed. The 2026-07-11
-- factory reset gave prod an empty database: 0_init created the table, `db seed` never filled it,
-- and the table has been empty ever since. GET /quote-categories then returns [] with HTTP 200 and
-- the page renders "no categories" — verified on prod, both verticals returned [].
--
-- Same root cause as #416 (the has_seen_welcome backfill lost in the same squash).
--
-- Replays the original DML verbatim. Idempotent (ON CONFLICT), so it is a no-op where the rows
-- already exist. The conflict targets additionally reassert is_active/is_live: the client always
-- requests live=1, so a row left is_live=false is invisible even though it exists.

-- ── Seed: macro categories (verticals) ──────────────────────────────────────
INSERT INTO "quote_category" ("name", "slug", "parent_id", "vertical", "is_active", "is_live") VALUES
 ('Insurance','insurance',NULL,'insurance',true,true),
 ('Mortgage','mortgage',NULL,'mortgage',true,true)
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "vertical" = EXCLUDED."vertical",
  "is_active" = true,
  "is_live" = true;

-- ── Seed: leaf sub-types + per-subtype dynamic form schemas ──────────────────
-- form_schema = array of {key,label,type,options?,required?}; non-PII fields only.
INSERT INTO "quote_category" ("name", "slug", "parent_id", "vertical", "is_active", "is_live", "form_schema")
SELECT v.name, v.slug, p."quote_category_id", v.vertical, true, true, v.form_schema::jsonb
FROM (VALUES
 -- Insurance sub-types
 ('Auto Insurance','auto-insurance','insurance','insurance',
   '[{"key":"vehicle_year","label":"Vehicle Year","type":"number","required":true},{"key":"vehicle_make","label":"Make","type":"text","required":true},{"key":"vehicle_model","label":"Model","type":"text","required":true},{"key":"usage","label":"Primary Use","type":"select","options":["Commute","Pleasure","Business","Rideshare"],"required":true},{"key":"annual_km","label":"Annual Distance (km)","type":"number"},{"key":"coverage_type","label":"Coverage","type":"select","options":["Liability only","Collision","Comprehensive"],"required":true},{"key":"driving_experience_years","label":"Years Driving","type":"number"},{"key":"current_insurer","label":"Current Insurer (optional)","type":"text"}]'),
 ('Home Insurance','home-insurance','insurance','insurance',
   '[{"key":"property_type","label":"Property Type","type":"select","options":["Detached","Semi-detached","Townhouse","Condo"],"required":true},{"key":"year_built","label":"Year Built","type":"number"},{"key":"square_footage","label":"Square Footage","type":"number"},{"key":"estimated_value","label":"Estimated Home Value","type":"number","required":true},{"key":"coverage_amount","label":"Desired Coverage","type":"number"},{"key":"has_security","label":"Has Security System","type":"select","options":["Yes","No"]}]'),
 ('Life Insurance','life-insurance','insurance','insurance',
   '[{"key":"policy_type","label":"Policy Type","type":"select","options":["Term","Whole","Universal"],"required":true},{"key":"coverage_amount","label":"Coverage Amount","type":"number","required":true},{"key":"term_years","label":"Term (years)","type":"select","options":["10","20","30"]},{"key":"age_range","label":"Age Range","type":"select","options":["18-29","30-39","40-49","50-59","60+"],"required":true},{"key":"smoker","label":"Smoker","type":"select","options":["Yes","No"],"required":true}]'),
 ('Health Insurance','health-insurance','insurance','insurance',
   '[{"key":"plan_type","label":"Plan Type","type":"select","options":["Individual","Couple","Family"],"required":true},{"key":"coverage_level","label":"Coverage Level","type":"select","options":["Basic","Standard","Premium"],"required":true},{"key":"age_range","label":"Age Range","type":"select","options":["18-29","30-39","40-49","50-59","60+"],"required":true},{"key":"dependents_count","label":"Number of Dependents","type":"number"}]'),
 ('Renters Insurance','renters-insurance','insurance','insurance',
   '[{"key":"property_type","label":"Dwelling Type","type":"select","options":["Apartment","Condo","House","Room"],"required":true},{"key":"contents_value","label":"Estimated Contents Value","type":"number","required":true},{"key":"coverage_amount","label":"Liability Coverage","type":"number"}]'),
 ('Travel Insurance','travel-insurance','insurance','insurance',
   '[{"key":"trip_type","label":"Trip Type","type":"select","options":["Single trip","Annual multi-trip"],"required":true},{"key":"destination_region","label":"Destination Region","type":"select","options":["Domestic","USA","Europe","Worldwide"],"required":true},{"key":"trip_duration_days","label":"Trip Duration (days)","type":"number"},{"key":"travelers_count","label":"Number of Travelers","type":"number","required":true},{"key":"age_range","label":"Oldest Traveler Age Range","type":"select","options":["0-17","18-49","50-64","65+"]}]'),
 ('Business Insurance','business-insurance','insurance','insurance',
   '[{"key":"business_type","label":"Business Type","type":"text","required":true},{"key":"num_employees","label":"Number of Employees","type":"number"},{"key":"annual_revenue_range","label":"Annual Revenue","type":"select","options":["<100k","100k-500k","500k-1M","1M+"]},{"key":"coverage_types","label":"Coverage Needed","type":"text"}]'),
 -- Mortgage sub-types
 ('New Purchase','mortgage-new-purchase','mortgage','mortgage',
   '[{"key":"property_type","label":"Property Type","type":"select","options":["Detached","Semi-detached","Townhouse","Condo"],"required":true},{"key":"property_price","label":"Property Price","type":"number","required":true},{"key":"down_payment","label":"Down Payment","type":"number","required":true},{"key":"amortization_years","label":"Amortization (years)","type":"select","options":["15","20","25","30"]},{"key":"employment_status","label":"Employment Status","type":"select","options":["Employed","Self-employed","Retired","Other"]},{"key":"annual_income_range","label":"Annual Household Income","type":"select","options":["<50k","50k-100k","100k-150k","150k+"]},{"key":"credit_score_range","label":"Credit Score Range (optional)","type":"select","options":["Excellent (760+)","Good (700-759)","Fair (640-699)","Below 640","Unsure"]}]'),
 ('Refinance','mortgage-refinance','mortgage','mortgage',
   '[{"key":"property_value","label":"Current Property Value","type":"number","required":true},{"key":"current_balance","label":"Current Mortgage Balance","type":"number","required":true},{"key":"desired_amount","label":"Desired New Amount","type":"number"},{"key":"current_rate","label":"Current Interest Rate (%)","type":"number"},{"key":"amortization_years","label":"Remaining Amortization (years)","type":"number"}]'),
 ('Renewal','mortgage-renewal','mortgage','mortgage',
   '[{"key":"property_value","label":"Property Value","type":"number","required":true},{"key":"current_balance","label":"Current Balance","type":"number","required":true},{"key":"current_rate","label":"Current Rate (%)","type":"number"},{"key":"current_lender","label":"Current Lender","type":"text"},{"key":"term_preference","label":"Preferred Term","type":"select","options":["1 yr","3 yr","5 yr","Variable"]}]'),
 ('Home Equity (HELOC)','mortgage-heloc','mortgage','mortgage',
   '[{"key":"property_value","label":"Property Value","type":"number","required":true},{"key":"mortgage_balance","label":"Existing Mortgage Balance","type":"number","required":true},{"key":"requested_credit_limit","label":"Requested Credit Limit","type":"number","required":true},{"key":"purpose","label":"Purpose","type":"text"}]')
) AS v(name, slug, parent_slug, vertical, form_schema)
JOIN "quote_category" p ON p."slug" = v.parent_slug
ON CONFLICT ("slug") DO UPDATE SET
  "name" = EXCLUDED."name",
  "vertical" = EXCLUDED."vertical",
  "form_schema" = EXCLUDED."form_schema",
  "is_active" = true,
  "is_live" = true;
