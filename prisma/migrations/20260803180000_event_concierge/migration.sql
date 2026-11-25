-- Event Concierge: personal event planner (plans, needs, guests/RSVP, contribution registry)

CREATE TABLE IF NOT EXISTS "event_plan" (
    "event_plan_id" SERIAL NOT NULL,
    "owner_id" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "occasion" VARCHAR(40) NOT NULL,
    "event_date" TIMESTAMP(6),
    "guests" INTEGER,
    "budget" DECIMAL(12,2),
    "city" VARCHAR(100),
    "vibe" VARCHAR(40),
    "notes" TEXT,
    "invite_theme" VARCHAR(40) NOT NULL DEFAULT 'elegant',
    "invite_message" TEXT,
    "cover_color" VARCHAR(20),
    "share_token" VARCHAR(64) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'planning',
    "package_json" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    CONSTRAINT "event_plan_pkey" PRIMARY KEY ("event_plan_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "event_plan_share_token_key" ON "event_plan"("share_token");
CREATE INDEX IF NOT EXISTS "idx_event_plan_owner" ON "event_plan"("owner_id");
CREATE INDEX IF NOT EXISTS "idx_event_plan_share" ON "event_plan"("share_token");
CREATE INDEX IF NOT EXISTS "idx_event_plan_status" ON "event_plan"("status");

CREATE TABLE IF NOT EXISTS "event_need" (
    "event_need_id" SERIAL NOT NULL,
    "event_plan_id" INTEGER NOT NULL,
    "category" VARCHAR(40) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'todo',
    "target_budget" DECIMAL(12,2),
    "notes" TEXT,
    "linked_nav" VARCHAR(40),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "event_need_pkey" PRIMARY KEY ("event_need_id")
);

CREATE INDEX IF NOT EXISTS "idx_event_need_plan" ON "event_need"("event_plan_id");

CREATE TABLE IF NOT EXISTS "event_guest" (
    "event_guest_id" SERIAL NOT NULL,
    "event_plan_id" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(200),
    "phone" VARCHAR(40),
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "plus_ones" INTEGER NOT NULL DEFAULT 0,
    "rsvp_note" VARCHAR(500),
    "invite_token" VARCHAR(64) NOT NULL,
    "invited_at" TIMESTAMP(6),
    "responded_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "event_guest_pkey" PRIMARY KEY ("event_guest_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "event_guest_invite_token_key" ON "event_guest"("invite_token");
CREATE INDEX IF NOT EXISTS "idx_event_guest_plan" ON "event_guest"("event_plan_id");
CREATE INDEX IF NOT EXISTS "idx_event_guest_token" ON "event_guest"("invite_token");
CREATE INDEX IF NOT EXISTS "idx_event_guest_status" ON "event_guest"("status");

CREATE TABLE IF NOT EXISTS "event_registry_item" (
    "registry_item_id" SERIAL NOT NULL,
    "event_plan_id" INTEGER NOT NULL,
    "title" VARCHAR(500) NOT NULL,
    "description" TEXT,
    "image_url" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "item_type" VARCHAR(20) NOT NULL DEFAULT 'custom',
    "item_ref_id" INTEGER,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    CONSTRAINT "event_registry_item_pkey" PRIMARY KEY ("registry_item_id")
);

CREATE INDEX IF NOT EXISTS "idx_event_registry_plan" ON "event_registry_item"("event_plan_id");
CREATE INDEX IF NOT EXISTS "idx_event_registry_status" ON "event_registry_item"("status");

CREATE TABLE IF NOT EXISTS "event_registry_contribution" (
    "contribution_id" SERIAL NOT NULL,
    "registry_item_id" INTEGER NOT NULL,
    "contributor_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "payment_method" VARCHAR(20) NOT NULL DEFAULT 'wallet',
    "status" VARCHAR(20) NOT NULL DEFAULT 'completed',
    "note" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "event_registry_contribution_pkey" PRIMARY KEY ("contribution_id")
);

CREATE INDEX IF NOT EXISTS "idx_event_registry_contrib_item" ON "event_registry_contribution"("registry_item_id");
CREATE INDEX IF NOT EXISTS "idx_event_registry_contrib_user" ON "event_registry_contribution"("contributor_id");

DO $$ BEGIN
  ALTER TABLE "event_plan" ADD CONSTRAINT "event_plan_owner_id_fkey"
    FOREIGN KEY ("owner_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "event_need" ADD CONSTRAINT "event_need_event_plan_id_fkey"
    FOREIGN KEY ("event_plan_id") REFERENCES "event_plan"("event_plan_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "event_guest" ADD CONSTRAINT "event_guest_event_plan_id_fkey"
    FOREIGN KEY ("event_plan_id") REFERENCES "event_plan"("event_plan_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "event_registry_item" ADD CONSTRAINT "event_registry_item_event_plan_id_fkey"
    FOREIGN KEY ("event_plan_id") REFERENCES "event_plan"("event_plan_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "event_registry_contribution" ADD CONSTRAINT "event_registry_contribution_registry_item_id_fkey"
    FOREIGN KEY ("registry_item_id") REFERENCES "event_registry_item"("registry_item_id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "event_registry_contribution" ADD CONSTRAINT "event_registry_contribution_contributor_id_fkey"
    FOREIGN KEY ("contributor_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
