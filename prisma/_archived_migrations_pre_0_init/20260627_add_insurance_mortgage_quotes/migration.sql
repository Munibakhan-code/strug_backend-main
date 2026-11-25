-- Insurance & Mortgage Quote Marketplace (M1) — additive, idempotent.
-- Request-for-quote vertical: user broadcasts to providers in same city+country+category,
-- providers send quotes, user picks one and books an appointment.
-- Safe to re-run: CREATE TABLE/INDEX IF NOT EXISTS + ON CONFLICT seed.

-- ── Tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "quote_category" (
    "quote_category_id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(140) NOT NULL,
    "vertical" VARCHAR(20),
    "icon_url" VARCHAR(1000),
    "form_schema" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_live" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "quote_category_pkey" PRIMARY KEY ("quote_category_id"),
    CONSTRAINT "quote_category_parent_fkey" FOREIGN KEY ("parent_id") REFERENCES "quote_category"("quote_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS "quote_category_slug_key" ON "quote_category"("slug");
CREATE INDEX IF NOT EXISTS "idx_quote_category_parent" ON "quote_category"("parent_id");

CREATE TABLE IF NOT EXISTS "quote_provider" (
    "quote_provider_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "provider_type" VARCHAR(20) DEFAULT 'agent',
    "business_name" VARCHAR(200),
    "contact_email" VARCHAR(200),
    "contact_phone" VARCHAR(40),
    "license_no" VARCHAR(80),
    "bio" TEXT,
    "country" VARCHAR(60),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "rating" DOUBLE PRECISION,
    "stripe_account_id" VARCHAR(80),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    CONSTRAINT "quote_provider_pkey" PRIMARY KEY ("quote_provider_id"),
    CONSTRAINT "quote_provider_user_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_quote_provider_user" ON "quote_provider"("user_id");

CREATE TABLE IF NOT EXISTS "quote_provider_city" (
    "quote_provider_city_id" SERIAL NOT NULL,
    "quote_provider_id" INTEGER NOT NULL,
    "city" VARCHAR(120) NOT NULL,
    "country" VARCHAR(60),
    CONSTRAINT "quote_provider_city_pkey" PRIMARY KEY ("quote_provider_city_id"),
    CONSTRAINT "quote_provider_city_provider_fkey" FOREIGN KEY ("quote_provider_id") REFERENCES "quote_provider"("quote_provider_id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_quote_provider_city" ON "quote_provider_city"("quote_provider_id", "city", "country");
CREATE INDEX IF NOT EXISTS "idx_quote_provider_city_city" ON "quote_provider_city"("city");

CREATE TABLE IF NOT EXISTS "quote_provider_category" (
    "quote_provider_category_id" SERIAL NOT NULL,
    "quote_provider_id" INTEGER NOT NULL,
    "quote_category_id" INTEGER NOT NULL,
    CONSTRAINT "quote_provider_category_pkey" PRIMARY KEY ("quote_provider_category_id"),
    CONSTRAINT "quote_prov_cat_provider_fkey" FOREIGN KEY ("quote_provider_id") REFERENCES "quote_provider"("quote_provider_id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "quote_prov_cat_category_fkey" FOREIGN KEY ("quote_category_id") REFERENCES "quote_category"("quote_category_id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_quote_provider_category" ON "quote_provider_category"("quote_provider_id", "quote_category_id");
CREATE INDEX IF NOT EXISTS "idx_quote_prov_cat_category" ON "quote_provider_category"("quote_category_id");

CREATE TABLE IF NOT EXISTS "quote_request" (
    "quote_request_id" SERIAL NOT NULL,
    "requester_id" INTEGER,
    "category_id" INTEGER,
    "vertical" VARCHAR(20),
    "title" VARCHAR(200),
    "city" VARCHAR(120),
    "country" VARCHAR(60),
    "form_data" JSONB,
    "credit_number" VARCHAR(40),
    "notes" TEXT,
    "status" VARCHAR(20) DEFAULT 'open',
    "selected_quote_id" INTEGER,
    "expires_at" TIMESTAMP(6),
    "platform_fee" DOUBLE PRECISION,
    "payment_status" VARCHAR(20) DEFAULT 'none',
    "payment_intent_id" VARCHAR(255),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    CONSTRAINT "quote_request_pkey" PRIMARY KEY ("quote_request_id"),
    CONSTRAINT "quote_request_category_fkey" FOREIGN KEY ("category_id") REFERENCES "quote_category"("quote_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "quote_request_requester_fkey" FOREIGN KEY ("requester_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_quote_request_requester" ON "quote_request"("requester_id");
CREATE INDEX IF NOT EXISTS "idx_quote_request_category" ON "quote_request"("category_id");
CREATE INDEX IF NOT EXISTS "idx_quote_request_status" ON "quote_request"("status");
CREATE INDEX IF NOT EXISTS "idx_quote_request_city" ON "quote_request"("city");

CREATE TABLE IF NOT EXISTS "quote" (
    "quote_id" SERIAL NOT NULL,
    "quote_request_id" INTEGER NOT NULL,
    "provider_id" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION,
    "currency" VARCHAR(3) DEFAULT 'CAD',
    "note" TEXT,
    "details" JSONB,
    "valid_until" TIMESTAMP(6),
    "status" VARCHAR(20) DEFAULT 'active',
    "revised_from_id" INTEGER,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    CONSTRAINT "quote_pkey" PRIMARY KEY ("quote_id"),
    CONSTRAINT "quote_qr_fkey" FOREIGN KEY ("quote_request_id") REFERENCES "quote_request"("quote_request_id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "quote_qp_fkey" FOREIGN KEY ("provider_id") REFERENCES "quote_provider"("quote_provider_id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_quote_request" ON "quote"("quote_request_id");
CREATE INDEX IF NOT EXISTS "idx_quote_provider_quote" ON "quote"("provider_id");

CREATE TABLE IF NOT EXISTS "quote_appointment" (
    "quote_appointment_id" SERIAL NOT NULL,
    "quote_request_id" INTEGER NOT NULL,
    "quote_id" INTEGER,
    "provider_id" INTEGER NOT NULL,
    "requester_id" INTEGER,
    "scheduled_at" TIMESTAMP(6),
    "duration_minutes" INTEGER DEFAULT 30,
    "status" VARCHAR(20) DEFAULT 'proposed',
    "location" TEXT,
    "meeting_type" VARCHAR(20),
    "notes" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    CONSTRAINT "quote_appointment_pkey" PRIMARY KEY ("quote_appointment_id"),
    CONSTRAINT "quote_appt_request_fkey" FOREIGN KEY ("quote_request_id") REFERENCES "quote_request"("quote_request_id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "quote_appt_quote_fkey" FOREIGN KEY ("quote_id") REFERENCES "quote"("quote_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "quote_appt_provider_fkey" FOREIGN KEY ("provider_id") REFERENCES "quote_provider"("quote_provider_id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "quote_appt_requester_fkey" FOREIGN KEY ("requester_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_quote_appt_request" ON "quote_appointment"("quote_request_id");
CREATE INDEX IF NOT EXISTS "idx_quote_appt_provider" ON "quote_appointment"("provider_id");
CREATE INDEX IF NOT EXISTS "idx_quote_appt_requester" ON "quote_appointment"("requester_id");

-- ── Seed: macro categories (verticals) ──────────────────────────────────────
INSERT INTO "quote_category" ("name", "slug", "parent_id", "vertical", "is_active", "is_live") VALUES
 ('Insurance','insurance',NULL,'insurance',true,true),
 ('Mortgage','mortgage',NULL,'mortgage',true,true)
ON CONFLICT ("slug") DO UPDATE SET "name" = EXCLUDED."name", "vertical" = EXCLUDED."vertical";

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
  "form_schema" = EXCLUDED."form_schema";
