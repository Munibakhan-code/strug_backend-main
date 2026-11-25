-- On-Demand Work Platform (M1) — additive, idempotent.
-- Rideshare-style booking of in-person workers. Mirrors ride_request / driver_profile.
-- Safe to re-run: CREATE TABLE/INDEX IF NOT EXISTS + ON CONFLICT seed.

-- ── Tables ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "work_category" (
    "work_category_id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(140) NOT NULL,
    "icon_url" VARCHAR(1000),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_live" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "work_category_pkey" PRIMARY KEY ("work_category_id"),
    CONSTRAINT "work_category_parent_fkey" FOREIGN KEY ("parent_id") REFERENCES "work_category"("work_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "worker_profile" (
    "worker_profile_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "bio" TEXT,
    "is_available" BOOLEAN DEFAULT false,
    "current_lat" DOUBLE PRECISION,
    "current_long" DOUBLE PRECISION,
    "last_ping" TIMESTAMP(6),
    "rating" DOUBLE PRECISION,
    "stripe_account_id" VARCHAR(80),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "worker_profile_pkey" PRIMARY KEY ("worker_profile_id"),
    CONSTRAINT "worker_profile_user_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "worker_category" (
    "worker_category_id" SERIAL NOT NULL,
    "worker_profile_id" INTEGER NOT NULL,
    "work_category_id" INTEGER NOT NULL,
    CONSTRAINT "worker_category_pkey" PRIMARY KEY ("worker_category_id"),
    CONSTRAINT "worker_category_worker_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profile"("worker_profile_id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "worker_category_category_fkey" FOREIGN KEY ("work_category_id") REFERENCES "work_category"("work_category_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "work_job" (
    "work_job_id" SERIAL NOT NULL,
    "hirer_id" INTEGER,
    "assigned_worker_id" INTEGER,
    "category_id" INTEGER,
    "title" VARCHAR(200),
    "instructions" TEXT,
    "location_lat" DOUBLE PRECISION,
    "location_long" DOUBLE PRECISION,
    "address" TEXT,
    "scheduled_start" TIMESTAMP(6),
    "scheduled_end" TIMESTAMP(6),
    "status" VARCHAR(20) DEFAULT 'draft',
    "price_type" VARCHAR(10) DEFAULT 'flat',
    "hirer_set_price" DOUBLE PRECISION,
    "hourly_rate" DOUBLE PRECISION,
    "duration_hours" DOUBLE PRECISION,
    "platform_fee_pct" DOUBLE PRECISION DEFAULT 8,
    "tax_amount" DOUBLE PRECISION,
    "worker_payout" DOUBLE PRECISION,
    "tip_amount" DOUBLE PRECISION DEFAULT 0,
    "cancellation_reason" TEXT,
    "extended_end" TIMESTAMP(6),
    "offer_expires_at" TIMESTAMP(6),
    "declined_worker_ids" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "photos" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "payment_method" VARCHAR(30),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    CONSTRAINT "work_job_pkey" PRIMARY KEY ("work_job_id"),
    CONSTRAINT "work_job_hirer_fkey" FOREIGN KEY ("hirer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "work_job_category_fkey" FOREIGN KEY ("category_id") REFERENCES "work_category"("work_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "work_job_offer" (
    "work_job_offer_id" SERIAL NOT NULL,
    "work_job_id" INTEGER NOT NULL,
    "worker_profile_id" INTEGER NOT NULL,
    "offered_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(6),
    "response" VARCHAR(10) DEFAULT 'pending',
    CONSTRAINT "work_job_offer_pkey" PRIMARY KEY ("work_job_offer_id"),
    CONSTRAINT "work_job_offer_job_fkey" FOREIGN KEY ("work_job_id") REFERENCES "work_job"("work_job_id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "work_job_offer_worker_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profile"("worker_profile_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE TABLE IF NOT EXISTS "work_review" (
    "work_review_id" SERIAL NOT NULL,
    "work_job_id" INTEGER NOT NULL,
    "reviewer_id" INTEGER,
    "worker_profile_id" INTEGER,
    "rating" DOUBLE PRECISION,
    "comment" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "work_review_pkey" PRIMARY KEY ("work_review_id"),
    CONSTRAINT "work_review_job_fkey" FOREIGN KEY ("work_job_id") REFERENCES "work_job"("work_job_id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "work_review_reviewer_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION,
    CONSTRAINT "work_review_worker_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profile"("worker_profile_id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "work_category_slug_key" ON "work_category"("slug");
CREATE INDEX IF NOT EXISTS "idx_work_category_parent" ON "work_category"("parent_id");
CREATE INDEX IF NOT EXISTS "idx_worker_profile_user" ON "worker_profile"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_worker_category" ON "worker_category"("worker_profile_id", "work_category_id");
CREATE INDEX IF NOT EXISTS "idx_worker_category_category" ON "worker_category"("work_category_id");
CREATE INDEX IF NOT EXISTS "idx_work_job_hirer" ON "work_job"("hirer_id");
CREATE INDEX IF NOT EXISTS "idx_work_job_category" ON "work_job"("category_id");
CREATE INDEX IF NOT EXISTS "idx_work_job_status" ON "work_job"("status");
CREATE INDEX IF NOT EXISTS "idx_work_job_worker" ON "work_job"("assigned_worker_id");
CREATE INDEX IF NOT EXISTS "idx_work_job_offer_job" ON "work_job_offer"("work_job_id");
CREATE INDEX IF NOT EXISTS "idx_work_job_offer_worker" ON "work_job_offer"("worker_profile_id");
CREATE INDEX IF NOT EXISTS "idx_work_review_job" ON "work_review"("work_job_id");
CREATE INDEX IF NOT EXISTS "idx_work_review_worker" ON "work_review"("worker_profile_id");

-- ── Seed: macro-categories (parent_id NULL) ───────────────────────────────
INSERT INTO "work_category" ("name", "slug", "parent_id", "is_active", "is_live") VALUES
 ('Home & Property Maintenance','home-property-maintenance',NULL,true,false),
 ('Cleaning','cleaning',NULL,true,false),
 ('Landscaping & Outdoor','landscaping-outdoor',NULL,true,false),
 ('Security & Surveillance','security-surveillance',NULL,true,false),
 ('Moving & Logistics','moving-logistics',NULL,true,false),
 ('Childcare','childcare',NULL,true,false),
 ('Elder & Personal Care','elder-personal-care',NULL,true,false),
 ('Pet Care','pet-care',NULL,true,false),
 ('Food & Hospitality','food-hospitality',NULL,true,false),
 ('Events & Entertainment','events-entertainment',NULL,true,false),
 ('Construction & Trades','construction-trades',NULL,true,false),
 ('IT & Tech (On-Site)','it-tech-onsite',NULL,true,false),
 ('Health & Wellness','health-wellness',NULL,true,false),
 ('Beauty & Grooming','beauty-grooming',NULL,true,false),
 ('Retail & Merchandising','retail-merchandising',NULL,true,false),
 ('Warehousing & Labor','warehousing-labor',NULL,true,false)
ON CONFLICT ("slug") DO NOTHING;

-- ── Seed: leaf worker-types (parent resolved by slug) ─────────────────────
INSERT INTO "work_category" ("name", "slug", "parent_id", "is_active", "is_live")
SELECT v.name, v.slug, p."work_category_id", true, false
FROM (VALUES
 -- Home & Property Maintenance
 ('Plumber','plumber','home-property-maintenance'),
 ('Electrician','electrician','home-property-maintenance'),
 ('HVAC Technician','hvac-technician','home-property-maintenance'),
 ('Roofer','roofer','home-property-maintenance'),
 ('Painter (Interior)','painter-interior','home-property-maintenance'),
 ('Painter (Exterior)','painter-exterior','home-property-maintenance'),
 ('Handyman','handyman','home-property-maintenance'),
 ('Carpenter','carpenter','home-property-maintenance'),
 ('Drywall','drywall','home-property-maintenance'),
 ('Flooring','flooring','home-property-maintenance'),
 ('Tile Setter','tile-setter','home-property-maintenance'),
 ('Insulation','insulation','home-property-maintenance'),
 ('Window Installer','window-installer','home-property-maintenance'),
 ('Doors','doors','home-property-maintenance'),
 ('Gutter','gutter','home-property-maintenance'),
 ('Pressure Washer','pressure-washer','home-property-maintenance'),
 ('Chimney','chimney','home-property-maintenance'),
 ('Fireplace','fireplace','home-property-maintenance'),
 ('Fence','fence','home-property-maintenance'),
 ('Deck','deck','home-property-maintenance'),
 ('Patio','patio','home-property-maintenance'),
 ('Concrete Worker','concrete-worker','home-property-maintenance'),
 ('Masonry Worker','masonry-worker','home-property-maintenance'),
 ('Waterproofing','waterproofing','home-property-maintenance'),
 ('Garage Door','garage-door','home-property-maintenance'),
 ('Locksmith','locksmith','home-property-maintenance'),
 ('Glass Repair','glass-repair','home-property-maintenance'),
 -- Cleaning
 ('House Cleaner','house-cleaner','cleaning'),
 ('Deep Cleaner','deep-cleaner','cleaning'),
 ('Move In/Out','move-in-out','cleaning'),
 ('Carpet Cleaner','carpet-cleaner','cleaning'),
 ('Upholstery Cleaner','upholstery-cleaner','cleaning'),
 ('Window Washer','window-washer','cleaning'),
 ('Laundry','laundry','cleaning'),
 ('Dry Cleaning','dry-cleaning','cleaning'),
 ('Maid Service','maid-service','cleaning'),
 ('Commercial','commercial-cleaning','cleaning'),
 ('Construction Cleaning','construction-cleaning','cleaning'),
 -- Landscaping & Outdoor
 ('Lawn Mower','lawn-mower','landscaping-outdoor'),
 ('Landscaper','landscaper','landscaping-outdoor'),
 ('Tree Trimmer','tree-trimmer','landscaping-outdoor'),
 ('Tree Removal','tree-removal','landscaping-outdoor'),
 ('Arborist','arborist','landscaping-outdoor'),
 ('Snow Plower','snow-plower','landscaping-outdoor'),
 ('Snow Shoveler','snow-shoveler','landscaping-outdoor'),
 ('Leaf Blower','leaf-blower','landscaping-outdoor'),
 ('Hedge Trimmer','hedge-trimmer','landscaping-outdoor'),
 ('Irrigation Installer','irrigation-installer','landscaping-outdoor'),
 ('Irrigation Repair','irrigation-repair','landscaping-outdoor'),
 ('Garden Planter','garden-planter','landscaping-outdoor'),
 ('Flower Bed','flower-bed','landscaping-outdoor'),
 ('Sod Installer','sod-installer','landscaping-outdoor'),
 ('Mulch Installer','mulch-installer','landscaping-outdoor'),
 ('Pest Control','pest-control','landscaping-outdoor'),
 ('Sprinkler System','sprinkler-system','landscaping-outdoor'),
 ('Outdoor Lighting Installer','outdoor-lighting-installer','landscaping-outdoor'),
 ('Pool Cleaner','pool-cleaner','landscaping-outdoor'),
 ('Pool Technician','pool-technician','landscaping-outdoor'),
 ('Hot Tub Technician','hot-tub-technician','landscaping-outdoor'),
 ('Driveway','driveway','landscaping-outdoor'),
 -- Security & Surveillance
 ('Security Guard','security-guard','security-surveillance'),
 ('Bouncer','bouncer','security-surveillance'),
 ('Parking Lot Attendant','parking-lot-attendant','security-surveillance'),
 ('Valet','valet','security-surveillance'),
 ('Mobile Patrol','mobile-patrol','security-surveillance'),
 ('Bodyguard','bodyguard','security-surveillance'),
 ('Hotel Security','hotel-security','security-surveillance'),
 ('Concierge','concierge','security-surveillance'),
 ('CCTV Monitoring','cctv-monitoring','security-surveillance'),
 -- Moving & Logistics
 ('Mover (Local)','mover-local','moving-logistics'),
 ('Mover (Long Distance)','mover-long-distance','moving-logistics'),
 ('Furniture Assembly','furniture-assembly','moving-logistics'),
 ('Appliance Installer','appliance-installer','moving-logistics'),
 ('Junk Removal','junk-removal','moving-logistics'),
 ('Piano Mover','piano-mover','moving-logistics'),
 -- Childcare
 ('Babysitter','babysitter','childcare'),
 ('Nanny','nanny','childcare'),
 -- Elder & Personal Care
 ('Personal Support','personal-support','elder-personal-care'),
 -- Pet Care
 ('Dog Walker','dog-walker','pet-care'),
 ('Pet Sitter','pet-sitter','pet-care'),
 ('In-Home Pet Care','pet-in-home','pet-care'),
 ('Groomer (Mobile)','groomer-mobile','pet-care'),
 ('Groomer (In-Person)','groomer-in-person','pet-care'),
 -- Food & Hospitality
 ('Private Chef','private-chef','food-hospitality'),
 ('Meal Prepper','meal-prepper','food-hospitality'),
 ('Personal Cook','personal-cook','food-hospitality'),
 ('Catering','catering','food-hospitality'),
 ('Catering Assistant','catering-assistant','food-hospitality'),
 ('Bartender','bartender','food-hospitality'),
 ('Barista','barista','food-hospitality'),
 ('Server','server','food-hospitality'),
 ('Event Server','event-server','food-hospitality'),
 ('Waitress','waitress','food-hospitality'),
 ('Waiter','waiter','food-hospitality'),
 ('Dishwasher','dishwasher','food-hospitality'),
 ('Kitchen Helper','kitchen-helper','food-hospitality'),
 ('Sushi Chef','sushi-chef','food-hospitality'),
 ('Pastry Chef','pastry-chef','food-hospitality'),
 ('Cake Decorator','cake-decorator','food-hospitality'),
 -- Events & Entertainment
 ('Crew (Helpers)','crew-helpers','events-entertainment'),
 ('Balloon Artist','balloon-artist','events-entertainment'),
 ('Face Painter','face-painter','events-entertainment'),
 ('Magician','magician','events-entertainment'),
 ('Clown','clown','events-entertainment'),
 ('Comedian','comedian','events-entertainment'),
 ('DJ','dj','events-entertainment'),
 ('Live Musician','live-musician','events-entertainment'),
 ('MC / Host','mc-host','events-entertainment'),
 ('Photographer','photographer','events-entertainment'),
 ('Videographer','videographer','events-entertainment'),
 ('Lighting Tech','lighting-tech','events-entertainment'),
 ('Sound Tech','sound-tech','events-entertainment'),
 ('Ticket Attendant','ticket-attendant','events-entertainment'),
 -- Construction & Trades
 ('Forklift Operator','forklift-operator','construction-trades'),
 ('General Labourer','general-labourer','construction-trades'),
 -- IT & Tech (On-Site)
 ('Phone Repair','phone-repair','it-tech-onsite'),
 ('Computer Repair','computer-repair','it-tech-onsite'),
 -- Health & Wellness
 ('Personal Trainer','personal-trainer','health-wellness'),
 ('Massage Therapist','massage-therapist','health-wellness'),
 -- Beauty & Grooming
 ('Hairstylist (Mobile)','hairstylist-mobile','beauty-grooming'),
 ('Barber (Mobile)','barber-mobile','beauty-grooming'),
 ('Makeup Artist','makeup-artist','beauty-grooming'),
 ('Nail Technician (Mobile)','nail-technician-mobile','beauty-grooming'),
 ('Eyebrow Threader','eyebrow-threader','beauty-grooming'),
 ('Eyelash Tech','eyelash-tech','beauty-grooming'),
 ('Waxing Technician','waxing-technician','beauty-grooming'),
 ('Hair Stylist (Salon)','hairstylist-salon','beauty-grooming'),
 ('Barber (Salon)','barber-salon','beauty-grooming'),
 ('Skin Care','skin-care','beauty-grooming'),
 ('Braider','braider','beauty-grooming'),
 ('Wedding','wedding-beauty','beauty-grooming'),
 ('Tattoo Artist','tattoo-artist','beauty-grooming'),
 ('Piercings','piercings','beauty-grooming'),
 -- Retail & Merchandising
 ('Merchandiser','merchandiser','retail-merchandising'),
 ('Retail Associate','retail-associate','retail-merchandising'),
 -- Warehousing & Labor
 ('General Work','general-work','warehousing-labor')
) AS v(name, slug, parent_slug)
JOIN "work_category" p ON p."slug" = v.parent_slug
ON CONFLICT ("slug") DO NOTHING;
