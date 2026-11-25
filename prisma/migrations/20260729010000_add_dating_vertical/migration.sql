CREATE TABLE IF NOT EXISTS "dating_profile" (
  "dating_profile_id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'active',
  "display_name" VARCHAR(100),
  "bio" TEXT,
  "birthdate" DATE,
  "gender" VARCHAR(40),
  "interested_in" JSONB,
  "location_label" VARCHAR(255),
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "radius_km" INTEGER NOT NULL DEFAULT 25,
  "photos" JSONB,
  "prompts" JSONB,
  "lifestyle_signals" JSONB,
  "true_love_opt_in" BOOLEAN NOT NULL DEFAULT false,
  "is_discoverable" BOOLEAN NOT NULL DEFAULT true,
  "age_verified_at" TIMESTAMP(6),
  "last_active_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "dating_profile_user_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "dating_profile_user_unique" ON "dating_profile"("user_id");
CREATE INDEX IF NOT EXISTS "idx_dating_profile_discovery" ON "dating_profile"("status", "is_discoverable", "last_active_at");
CREATE INDEX IF NOT EXISTS "idx_dating_profile_location" ON "dating_profile"("lat", "lng");

CREATE TABLE IF NOT EXISTS "dating_blind_queue" (
  "dating_blind_queue_id" SERIAL PRIMARY KEY,
  "user_id" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'waiting',
  "boundaries" JSONB,
  "queued_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(6) NOT NULL,
  "matched_session_id" INTEGER,
  CONSTRAINT "dating_blind_queue_user_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_dating_blind_queue_match" ON "dating_blind_queue"("status", "expires_at", "queued_at");
CREATE INDEX IF NOT EXISTS "idx_dating_blind_queue_user" ON "dating_blind_queue"("user_id", "status");

CREATE TABLE IF NOT EXISTS "dating_blind_session" (
  "dating_blind_session_id" SERIAL PRIMARY KEY,
  "user_a_id" INTEGER NOT NULL,
  "user_b_id" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'chatting',
  "reveal_requested_by" INTEGER,
  "reveal_confirmed_by" JSONB,
  "revealed_at" TIMESTAMP(6),
  "chat_channel_id" INTEGER,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(6),
  CONSTRAINT "dating_blind_session_user_a_fkey" FOREIGN KEY ("user_a_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_blind_session_user_b_fkey" FOREIGN KEY ("user_b_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_blind_session_distinct_users" CHECK ("user_a_id" <> "user_b_id")
);

CREATE INDEX IF NOT EXISTS "idx_dating_blind_session_a" ON "dating_blind_session"("user_a_id", "status");
CREATE INDEX IF NOT EXISTS "idx_dating_blind_session_b" ON "dating_blind_session"("user_b_id", "status");

CREATE TABLE IF NOT EXISTS "dating_swipe" (
  "dating_swipe_id" SERIAL PRIMARY KEY,
  "actor_id" INTEGER NOT NULL,
  "target_id" INTEGER NOT NULL,
  "action" VARCHAR(12) NOT NULL,
  "mode" VARCHAR(20) NOT NULL DEFAULT 'standard',
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dating_swipe_actor_fkey" FOREIGN KEY ("actor_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_swipe_target_fkey" FOREIGN KEY ("target_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_swipe_distinct_users" CHECK ("actor_id" <> "target_id"),
  CONSTRAINT "dating_swipe_action_check" CHECK ("action" IN ('like', 'pass'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "dating_swipe_actor_target_mode_unique" ON "dating_swipe"("actor_id", "target_id", "mode");
CREATE INDEX IF NOT EXISTS "idx_dating_swipe_target_action" ON "dating_swipe"("target_id", "action");

CREATE TABLE IF NOT EXISTS "dating_match" (
  "dating_match_id" SERIAL PRIMARY KEY,
  "user_a_id" INTEGER NOT NULL,
  "user_b_id" INTEGER NOT NULL,
  "mode" VARCHAR(20) NOT NULL DEFAULT 'standard',
  "status" VARCHAR(20) NOT NULL DEFAULT 'matched',
  "matched_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unmatched_at" TIMESTAMP(6),
  "chat_channel_id" INTEGER,
  CONSTRAINT "dating_match_user_a_fkey" FOREIGN KEY ("user_a_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_match_user_b_fkey" FOREIGN KEY ("user_b_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_match_distinct_users" CHECK ("user_a_id" <> "user_b_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dating_match_pair_mode_unique" ON "dating_match"("user_a_id", "user_b_id", "mode");
CREATE INDEX IF NOT EXISTS "idx_dating_match_a" ON "dating_match"("user_a_id", "status");
CREATE INDEX IF NOT EXISTS "idx_dating_match_b" ON "dating_match"("user_b_id", "status");

CREATE TABLE IF NOT EXISTS "dating_date_plan" (
  "dating_date_plan_id" SERIAL PRIMARY KEY,
  "organizer_id" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
  "visibility" VARCHAR(20) NOT NULL DEFAULT 'private',
  "title" VARCHAR(160),
  "restaurant_name" VARCHAR(180) NOT NULL,
  "restaurant_address" TEXT,
  "vendor_id" INTEGER,
  "booking_id" INTEGER,
  "ride_request_id" INTEGER,
  "gift_order_id" INTEGER,
  "date" DATE NOT NULL,
  "time" VARCHAR(5) NOT NULL,
  "party_size" INTEGER NOT NULL DEFAULT 2,
  "budget_amount" DOUBLE PRECISION NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
  "payment_split" VARCHAR(20) NOT NULL DEFAULT '50',
  "host_note" TEXT,
  "menu_intent" JSONB,
  "includes_ride" BOOLEAN NOT NULL DEFAULT false,
  "includes_flowers" BOOLEAN NOT NULL DEFAULT false,
  "safety_rules" JSONB,
  "accepted_interest_id" INTEGER,
  "confirmed_guest_id" INTEGER,
  "lat" DOUBLE PRECISION,
  "lng" DOUBLE PRECISION,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "dating_date_plan_organizer_fkey" FOREIGN KEY ("organizer_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_date_plan_vendor_fkey" FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id") ON DELETE SET NULL ON UPDATE NO ACTION,
  CONSTRAINT "dating_date_plan_budget_check" CHECK ("budget_amount" >= 0),
  CONSTRAINT "dating_date_plan_party_size_check" CHECK ("party_size" BETWEEN 2 AND 12)
);

CREATE INDEX IF NOT EXISTS "idx_dating_date_plan_public" ON "dating_date_plan"("status", "visibility", "date");
CREATE INDEX IF NOT EXISTS "idx_dating_date_plan_organizer" ON "dating_date_plan"("organizer_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_dating_date_plan_vendor" ON "dating_date_plan"("vendor_id");

CREATE TABLE IF NOT EXISTS "dating_date_interest" (
  "dating_date_interest_id" SERIAL PRIMARY KEY,
  "dating_date_plan_id" INTEGER NOT NULL,
  "user_id" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'interested',
  "message" TEXT,
  "selected_menu" JSONB,
  "budget_amount" DOUBLE PRECISION,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(6),
  CONSTRAINT "dating_date_interest_plan_fkey" FOREIGN KEY ("dating_date_plan_id") REFERENCES "dating_date_plan"("dating_date_plan_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_date_interest_user_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "dating_date_interest_plan_user_unique" ON "dating_date_interest"("dating_date_plan_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_dating_date_interest_user" ON "dating_date_interest"("user_id", "status");

CREATE TABLE IF NOT EXISTS "dating_date_invite" (
  "dating_date_invite_id" SERIAL PRIMARY KEY,
  "dating_date_plan_id" INTEGER NOT NULL,
  "sender_id" INTEGER NOT NULL,
  "recipient_id" INTEGER NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'sent',
  "note" TEXT,
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "responded_at" TIMESTAMP(6),
  CONSTRAINT "dating_date_invite_plan_fkey" FOREIGN KEY ("dating_date_plan_id") REFERENCES "dating_date_plan"("dating_date_plan_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_date_invite_sender_fkey" FOREIGN KEY ("sender_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_date_invite_recipient_fkey" FOREIGN KEY ("recipient_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_date_invite_distinct_users" CHECK ("sender_id" <> "recipient_id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dating_date_invite_plan_recipient_unique" ON "dating_date_invite"("dating_date_plan_id", "recipient_id");
CREATE INDEX IF NOT EXISTS "idx_dating_date_invite_recipient" ON "dating_date_invite"("recipient_id", "status");

CREATE TABLE IF NOT EXISTS "dating_report" (
  "dating_report_id" SERIAL PRIMARY KEY,
  "reporter_id" INTEGER NOT NULL,
  "reported_user_id" INTEGER,
  "entity_type" VARCHAR(40),
  "entity_id" INTEGER,
  "reason" VARCHAR(80) NOT NULL,
  "details" TEXT,
  "status" VARCHAR(20) NOT NULL DEFAULT 'open',
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dating_report_reporter_fkey" FOREIGN KEY ("reporter_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "dating_report_reported_fkey" FOREIGN KEY ("reported_user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS "idx_dating_report_reported" ON "dating_report"("reported_user_id", "created_at");
CREATE INDEX IF NOT EXISTS "idx_dating_report_status" ON "dating_report"("status", "created_at");
