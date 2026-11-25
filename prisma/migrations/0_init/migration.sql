-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'MODERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "VerificationType" AS ENUM ('NONE', 'FAN_ACCOUNT', 'TOP_RATED', 'INDIVIDUAL', 'CHARITY', 'CORPORATION', 'EDUCATIONAL', 'GOVERNMENT', 'MEDIA', 'PUBLIC_FIGURE');

-- CreateEnum
CREATE TYPE "LiveMonetizationStatus" AS ENUM ('NONE', 'ELIGIBLE', 'PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "StreamStatus" AS ENUM ('IDLE', 'STARTING', 'LIVE', 'FINISHED', 'CANCELLED', 'ENDED');

-- CreateEnum
CREATE TYPE "GuestStatus" AS ENUM ('INVITED', 'JOINED', 'KICKED', 'LEFT', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID');

-- CreateTable
CREATE TABLE "active_trip" (
    "trip_id" SERIAL NOT NULL,
    "request_id" INTEGER,
    "driver_id" INTEGER,
    "vehicle_id" INTEGER,
    "started_at" TIMESTAMP(6),
    "ended_at" TIMESTAMP(6),
    "actual_distance_km" DOUBLE PRECISION,
    "total_fare" DOUBLE PRECISION,
    "payment_method" VARCHAR(50),
    "otp_code" VARCHAR(4),
    "accepted_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "driver_arrived_at" TIMESTAMP(6),
    "driver_payout" DOUBLE PRECISION,
    "platform_fee" DOUBLE PRECISION,

    CONSTRAINT "active_trip_pkey" PRIMARY KEY ("trip_id")
);

-- CreateTable
CREATE TABLE "admin" (
    "aid" SERIAL NOT NULL,
    "name" VARCHAR(1000),
    "email" VARCHAR(1000),
    "password" VARCHAR(2000),

    CONSTRAINT "admin_pkey" PRIMARY KEY ("aid")
);

-- CreateTable
CREATE TABLE "agents" (
    "agent_id" SERIAL NOT NULL,
    "agent_user_id" INTEGER,
    "company_name" TEXT,
    "company_web_url" TEXT,
    "company_country" TEXT,
    "role" TEXT,

    CONSTRAINT "agents_pkey" PRIMARY KEY ("agent_id")
);

-- CreateTable
CREATE TABLE "appointment_rating" (
    "rating_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "rating" INTEGER,
    "review" TEXT,
    "appointment_id" INTEGER,

    CONSTRAINT "appointment_rating_pkey" PRIMARY KEY ("rating_id")
);

-- CreateTable
CREATE TABLE "appointment_reviews" (
    "review_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "review" TEXT,
    "appointment_id" INTEGER,

    CONSTRAINT "appointment_reviews_pkey" PRIMARY KEY ("review_id")
);

-- CreateTable
CREATE TABLE "appointment_service" (
    "service_id" SERIAL NOT NULL,
    "service_name" TEXT,
    "service_description" TEXT,
    "service_price" DOUBLE PRECISION,
    "service_image_url" TEXT,
    "service_category_id" INTEGER,

    CONSTRAINT "appointment_service_pkey" PRIMARY KEY ("service_id")
);

-- CreateTable
CREATE TABLE "appointment_service_category" (
    "service_category_id" SERIAL NOT NULL,
    "service_category_name" TEXT,

    CONSTRAINT "appointment_service_category_pkey" PRIMARY KEY ("service_category_id")
);

-- CreateTable
CREATE TABLE "appointment_service_providers" (
    "service_provider_id" SERIAL NOT NULL,
    "service_provider_user_id" INTEGER,
    "company_phone_number" TEXT,
    "profile_picture" TEXT,
    "company_address" TEXT,
    "password" TEXT,
    "language" TEXT,
    "service_type" TEXT,
    "specialization" TEXT,
    "work_days_from" TEXT,
    "work_days_to" TEXT,
    "work_hours_from" TIME(6),
    "work_hours_to" TIME(6),
    "company_name" TEXT,
    "appointment_fee" INTEGER,

    CONSTRAINT "appointment_service_providers_pkey" PRIMARY KEY ("service_provider_id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "appointment_id" SERIAL NOT NULL,
    "service_provider_id" INTEGER,
    "user_id" INTEGER,
    "time_to" TIMESTAMP(6),
    "time_from" TIMESTAMP(6),
    "date" DATE,
    "note" TEXT,
    "service_id" INTEGER,
    "checkout_id" INTEGER,
    "status" TEXT DEFAULT 'pending',

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("appointment_id")
);

-- CreateTable
CREATE TABLE "bank_info" (
    "bank_info_id" SERIAL NOT NULL,
    "employee_id" INTEGER,
    "account_holder" TEXT,
    "account_type" TEXT,
    "bank_name" TEXT,
    "bank_account_number" TEXT,
    "bank_branch" TEXT,

    CONSTRAINT "bank_info_pkey" PRIMARY KEY ("bank_info_id")
);

-- CreateTable
CREATE TABLE "behance" (
    "behance_id" SERIAL NOT NULL,
    "behance_user_id" INTEGER,
    "is_hireable" BOOLEAN,

    CONSTRAINT "behance_pkey" PRIMARY KEY ("behance_id")
);

-- CreateTable
CREATE TABLE "behance_contacted" (
    "contacted_id" SERIAL NOT NULL,
    "behance_id" INTEGER,
    "social_post_id" INTEGER,
    "content" TEXT,
    "contacted_date" TIMESTAMP(6),

    CONSTRAINT "behance_contacted_pkey" PRIMARY KEY ("contacted_id")
);

-- CreateTable
CREATE TABLE "booking_type" (
    "booking_type_id" SERIAL NOT NULL,
    "booking_type" VARCHAR(100),

    CONSTRAINT "booking_type_pkey" PRIMARY KEY ("booking_type_id")
);

-- CreateTable
CREATE TABLE "calm_category" (
    "calm_category_id" SERIAL NOT NULL,
    "calm_category_name" TEXT,

    CONSTRAINT "calm_category_pkey" PRIMARY KEY ("calm_category_id")
);

-- CreateTable
CREATE TABLE "calm_lesson" (
    "calm_lesson_id" SERIAL NOT NULL,
    "calm_provider_id" INTEGER,
    "lesson_name" TEXT,
    "lesson_description" TEXT,
    "lesson_duration" INTEGER,
    "lesson_price" DOUBLE PRECISION,
    "lesson_trailer_video_url" TEXT,

    CONSTRAINT "calm_lesson_pkey" PRIMARY KEY ("calm_lesson_id")
);

-- CreateTable
CREATE TABLE "calm_lesson_image" (
    "calm_lesson_image_id" SERIAL NOT NULL,
    "calm_lesson_id" INTEGER,
    "image_url" TEXT,

    CONSTRAINT "calm_lesson_image_pkey" PRIMARY KEY ("calm_lesson_image_id")
);

-- CreateTable
CREATE TABLE "calm_lesson_order_buy" (
    "calm_lesson_order_buy_id" SERIAL NOT NULL,
    "calm_lesson_id" INTEGER,
    "user_id" INTEGER,
    "order_time" TIMESTAMP(6),
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "calm_lesson_order_buy_pkey" PRIMARY KEY ("calm_lesson_order_buy_id")
);

-- CreateTable
CREATE TABLE "calm_lesson_parts" (
    "calm_lesson_parts_id" SERIAL NOT NULL,
    "calm_lesson_id" INTEGER,
    "lesson_part_order" INTEGER,
    "content_url" TEXT,
    "part_name" TEXT,
    "part_description" TEXT,
    "part_duration" INTEGER,

    CONSTRAINT "calm_lesson_parts_pkey" PRIMARY KEY ("calm_lesson_parts_id")
);

-- CreateTable
CREATE TABLE "calm_providers" (
    "calm_provider_id" SERIAL NOT NULL,
    "provider_user_id" INTEGER,
    "calm_provider_category_id" INTEGER,

    CONSTRAINT "calm_providers_pkey" PRIMARY KEY ("calm_provider_id")
);

-- CreateTable
CREATE TABLE "cam_post" (
    "cam_post_id" SERIAL NOT NULL,
    "talent_id" INTEGER,
    "avg_duration" INTEGER,
    "description" TEXT,
    "price" DOUBLE PRECISION,

    CONSTRAINT "cam_post_pkey" PRIMARY KEY ("cam_post_id")
);

-- CreateTable
CREATE TABLE "cam_post_image" (
    "cam_post_image_id" SERIAL NOT NULL,
    "cam_post_id" INTEGER,
    "image_url" TEXT,

    CONSTRAINT "cam_post_image_pkey" PRIMARY KEY ("cam_post_image_id")
);

-- CreateTable
CREATE TABLE "cam_post_order" (
    "cam_post_order_id" SERIAL NOT NULL,
    "cam_post_id" INTEGER,
    "user_id" INTEGER,
    "duration" INTEGER,
    "status" TEXT,
    "order_time" TIMESTAMP(6),
    "delivered_time" TIMESTAMP(6),
    "checkout_id" INTEGER,

    CONSTRAINT "cam_post_order_pkey" PRIMARY KEY ("cam_post_order_id")
);

-- CreateTable
CREATE TABLE "candidate" (
    "candidate_id" SERIAL NOT NULL,
    "candidate_user_id" INTEGER,

    CONSTRAINT "candidate_pkey" PRIMARY KEY ("candidate_id")
);

-- CreateTable
CREATE TABLE "carpool_booking" (
    "booking_id" SERIAL NOT NULL,
    "offer_id" INTEGER,
    "passenger_id" INTEGER,
    "seats_booked" INTEGER,
    "total_cost" DOUBLE PRECISION,
    "status" VARCHAR(20),

    CONSTRAINT "carpool_booking_pkey" PRIMARY KEY ("booking_id")
);

-- CreateTable
CREATE TABLE "carpool_offer" (
    "carpool_offer_id" SERIAL NOT NULL,
    "driver_id" INTEGER,
    "vehicle_id" INTEGER,
    "origin_city" VARCHAR(100),
    "destination_city" VARCHAR(100),
    "departure_time" TIMESTAMP(6),
    "price_per_seat" DOUBLE PRECISION,
    "total_seats" INTEGER,
    "available_seats" INTEGER,
    "allow_smoking" BOOLEAN,
    "allow_pets" BOOLEAN,

    CONSTRAINT "carpool_offer_pkey" PRIMARY KEY ("carpool_offer_id")
);

-- CreateTable
CREATE TABLE "carpool_waypoints" (
    "waypoint_id" SERIAL NOT NULL,
    "offer_id" INTEGER,
    "city_name" VARCHAR(100),
    "arrival_time_est" TIMESTAMP(6),
    "pickup_allowed" BOOLEAN,

    CONSTRAINT "carpool_waypoints_pkey" PRIMARY KEY ("waypoint_id")
);

-- CreateTable
CREATE TABLE "categories" (
    "category_id" SERIAL NOT NULL,
    "category_name" VARCHAR(1000),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("category_id")
);

-- CreateTable
CREATE TABLE "chat_channel" (
    "channel_id" SERIAL NOT NULL,
    "type" VARCHAR(20),
    "channel_name" VARCHAR(255),
    "platform_type_id" INTEGER,
    "context_type" VARCHAR(50),
    "context_id" VARCHAR(255),
    "created_by" INTEGER,
    "status" VARCHAR(20) DEFAULT 'active',
    "last_message_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    "dm_key" VARCHAR(255),

    CONSTRAINT "chat_channel_pkey" PRIMARY KEY ("channel_id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "message_id" SERIAL NOT NULL,
    "channel_id" INTEGER,
    "sender_id" INTEGER,
    "content" TEXT,
    "content_type" VARCHAR(255),
    "sent_at" TIMESTAMP(6),
    "is_read" BOOLEAN,
    "platform_type_id" INTEGER,
    "edited_at" TIMESTAMP(6),
    "deleted_at" TIMESTAMP(6),
    "metadata" JSONB,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "chat_participants" (
    "chat_participant_id" SERIAL NOT NULL,
    "channel_id" INTEGER,
    "user_id" INTEGER,
    "role" VARCHAR(20),
    "platform_type_id" INTEGER,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "last_read_message_id" INTEGER,
    "joined_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(6),

    CONSTRAINT "chat_participants_pkey" PRIMARY KEY ("chat_participant_id")
);

-- CreateTable
CREATE TABLE "journal_highlight" (
    "id" SERIAL NOT NULL,
    "channel_id" INTEGER,
    "saved_by" INTEGER,
    "message_id" INTEGER,
    "content" TEXT,
    "content_type" VARCHAR(50),
    "media_url" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_highlight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_bucket_item" (
    "id" SERIAL NOT NULL,
    "channel_id" INTEGER,
    "created_by" INTEGER,
    "title" TEXT,
    "description" TEXT,
    "emoji" VARCHAR(10),
    "category" VARCHAR(50),
    "due_date" TIMESTAMP(6),
    "priority" VARCHAR(10) DEFAULT 'medium',
    "is_completed" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMP(6),
    "completed_by" INTEGER,
    "completion_note" TEXT,
    "completion_media" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "journal_bucket_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_time_capsule" (
    "id" SERIAL NOT NULL,
    "channel_id" INTEGER,
    "created_by" INTEGER,
    "title" TEXT,
    "description" TEXT,
    "cover_url" TEXT,
    "unlock_date" TIMESTAMP(6) NOT NULL,
    "is_unlocked" BOOLEAN NOT NULL DEFAULT false,
    "contents" JSONB,
    "partner_contents" JSONB,
    "partner_id" INTEGER,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_time_capsule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "checkouts" (
    "checkout_id" SERIAL NOT NULL,
    "total" DECIMAL,
    "share_id" INTEGER,
    "date" DATE,
    "category_id" INTEGER,

    CONSTRAINT "checkouts_pkey" PRIMARY KEY ("checkout_id")
);

-- CreateTable
CREATE TABLE "cloth" (
    "cloth_id" SERIAL NOT NULL,
    "cloth_image_url" TEXT,
    "color" TEXT,
    "cloth_category_id" INTEGER,
    "cloth_type_id" INTEGER,
    "user_id" INTEGER,

    CONSTRAINT "cloth_pkey" PRIMARY KEY ("cloth_id")
);

-- CreateTable
CREATE TABLE "cloth_category" (
    "cloth_category_id" SERIAL NOT NULL,
    "cloth_category_name" TEXT,

    CONSTRAINT "cloth_category_pkey" PRIMARY KEY ("cloth_category_id")
);

-- CreateTable
CREATE TABLE "cloth_type" (
    "cloth_type_id" SERIAL NOT NULL,
    "cloth_type_name" TEXT,

    CONSTRAINT "cloth_type_pkey" PRIMARY KEY ("cloth_type_id")
);

-- CreateTable
CREATE TABLE "connections" (
    "connection_id" SERIAL NOT NULL,
    "requester_id" INTEGER,
    "receiver_id" INTEGER,
    "status" VARCHAR(20),
    "accepted_time" TIMESTAMP(6),
    "platform_type_id" INTEGER,

    CONSTRAINT "connections_pkey" PRIMARY KEY ("connection_id")
);

-- CreateTable
CREATE TABLE "courier_customer" (
    "customer_id" SERIAL NOT NULL,
    "user_id" INTEGER,

    CONSTRAINT "courier_customer_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "courier_order" (
    "courier_order_id" SERIAL NOT NULL,
    "customer_id" INTEGER,
    "courier_service_provider_id" INTEGER,
    "start_location_lat" TEXT,
    "start_location_long" TEXT,
    "end_location_lat" TEXT,
    "end_location_long" TEXT,
    "start_location_address" TEXT,
    "end_location_address" TEXT,
    "status" TEXT,
    "pickup_date" TIMESTAMP(6),
    "deliver_date" TIMESTAMP(6),
    "last_update" TIMESTAMP(6),
    "payment_method" TEXT,
    "payment_time" TIMESTAMP(6),
    "is_paid" BOOLEAN,
    "price" DOUBLE PRECISION,
    "checkout_id" INTEGER,

    CONSTRAINT "courier_order_pkey" PRIMARY KEY ("courier_order_id")
);

-- CreateTable
CREATE TABLE "courier_service_provider" (
    "courier_service_provider_id" SERIAL NOT NULL,
    "courier_service_provider_name" TEXT,
    "courier_service_provider_user_id" INTEGER,
    "price_per_km" DOUBLE PRECISION,

    CONSTRAINT "courier_service_provider_pkey" PRIMARY KEY ("courier_service_provider_id")
);

-- CreateTable
CREATE TABLE "cs_categories" (
    "cs_category_id" SERIAL NOT NULL,
    "cs_category_name" TEXT,
    "cs_type_id" INTEGER,

    CONSTRAINT "cs_categories_pkey" PRIMARY KEY ("cs_category_id")
);

-- CreateTable
CREATE TABLE "cs_content" (
    "content_id" SERIAL NOT NULL,
    "content_title" TEXT,
    "content_description" TEXT,
    "content_url" TEXT,
    "author" TEXT,
    "date" TIMESTAMP(6),
    "cover_img_url" TEXT,
    "length" INTEGER,
    "cs_category_id" INTEGER,
    "cs_type_id" INTEGER,

    CONSTRAINT "cs_content_pkey" PRIMARY KEY ("content_id")
);

-- CreateTable
CREATE TABLE "cs_type" (
    "cs_type_id" SERIAL NOT NULL,
    "cs_type_name" TEXT,
    "subscription_price" DOUBLE PRECISION,

    CONSTRAINT "cs_type_pkey" PRIMARY KEY ("cs_type_id")
);

-- CreateTable
CREATE TABLE "cycle_prediction" (
    "prediction_id" SERIAL NOT NULL,
    "flo_user_id" INTEGER,
    "cycle_start_date" TIMESTAMP(6),
    "predicted_period_start" TIMESTAMP(6),
    "predicted_period_end" TIMESTAMP(6),
    "predicted_ovulation_date" TIMESTAMP(6),
    "fertile_window_start" TIMESTAMP(6),
    "fertile_window_end" TIMESTAMP(6),
    "generated_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cycle_prediction_pkey" PRIMARY KEY ("prediction_id")
);

-- CreateTable
CREATE TABLE "delivery_driver" (
    "driver_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "current_lat" DOUBLE PRECISION,
    "current_long" DOUBLE PRECISION,
    "is_online" BOOLEAN,
    "vendor_type_id" INTEGER,

    CONSTRAINT "delivery_driver_pkey" PRIMARY KEY ("driver_id")
);

-- CreateTable
CREATE TABLE "dg_cart" (
    "cart_id" SERIAL NOT NULL,
    "content_id" INTEGER,
    "buyer_id" INTEGER,
    "qty" INTEGER,
    "total" DECIMAL,
    "dg_category_id" INTEGER,

    CONSTRAINT "dg_cart_pkey" PRIMARY KEY ("cart_id")
);

-- CreateTable
CREATE TABLE "dg_categories" (
    "dg_category_id" SERIAL NOT NULL,
    "dg_category_name" TEXT,

    CONSTRAINT "dg_categories_pkey" PRIMARY KEY ("dg_category_id")
);

-- CreateTable
CREATE TABLE "dg_content" (
    "content_id" SERIAL NOT NULL,
    "content_title" TEXT,
    "content_description" TEXT,
    "content_url" TEXT,
    "author" TEXT,
    "price" DOUBLE PRECISION,
    "date" TIMESTAMP(6),
    "dg_category_id" INTEGER,
    "cover_img_url" TEXT,
    "is_international" BOOLEAN DEFAULT false,

    CONSTRAINT "dg_content_pkey" PRIMARY KEY ("content_id")
);

-- CreateTable
CREATE TABLE "dg_order" (
    "order_id" SERIAL NOT NULL,
    "content_id" INTEGER,
    "buyer_id" INTEGER,
    "total" DOUBLE PRECISION,
    "qty" INTEGER,
    "date" DATE,
    "ispaid" BOOLEAN DEFAULT true,
    "payment_method" VARCHAR(255),
    "expire_date" DATE,
    "dg_category_id" INTEGER,
    "checkout_id" INTEGER,
    "payment_intent_id" VARCHAR(255),

    CONSTRAINT "dg_order_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "discord_server" (
    "server_id" SERIAL NOT NULL,
    "server_name" TEXT,
    "server_owner" INTEGER,
    "created_at" TIMESTAMP(6),

    CONSTRAINT "discord_server_pkey" PRIMARY KEY ("server_id")
);

-- CreateTable
CREATE TABLE "discord_stream" (
    "stream_id" SERIAL NOT NULL,
    "server_member_id" INTEGER,
    "is_audio" BOOLEAN,
    "is_video" BOOLEAN,
    "start_time" TIMESTAMP(6),

    CONSTRAINT "discord_stream_pkey" PRIMARY KEY ("stream_id")
);

-- CreateTable
CREATE TABLE "donations" (
    "donation_id" SERIAL NOT NULL,
    "donated_user_id" INTEGER,
    "amount" DOUBLE PRECISION,
    "donated_date" TIMESTAMP(6),
    "project_id" INTEGER,
    "payment_intent_id" VARCHAR(255),
    "payment_status" VARCHAR(20) DEFAULT 'unpaid',
    "reward_tier_id" INTEGER,

    CONSTRAINT "donations_pkey" PRIMARY KEY ("donation_id")
);

-- CreateTable
CREATE TABLE "stripe_orphan_payment" (
    "orphan_id" SERIAL NOT NULL,
    "payment_intent_id" VARCHAR(255) NOT NULL,
    "user_id" INTEGER,
    "amount" DOUBLE PRECISION,
    "currency" VARCHAR(10),
    "purpose" VARCHAR(40),
    "vertical" VARCHAR(40),
    "status" VARCHAR(20) NOT NULL DEFAULT 'unreconciled',
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_orphan_payment_pkey" PRIMARY KEY ("orphan_id")
);

-- CreateTable
CREATE TABLE "driver_profile" (
    "driver_profile_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "license_number" VARCHAR(50),
    "license_expiry" DATE,
    "is_online" BOOLEAN,
    "current_lat" DOUBLE PRECISION,
    "current_long" DOUBLE PRECISION,
    "last_ping" TIMESTAMP(6),
    "rating" DOUBLE PRECISION,
    "booking_type_id" INTEGER,

    CONSTRAINT "driver_profile_pkey" PRIMARY KEY ("driver_profile_id")
);

-- CreateTable
CREATE TABLE "emergency_contact" (
    "emergency_contact_id" SERIAL NOT NULL,
    "employee_id" INTEGER,
    "name" TEXT,
    "relationship" TEXT,
    "phone_number" TEXT,
    "email" TEXT,

    CONSTRAINT "emergency_contact_pkey" PRIMARY KEY ("emergency_contact_id")
);

-- CreateTable
CREATE TABLE "employee_attendance" (
    "employee_attendance_id" SERIAL NOT NULL,
    "employee_id" INTEGER,
    "clock_in" TIMESTAMP(6),
    "clock_out" TIMESTAMP(6),

    CONSTRAINT "employee_attendance_pkey" PRIMARY KEY ("employee_attendance_id")
);

-- CreateTable
CREATE TABLE "employees" (
    "employee_id" SERIAL NOT NULL,
    "employee_user_id" INTEGER,
    "employee_name" TEXT,
    "employee_dob" DATE,
    "employee_email" TEXT,
    "employee_gender" TEXT,
    "employee_phone_number" TEXT,
    "employee_address" TEXT,
    "employee_city" TEXT,
    "employee_state" TEXT,
    "employee_province" TEXT,
    "employee_zip_code" TEXT,
    "employee_job_title" TEXT,
    "employee_employment_status" TEXT,
    "employee_salary" DOUBLE PRECISION,

    CONSTRAINT "employees_pkey" PRIMARY KEY ("employee_id")
);

-- CreateTable
CREATE TABLE "event_type" (
    "event_type_id" SERIAL NOT NULL,
    "event_type_name" TEXT,

    CONSTRAINT "event_type_pkey" PRIMARY KEY ("event_type_id")
);

-- CreateTable
CREATE TABLE "flash_card" (
    "flash_card_id" SERIAL NOT NULL,
    "flash_card_topic" TEXT,
    "flash_card_question" TEXT,
    "flash_card_answer" TEXT,
    "flash_card_category_id" INTEGER,
    "flash_card_creator" INTEGER,
    "flash_card_deck_id" INTEGER,

    CONSTRAINT "flash_card_pkey" PRIMARY KEY ("flash_card_id")
);

-- CreateTable
CREATE TABLE "flash_card_category" (
    "flash_card_category_id" SERIAL NOT NULL,
    "flash_card_category_name" TEXT,
    "flash_card_category_description" TEXT,
    "flash_card_category_image" TEXT,

    CONSTRAINT "flash_card_category_pkey" PRIMARY KEY ("flash_card_category_id")
);

-- CreateTable
CREATE TABLE "flash_card_deck" (
    "flash_card_deck_id" SERIAL NOT NULL,
    "flash_card_deck_name" TEXT,
    "flash_card_deck_description" TEXT,
    "flash_card_deck_category_id" INTEGER,
    "flash_card_deck_creator" INTEGER,

    CONSTRAINT "flash_card_deck_pkey" PRIMARY KEY ("flash_card_deck_id")
);

-- CreateTable
CREATE TABLE "flash_card_deck_user" (
    "flash_card_deck_user_id" SERIAL NOT NULL,
    "flash_card_deck_id" INTEGER,
    "user_id" INTEGER,
    "is_complete" BOOLEAN,

    CONSTRAINT "flash_card_deck_user_pkey" PRIMARY KEY ("flash_card_deck_user_id")
);

-- CreateTable
CREATE TABLE "flash_card_user_do" (
    "flash_card_user_do_id" SERIAL NOT NULL,
    "flash_card_id" INTEGER,
    "user_id" INTEGER,
    "rating" INTEGER,
    "no_of_appearance" INTEGER,

    CONSTRAINT "flash_card_user_do_pkey" PRIMARY KEY ("flash_card_user_do_id")
);

-- CreateTable
CREATE TABLE "flo_user" (
    "flo_user_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "avg_cycle_length" INTEGER DEFAULT 28,
    "avg_period_length" INTEGER DEFAULT 5,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flo_user_pkey" PRIMARY KEY ("flo_user_id")
);

-- CreateTable
CREATE TABLE "food_category" (
    "food_category_id" SERIAL NOT NULL,
    "vendor_id" INTEGER,
    "name" VARCHAR(100),
    "sort_order" INTEGER,
    "vendor_type_id" INTEGER,

    CONSTRAINT "food_category_pkey" PRIMARY KEY ("food_category_id")
);

-- CreateTable
CREATE TABLE "food_item" (
    "food_item_id" SERIAL NOT NULL,
    "vendor_id" INTEGER,
    "food_category_id" INTEGER,
    "name" VARCHAR(255),
    "description" TEXT,
    "price" DOUBLE PRECISION,
    "is_available" BOOLEAN,
    "stock_qty" INTEGER,
    "vendor_type_id" INTEGER,
    "allergen_info" TEXT,

    CONSTRAINT "food_item_pkey" PRIMARY KEY ("food_item_id")
);

-- CreateTable
CREATE TABLE "food_item_modifier_group" (
    "group_id" SERIAL NOT NULL,
    "food_item_id" INTEGER,
    "name" VARCHAR(255),
    "min_select" INTEGER DEFAULT 0,
    "max_select" INTEGER,
    "sort_order" INTEGER DEFAULT 0,

    CONSTRAINT "food_item_modifier_group_pkey" PRIMARY KEY ("group_id")
);

-- CreateTable
CREATE TABLE "food_item_modifier_option" (
    "option_id" SERIAL NOT NULL,
    "group_id" INTEGER,
    "name" VARCHAR(255),
    "price" DOUBLE PRECISION DEFAULT 0,
    "is_available" BOOLEAN DEFAULT true,
    "sort_order" INTEGER DEFAULT 0,

    CONSTRAINT "food_item_modifier_option_pkey" PRIMARY KEY ("option_id")
);

-- CreateTable
CREATE TABLE "food_item_pics" (
    "food_item_pics_id" SERIAL NOT NULL,
    "food_item_id" INTEGER,
    "url" TEXT,
    "vendor_type_id" INTEGER,

    CONSTRAINT "food_item_pics_pkey" PRIMARY KEY ("food_item_pics_id")
);

-- CreateTable
CREATE TABLE "food_order" (
    "food_order_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "vendor_id" INTEGER,
    "driver_id" INTEGER,
    "order_status" VARCHAR(50),
    "total_amount" DOUBLE PRECISION,
    "delivery_fee" DOUBLE PRECISION,
    "platform_fee" DOUBLE PRECISION,
    "created_at" TIMESTAMP(6),
    "delivered_at" TIMESTAMP(6),
    "deliver_location" TEXT,
    "vendor_type_id" INTEGER,
    "otp_code" VARCHAR(4),
    "ispaid" BOOLEAN DEFAULT false,
    "payment_method" VARCHAR(100),
    "last_update" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "delivery_instructions" TEXT,
    "scheduled_time" TIMESTAMP(6),
    "payment_intent_id" VARCHAR(255),

    CONSTRAINT "food_order_pkey" PRIMARY KEY ("food_order_id")
);

-- CreateTable
CREATE TABLE "food_order_items" (
    "food_order_detail_id" SERIAL NOT NULL,
    "order_id" INTEGER,
    "food_item_id" INTEGER,
    "qty" INTEGER,
    "price_item" DOUBLE PRECISION,
    "special_instructions" TEXT,
    "vendor_type_id" INTEGER,

    CONSTRAINT "food_order_items_pkey" PRIMARY KEY ("food_order_detail_id")
);

-- CreateTable
CREATE TABLE "food_vendor" (
    "vendor_id" SERIAL NOT NULL,
    "owner_id" INTEGER,
    "vendor_name" VARCHAR(255),
    "cuisine_type" VARCHAR(100),
    "is_open" BOOLEAN DEFAULT false,
    "min_order_value" DOUBLE PRECISION,
    "location" TEXT,
    "vendor_type_id" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "closing_hours" VARCHAR(20),
    "is_paused" BOOLEAN DEFAULT false,
    "opening_hours" VARCHAR(20),
    "lat" DOUBLE PRECISION,
    "long" DOUBLE PRECISION,
    "logo_url" VARCHAR(1000),
    "cover_url" VARCHAR(1000),

    CONSTRAINT "food_vendor_pkey" PRIMARY KEY ("vendor_id")
);

-- CreateTable
CREATE TABLE "hire_influencer" (
    "hire_influencer_id" SERIAL NOT NULL,
    "influencer_id" INTEGER,
    "user_id" INTEGER,
    "hire_influencer_description" TEXT,
    "hire_influencer_date" TIMESTAMP(6),

    CONSTRAINT "hire_influencer_pkey" PRIMARY KEY ("hire_influencer_id")
);

-- CreateTable
CREATE TABLE "influencer" (
    "influencer_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "influencer_description" TEXT,
    "influencer_image_url" TEXT,

    CONSTRAINT "influencer_pkey" PRIMARY KEY ("influencer_id")
);

-- CreateTable
CREATE TABLE "job_application" (
    "job_application_id" SERIAL NOT NULL,
    "job_id" INTEGER,
    "candidate_id" INTEGER,
    "cv_url" TEXT,
    "application_date" TIMESTAMP(6),

    CONSTRAINT "job_application_pkey" PRIMARY KEY ("job_application_id")
);

-- CreateTable
CREATE TABLE "job_categories" (
    "job_category_id" SERIAL NOT NULL,
    "job_category_name" TEXT,
    "job_category_image_url" TEXT,

    CONSTRAINT "job_categories_pkey" PRIMARY KEY ("job_category_id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "job_id" SERIAL NOT NULL,
    "job_name" TEXT,
    "description" TEXT,
    "job_category_id" INTEGER,
    "posted_date" TIMESTAMP(6),
    "deadline" TIMESTAMP(6),
    "agent_id" INTEGER,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("job_id")
);

-- CreateTable
CREATE TABLE "kickstarter_category" (
    "category_id" SERIAL NOT NULL,
    "category_name" TEXT,

    CONSTRAINT "kickstarter_category_pkey" PRIMARY KEY ("category_id")
);

-- CreateTable
CREATE TABLE "language" (
    "language_id" SERIAL NOT NULL,
    "language_name" TEXT,

    CONSTRAINT "language_pkey" PRIMARY KEY ("language_id")
);

-- CreateTable
CREATE TABLE "leave" (
    "leave_id" SERIAL NOT NULL,
    "employee_id" INTEGER,
    "from_date" DATE,
    "to_date" DATE,
    "type" TEXT,
    "status" TEXT,
    "rejection_reason" TEXT,

    CONSTRAINT "leave_pkey" PRIMARY KEY ("leave_id")
);

-- CreateTable
CREATE TABLE "lesson" (
    "lesson_id" SERIAL NOT NULL,
    "lesson_name" TEXT,
    "language_id" INTEGER,
    "level" TEXT,

    CONSTRAINT "lesson_pkey" PRIMARY KEY ("lesson_id")
);

-- CreateTable
CREATE TABLE "lesson_user" (
    "lesson_user_id" SERIAL NOT NULL,
    "lesson_id" INTEGER,
    "user_id" INTEGER,
    "is_complete" BOOLEAN,

    CONSTRAINT "lesson_user_pkey" PRIMARY KEY ("lesson_user_id")
);

-- CreateTable
CREATE TABLE "loan_payment" (
    "loan_payment_id" SERIAL NOT NULL,
    "loan_id" INTEGER,
    "amount_paid" DOUBLE PRECISION,
    "date" TIMESTAMP(6),

    CONSTRAINT "loan_payment_pkey" PRIMARY KEY ("loan_payment_id")
);

-- CreateTable
CREATE TABLE "loan_provider" (
    "loan_provider_id" SERIAL NOT NULL,
    "description" TEXT,
    "user_id" INTEGER,

    CONSTRAINT "loan_provider_pkey" PRIMARY KEY ("loan_provider_id")
);

-- CreateTable
CREATE TABLE "loans" (
    "loan_id" SERIAL NOT NULL,
    "property_id" INTEGER,
    "user_id" INTEGER,
    "loan_provider_id" INTEGER,
    "loan_amount" DOUBLE PRECISION,
    "loan_term" INTEGER,
    "interest_rate" DOUBLE PRECISION,
    "status" TEXT,
    "created_at" TIMESTAMP(6),

    CONSTRAINT "loans_pkey" PRIMARY KEY ("loan_id")
);

-- CreateTable
CREATE TABLE "meetup_attendees" (
    "meetup_attendees_id" SERIAL NOT NULL,
    "meetup_event_id" INTEGER,
    "user_id" INTEGER,
    "role" TEXT,

    CONSTRAINT "meetup_attendees_pkey" PRIMARY KEY ("meetup_attendees_id")
);

-- CreateTable
CREATE TABLE "meetup_category" (
    "meetup_category_id" SERIAL NOT NULL,
    "meetup_category_name" TEXT,

    CONSTRAINT "meetup_category_pkey" PRIMARY KEY ("meetup_category_id")
);

-- CreateTable
CREATE TABLE "meetup_event" (
    "meetup_event_id" SERIAL NOT NULL,
    "meetup_event_name" TEXT,
    "meetup_event_description" TEXT,
    "meetup_event_duration" INTEGER,
    "meetup_event_price" DOUBLE PRECISION,
    "meetup_event_category_id" INTEGER,
    "meetup_event_start_time" TIMESTAMP(6),
    "meetup_event_location" TEXT,
    "meetup_event_organizer" INTEGER,
    "meetup_event_max_attendees" INTEGER,

    CONSTRAINT "meetup_event_pkey" PRIMARY KEY ("meetup_event_id")
);

-- CreateTable
CREATE TABLE "meetup_event_image" (
    "meetup_event_image_id" SERIAL NOT NULL,
    "meetup_event_id" INTEGER,
    "image_url" TEXT,

    CONSTRAINT "meetup_event_image_pkey" PRIMARY KEY ("meetup_event_image_id")
);

-- CreateTable
CREATE TABLE "payrolls" (
    "payroll_id" SERIAL NOT NULL,
    "employee_id" INTEGER,
    "net_salary" DOUBLE PRECISION,
    "epf" BOOLEAN,
    "etf" BOOLEAN,
    "epf_amount" DOUBLE PRECISION,
    "etf_amount" DOUBLE PRECISION,
    "status" TEXT,
    "tax_percentage" DOUBLE PRECISION,
    "ot" DOUBLE PRECISION,
    "bonus" DOUBLE PRECISION,

    CONSTRAINT "payrolls_pkey" PRIMARY KEY ("payroll_id")
);

-- CreateTable
CREATE TABLE "period" (
    "period_id" SERIAL NOT NULL,
    "flo_user_id" INTEGER,
    "start_date" TIMESTAMP(6),
    "end_date" TIMESTAMP(6),
    "created_at" TIMESTAMP(6),

    CONSTRAINT "period_pkey" PRIMARY KEY ("period_id")
);

-- CreateTable
CREATE TABLE "place" (
    "place_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "location_lat" TEXT,
    "location_long" TEXT,
    "location_address" TEXT,
    "location_place_id" TEXT,
    "price_per_hour" DOUBLE PRECISION,
    "description" TEXT,
    "event_type_id" INTEGER,
    "instant_booking" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "place_pkey" PRIMARY KEY ("place_id")
);

-- CreateTable
CREATE TABLE "place_orders" (
    "place_order_id" SERIAL NOT NULL,
    "place_id" INTEGER,
    "user_id" INTEGER,
    "no_of_hours" INTEGER,
    "price" DOUBLE PRECISION,
    "is_available" BOOLEAN,
    "reserve_date" TIMESTAMP(6),
    "time_from" TEXT,
    "time_to" TEXT,
    "note" TEXT,
    "event_type_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "place_orders_pkey" PRIMARY KEY ("place_order_id")
);

-- CreateTable
CREATE TABLE "place_pics" (
    "place_pics_id" SERIAL NOT NULL,
    "place_id" INTEGER,
    "place_pic_url" TEXT,
    "event_type_id" INTEGER,

    CONSTRAINT "place_pics_pkey" PRIMARY KEY ("place_pics_id")
);

-- CreateTable
CREATE TABLE "platform_type" (
    "platform_type_id" SERIAL NOT NULL,
    "platform_type" VARCHAR(50),

    CONSTRAINT "platform_type_pkey" PRIMARY KEY ("platform_type_id")
);

-- CreateTable
CREATE TABLE "product_cart" (
    "cart_id" SERIAL NOT NULL,
    "seller_id" INTEGER,
    "buyer_id" INTEGER,
    "variation_id" INTEGER,
    "qty" INTEGER,
    "total" DECIMAL,
    "product_type_id" INTEGER,

    CONSTRAINT "product_cart_pkey" PRIMARY KEY ("cart_id")
);

-- CreateTable
CREATE TABLE "product_listing" (
    "listing_id" SERIAL NOT NULL,
    "name" VARCHAR(500),
    "description" TEXT,
    "availability" INTEGER,
    "product_type_id" INTEGER,
    "seller_id" INTEGER,
    "image_url" TEXT,

    CONSTRAINT "product_listing_pkey" PRIMARY KEY ("listing_id")
);

-- CreateTable
CREATE TABLE "product_order" (
    "order_id" SERIAL NOT NULL,
    "seller_id" INTEGER,
    "buyer_id" INTEGER,
    "variation_id" INTEGER,
    "total" DOUBLE PRECISION,
    "qty" INTEGER,
    "date" DATE,
    "ispaid" BOOLEAN DEFAULT true,
    "payment_method" VARCHAR(255),
    "product_type_id" INTEGER,
    "order_time" TIMESTAMP(6),
    "checkout_id" INTEGER,
    "status" VARCHAR(50) DEFAULT 'pending',
    "tracking_number" VARCHAR(255),
    "payment_intent_id" VARCHAR(255),
    "driver_id" INTEGER,
    "delivery_lat" DOUBLE PRECISION,
    "delivery_lng" DOUBLE PRECISION,
    "delivery_address" VARCHAR(1000),
    "delivery_instructions" VARCHAR(1000),
    "delivery_fee" DOUBLE PRECISION DEFAULT 0,
    "platform_fee" DOUBLE PRECISION DEFAULT 0,
    "tax" DOUBLE PRECISION DEFAULT 0,

    CONSTRAINT "product_order_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "product_ratings" (
    "rating_id" SERIAL NOT NULL,
    "seller_id" INTEGER,
    "order_id" INTEGER,
    "buyer_id" INTEGER,
    "rating" INTEGER,
    "feedback" TEXT,
    "product_type_id" INTEGER,

    CONSTRAINT "product_ratings_pkey" PRIMARY KEY ("rating_id")
);

-- CreateTable
CREATE TABLE "product_type" (
    "product_type_id" SERIAL NOT NULL,
    "product_type_name" VARCHAR(255),

    CONSTRAINT "product_type_pkey" PRIMARY KEY ("product_type_id")
);

-- CreateTable
CREATE TABLE "product_variation" (
    "variation_id" SERIAL NOT NULL,
    "listing_id" INTEGER,
    "price" DOUBLE PRECISION,
    "description" TEXT,
    "vname" TEXT,
    "image_url" TEXT,
    "product_type_id" INTEGER,
    "discount_pct" DOUBLE PRECISION,

    CONSTRAINT "product_variation_pkey" PRIMARY KEY ("variation_id")
);

-- CreateTable
CREATE TABLE "professional_profile" (
    "prof_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "headline" VARCHAR(255),
    "resume_url" TEXT,
    "open_to_work" BOOLEAN,
    "created_at" TIMESTAMP(6),
    "platform_type_id" INTEGER,

    CONSTRAINT "professional_profile_pkey" PRIMARY KEY ("prof_id")
);

-- CreateTable
CREATE TABLE "projects" (
    "project_id" SERIAL NOT NULL,
    "project_name" TEXT,
    "owner_user_id" INTEGER,
    "title" TEXT,
    "description" TEXT,
    "expected_amount" DOUBLE PRECISION,
    "posted_date" TIMESTAMP(6),
    "current_amount" DOUBLE PRECISION,
    "deadline" TIMESTAMP(6),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("project_id")
);

-- CreateTable
CREATE TABLE "reward_tier" (
    "tier_id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "title" VARCHAR(255),
    "description" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "reward_description" TEXT,
    "quantity_limit" INTEGER,
    "claimed_count" INTEGER NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reward_tier_pkey" PRIMARY KEY ("tier_id")
);

-- CreateTable
CREATE TABLE "campaign_update" (
    "update_id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "title" VARCHAR(255),
    "body" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_update_pkey" PRIMARY KEY ("update_id")
);

-- CreateTable
CREATE TABLE "campaign_payout" (
    "payout_id" SERIAL NOT NULL,
    "project_id" INTEGER NOT NULL,
    "owner_user_id" INTEGER NOT NULL,
    "gross_amount" DOUBLE PRECISION NOT NULL,
    "fee_amount" DOUBLE PRECISION NOT NULL,
    "net_amount" DOUBLE PRECISION NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'completed',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_payout_pkey" PRIMARY KEY ("payout_id")
);

-- CreateTable
CREATE TABLE "property" (
    "property_id" SERIAL NOT NULL,
    "estimated_value" DOUBLE PRECISION,
    "user_id" INTEGER,
    "type" TEXT,
    "address" TEXT,
    "image" TEXT,
    "property_name" TEXT,
    "description" TEXT,
    "status" TEXT,
    "vertical" VARCHAR(40),

    CONSTRAINT "property_pkey" PRIMARY KEY ("property_id")
);

-- CreateTable
CREATE TABLE "question_answer_user" (
    "question_answer_user_id" SERIAL NOT NULL,
    "question_option_id" INTEGER,
    "question_option_answer_id" INTEGER,
    "user_id" INTEGER,
    "is_correct" BOOLEAN,

    CONSTRAINT "question_answer_user_pkey" PRIMARY KEY ("question_answer_user_id")
);

-- CreateTable
CREATE TABLE "question_option" (
    "question_option_id" SERIAL NOT NULL,
    "lesson_id" INTEGER,
    "question" TEXT,

    CONSTRAINT "question_option_pkey" PRIMARY KEY ("question_option_id")
);

-- CreateTable
CREATE TABLE "question_option_answer" (
    "question_option_answer_id" SERIAL NOT NULL,
    "question_option_id" INTEGER,
    "answer" TEXT,
    "is_correct" BOOLEAN,

    CONSTRAINT "question_option_answer_pkey" PRIMARY KEY ("question_option_answer_id")
);

-- CreateTable
CREATE TABLE "rental_cart" (
    "cart_id" SERIAL NOT NULL,
    "rental_listing_id" INTEGER,
    "buyer_id" INTEGER,
    "qty" INTEGER,
    "total" DECIMAL,
    "rental_type_id" INTEGER,

    CONSTRAINT "rental_cart_pkey" PRIMARY KEY ("cart_id")
);

-- CreateTable
CREATE TABLE "rental_categories" (
    "rental_category_id" SERIAL NOT NULL,
    "rental_category_name" VARCHAR(1000),
    "rental_type_id" INTEGER,

    CONSTRAINT "rental_categories_pkey" PRIMARY KEY ("rental_category_id")
);

-- CreateTable
CREATE TABLE "rental_listing" (
    "rental_listing_id" SERIAL NOT NULL,
    "rental_category_id" INTEGER,
    "rental_listing_name" TEXT,
    "owner_id" INTEGER,
    "description" TEXT,
    "amount" DOUBLE PRECISION,
    "duration" INTEGER,
    "is_available" BOOLEAN,
    "location" TEXT,
    "rental_type_id" INTEGER,
    "instant_booking" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "rental_listing_pkey" PRIMARY KEY ("rental_listing_id")
);

-- CreateTable
CREATE TABLE "rental_listing_pics" (
    "rental_pics_id" SERIAL NOT NULL,
    "rental_listing_id" INTEGER,
    "url" TEXT,
    "rental_type_id" INTEGER,

    CONSTRAINT "rental_listing_pics_pkey" PRIMARY KEY ("rental_pics_id")
);

-- CreateTable
CREATE TABLE "rental_order" (
    "order_id" SERIAL NOT NULL,
    "rental_listing_id" INTEGER,
    "buyer_id" INTEGER,
    "total" DOUBLE PRECISION,
    "qty" INTEGER,
    "date" DATE,
    "ispaid" BOOLEAN DEFAULT true,
    "payment_method" VARCHAR(255),
    "expire_date" DATE,
    "rental_type_id" INTEGER,
    "checkout_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "rental_order_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "rental_ratings" (
    "rating_id" SERIAL NOT NULL,
    "order_id" INTEGER,
    "buyer_id" INTEGER,
    "rating" INTEGER,
    "feedback" TEXT,
    "rental_type_id" INTEGER,

    CONSTRAINT "rental_ratings_pkey" PRIMARY KEY ("rating_id")
);

-- CreateTable
CREATE TABLE "rental_type" (
    "rental_type_id" SERIAL NOT NULL,
    "rental_type_name" VARCHAR(255),

    CONSTRAINT "rental_type_pkey" PRIMARY KEY ("rental_type_id")
);

-- CreateTable
CREATE TABLE "ride_request" (
    "ride_request_id" SERIAL NOT NULL,
    "passenger_id" INTEGER,
    "pickup_lat" DOUBLE PRECISION,
    "pickup_long" DOUBLE PRECISION,
    "pickup_address" TEXT,
    "drop_lat" DOUBLE PRECISION,
    "drop_long" DOUBLE PRECISION,
    "drop_address" TEXT,
    "requested_type_id" INTEGER,
    "status" VARCHAR(20),
    "created_at" TIMESTAMP(6),
    "declined_driver_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "assigned_driver_id" INTEGER,
    "offer_expires_at" TIMESTAMP(6),
    "offered_fare" DOUBLE PRECISION,
    "estimated_fare" DOUBLE PRECISION,
    "cancellation_reason" TEXT,

    CONSTRAINT "ride_request_pkey" PRIMARY KEY ("ride_request_id")
);

-- CreateTable
CREATE TABLE "server_members" (
    "server_member_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "server_id" INTEGER,

    CONSTRAINT "server_members_pkey" PRIMARY KEY ("server_member_id")
);

-- CreateTable
CREATE TABLE "server_message" (
    "server_message_id" SERIAL NOT NULL,
    "server_id" INTEGER,
    "message" TEXT,
    "sender_user_id" INTEGER,
    "sent_time" TIMESTAMP(6),

    CONSTRAINT "server_message_pkey" PRIMARY KEY ("server_message_id")
);

-- CreateTable
CREATE TABLE "service_cart" (
    "cart_id" SERIAL NOT NULL,
    "provider_id" INTEGER,
    "buyer_id" INTEGER,
    "qty" INTEGER,
    "total" DECIMAL,
    "service_type_id" INTEGER,

    CONSTRAINT "service_cart_pkey" PRIMARY KEY ("cart_id")
);

-- CreateTable
CREATE TABLE "service_category" (
    "service_category_id" SERIAL NOT NULL,
    "service_category_name" VARCHAR(1000),
    "service_type_id" INTEGER,

    CONSTRAINT "service_category_pkey" PRIMARY KEY ("service_category_id")
);

-- CreateTable
CREATE TABLE "service_cv" (
    "cv_to_provider_id" SERIAL NOT NULL,
    "provider_id" INTEGER,
    "url" TEXT,
    "service_type_id" INTEGER,

    CONSTRAINT "service_cv_pkey" PRIMARY KEY ("cv_to_provider_id")
);

-- CreateTable
CREATE TABLE "service_order" (
    "order_id" SERIAL NOT NULL,
    "provider_id" INTEGER,
    "buyer_id" INTEGER,
    "total" DOUBLE PRECISION,
    "qty" INTEGER,
    "date" DATE,
    "ispaid" BOOLEAN DEFAULT true,
    "payment_method" VARCHAR(255),
    "expire_date" DATE,
    "service_type_id" INTEGER,
    "note" TEXT,
    "checkout_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "declined_provider_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "deliver_lat" DOUBLE PRECISION,
    "deliver_long" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "service_order_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "service_ratings" (
    "rating_id" SERIAL NOT NULL,
    "provider_id" INTEGER,
    "order_id" INTEGER,
    "buyer_id" INTEGER,
    "rating" INTEGER,
    "feedback" TEXT,
    "service_type_id" INTEGER,

    CONSTRAINT "service_ratings_pkey" PRIMARY KEY ("rating_id")
);

-- CreateTable
CREATE TABLE "service_type" (
    "service_type_id" SERIAL NOT NULL,
    "service_type_name" VARCHAR(255),

    CONSTRAINT "service_type_pkey" PRIMARY KEY ("service_type_id")
);

-- CreateTable
CREATE TABLE "services" (
    "services_id" SERIAL NOT NULL,
    "service_name" VARCHAR(1000),
    "amount" DECIMAL,
    "duration" INTEGER,
    "description" TEXT,
    "service_category_id" INTEGER,
    "expire_duration" INTEGER,
    "service_type_id" INTEGER,

    CONSTRAINT "services_pkey" PRIMARY KEY ("services_id")
);

-- CreateTable
CREATE TABLE "shared_ref_code" (
    "share_id" SERIAL NOT NULL,
    "shared_to" INTEGER,
    "ref_code" VARCHAR(1000),

    CONSTRAINT "shared_ref_code_pkey" PRIMARY KEY ("share_id")
);

-- CreateTable
CREATE TABLE "shift" (
    "shift_id" SERIAL NOT NULL,
    "employee_id" INTEGER,
    "from_time" TIME(6),
    "to_time" TIME(6),

    CONSTRAINT "shift_pkey" PRIMARY KEY ("shift_id")
);

-- CreateTable
CREATE TABLE "social_comments" (
    "comment_id" SERIAL NOT NULL,
    "social_post_id" INTEGER,
    "profile_id" INTEGER,
    "parent_comment_id" INTEGER,
    "text" TEXT,
    "timestamp" TIMESTAMP(6),
    "platform_type_id" INTEGER,

    CONSTRAINT "social_comments_pkey" PRIMARY KEY ("comment_id")
);

-- CreateTable
CREATE TABLE "social_feed" (
    "social_post_id" SERIAL NOT NULL,
    "profile_id" INTEGER,
    "caption_text" TEXT,
    "status" TEXT NOT NULL DEFAULT 'published',
    "location_lat" DOUBLE PRECISION,
    "location_long" DOUBLE PRECISION,
    "location_name" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platform_type_id" INTEGER,
    "is_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "community_id" INTEGER,

    CONSTRAINT "social_feed_pkey" PRIMARY KEY ("social_post_id")
);

-- CreateTable
CREATE TABLE "social_interactions" (
    "interaction_id" SERIAL NOT NULL,
    "social_post_id" INTEGER,
    "profile_id" INTEGER,
    "reaction_type" VARCHAR(20),
    "platform_type_id" INTEGER,

    CONSTRAINT "social_interactions_pkey" PRIMARY KEY ("interaction_id")
);

-- CreateTable
CREATE TABLE "social_media_attachments" (
    "attachment_id" SERIAL NOT NULL,
    "social_post_id" INTEGER,
    "media_url" TEXT,
    "media_type" VARCHAR(500),
    "sequence_order" INTEGER,
    "platform_type_id" INTEGER,

    CONSTRAINT "social_media_attachments_pkey" PRIMARY KEY ("attachment_id")
);

-- CreateTable
CREATE TABLE "stream" (
    "stream_id" SERIAL NOT NULL,
    "stream_name" TEXT,
    "start_time" TIMESTAMP(6),
    "description" TEXT,
    "streamer_id" INTEGER,
    "stream_url" TEXT,
    "is_ended" BOOLEAN,
    "end_time" TIMESTAMP(6),

    CONSTRAINT "stream_pkey" PRIMARY KEY ("stream_id")
);

-- CreateTable
CREATE TABLE "stream_category" (
    "stream_category_id" SERIAL NOT NULL,
    "stream_category_name" TEXT,

    CONSTRAINT "stream_category_pkey" PRIMARY KEY ("stream_category_id")
);

-- CreateTable
CREATE TABLE "stream_chat" (
    "stream_chat_id" SERIAL NOT NULL,
    "stream_id" INTEGER,
    "message" TEXT,
    "sent_time" TIMESTAMP(6),
    "user_id" INTEGER,

    CONSTRAINT "stream_chat_pkey" PRIMARY KEY ("stream_chat_id")
);

-- CreateTable
CREATE TABLE "streamer" (
    "streamer_id" SERIAL NOT NULL,
    "streamer_user_id" INTEGER,
    "is_save" BOOLEAN,

    CONSTRAINT "streamer_pkey" PRIMARY KEY ("streamer_id")
);

-- CreateTable
CREATE TABLE "symptom_log" (
    "symptom_log_id" SERIAL NOT NULL,
    "flo_user_id" INTEGER,
    "symptom_type_id" INTEGER,
    "date" TIMESTAMP(6),

    CONSTRAINT "symptom_log_pkey" PRIMARY KEY ("symptom_log_id")
);

-- CreateTable
CREATE TABLE "symptom_types" (
    "symptom_type_id" SERIAL NOT NULL,
    "symptom_name" TEXT,

    CONSTRAINT "symptom_types_pkey" PRIMARY KEY ("symptom_type_id")
);

-- CreateTable
CREATE TABLE "talent" (
    "talent_id" SERIAL NOT NULL,
    "talent_user_id" INTEGER,
    "talent_description" TEXT,
    "profile_image_url" TEXT,
    "talent_category_id" INTEGER,

    CONSTRAINT "talent_pkey" PRIMARY KEY ("talent_id")
);

-- CreateTable
CREATE TABLE "talent_category" (
    "talent_category_id" SERIAL NOT NULL,
    "talent_category_name" TEXT,

    CONSTRAINT "talent_category_pkey" PRIMARY KEY ("talent_category_id")
);

-- CreateTable
CREATE TABLE "user" (
    "user_id" SERIAL NOT NULL,
    "name" VARCHAR(1000),
    "email" VARCHAR(1000),
    "password" VARCHAR(2000),
    "currency" VARCHAR(1000) DEFAULT 'CAD',
    "country" VARCHAR(2000),
    "city" VARCHAR(2000),
    "ref_code" VARCHAR(1000),
    "language" TEXT DEFAULT 'en',
    "is_seller" BOOLEAN NOT NULL DEFAULT false,
    "saved_address" VARCHAR(2000),
    "saved_lat" DOUBLE PRECISION,
    "saved_long" DOUBLE PRECISION,
    "username" VARCHAR(255),
    "is_creator" BOOLEAN NOT NULL DEFAULT false,
    "password_changed_at" TIMESTAMP(3),
    "role" "Role" NOT NULL DEFAULT 'USER',
    "has_seen_welcome" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "account_status" VARCHAR(16) NOT NULL DEFAULT 'active',
    "status_reason" TEXT,
    "status_changed_at" TIMESTAMP(3),
    "status_changed_by" INTEGER,
    "sessions_invalidated_at" TIMESTAMP(3),

    CONSTRAINT "user_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "user_content_subscription_mapping" (
    "user_content_subscription_mapping_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "cs_type_id" INTEGER,
    "is_paid" BOOLEAN,
    "expire_date" TIMESTAMP(6),

    CONSTRAINT "user_content_subscription_mapping_pkey" PRIMARY KEY ("user_content_subscription_mapping_id")
);

-- CreateTable
CREATE TABLE "user_service_provider" (
    "provider_id" SERIAL NOT NULL,
    "services_id" INTEGER,
    "user_id" INTEGER,
    "service_type_id" INTEGER,
    "current_lat" DOUBLE PRECISION,
    "current_long" DOUBLE PRECISION,
    "declined_order_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "last_ping" TIMESTAMP(3),
    "service_category_id" INTEGER,

    CONSTRAINT "user_service_provider_pkey" PRIMARY KEY ("provider_id")
);

-- CreateTable
CREATE TABLE "community" (
    "community_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL DEFAULT 'General',
    "color" TEXT NOT NULL DEFAULT '#2563eb',
    "icon" TEXT NOT NULL,
    "created_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_pkey" PRIMARY KEY ("community_id")
);

-- CreateTable
CREATE TABLE "community_member" (
    "id" SERIAL NOT NULL,
    "community_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_posts" (
    "community_post_id" SERIAL NOT NULL,
    "community_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "upvotes" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_posts_pkey" PRIMARY KEY ("community_post_id")
);

-- CreateTable
CREATE TABLE "community_post_comment" (
    "comment_id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "upvotes" INTEGER NOT NULL DEFAULT 0,
    "parent_id" INTEGER,

    CONSTRAINT "community_post_comment_pkey" PRIMARY KEY ("comment_id")
);

-- CreateTable
CREATE TABLE "community_post_vote" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "post_id" INTEGER NOT NULL,
    "vote_type" INTEGER NOT NULL,

    CONSTRAINT "community_post_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_comment_vote" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "comment_id" INTEGER NOT NULL,
    "vote_type" INTEGER NOT NULL,

    CONSTRAINT "community_comment_vote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_post_save" (
    "user_id" INTEGER NOT NULL,
    "post_id" INTEGER NOT NULL,
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "saved_item" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "entity_type" VARCHAR(40) NOT NULL,
    "entity_id" VARCHAR(128) NOT NULL,
    "meta" JSONB,
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pin" (
    "pin_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "category" VARCHAR(60),
    "image_url" TEXT,
    "target_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pin_pkey" PRIMARY KEY ("pin_id")
);

-- CreateTable
CREATE TABLE "pin_save" (
    "pin_save_id" SERIAL NOT NULL,
    "pin_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pin_save_pkey" PRIMARY KEY ("pin_save_id")
);

-- CreateTable
CREATE TABLE "pin_comment" (
    "pin_comment_id" SERIAL NOT NULL,
    "pin_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "body" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pin_comment_pkey" PRIMARY KEY ("pin_comment_id")
);

-- CreateTable
CREATE TABLE "vehicle" (
    "vehicle_id" SERIAL NOT NULL,
    "driver_id" INTEGER,
    "plate_number" VARCHAR(20),
    "model" VARCHAR(100),
    "color" VARCHAR(50),
    "year" INTEGER,
    "max_passengers" INTEGER,
    "vehicle_type_id" INTEGER,
    "vehicle_pic_url" TEXT,
    "booking_type_id" INTEGER,

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("vehicle_id")
);

-- CreateTable
CREATE TABLE "vehicle_types" (
    "vehicle_type_id" SERIAL NOT NULL,
    "name" VARCHAR(50),
    "base_rate_per_km" DOUBLE PRECISION,
    "booking_type_id" INTEGER,

    CONSTRAINT "vehicle_types_pkey" PRIMARY KEY ("vehicle_type_id")
);

-- CreateTable
CREATE TABLE "vendor_type" (
    "vendor_type_id" SERIAL NOT NULL,
    "vendor_type" VARCHAR(100),

    CONSTRAINT "vendor_type_pkey" PRIMARY KEY ("vendor_type_id")
);

-- CreateTable
CREATE TABLE "food_cart" (
    "cart_id" SERIAL NOT NULL,
    "buyer_id" INTEGER NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "food_item_id" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "food_cart_pkey" PRIMARY KEY ("cart_id")
);

-- CreateTable
CREATE TABLE "ride_rating" (
    "rating_id" SERIAL NOT NULL,
    "trip_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "review" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ride_rating_pkey" PRIMARY KEY ("rating_id")
);

-- CreateTable
CREATE TABLE "email_verification" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel" (
    "channel_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "handle" VARCHAR(50) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "profile_pic_url" TEXT,
    "banner_url" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "content_niche" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "channel_pkey" PRIMARY KEY ("channel_id")
);

-- CreateTable
CREATE TABLE "video" (
    "video_id" SERIAL NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "file_size_bytes" BIGINT,
    "safety_score" DOUBLE PRECISION DEFAULT 0,
    "is_monetizable" BOOLEAN NOT NULL DEFAULT false,
    "ad_revenue" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "raw_video_url" TEXT NOT NULL,
    "hls_url" TEXT,
    "thumbnail_url" TEXT,
    "duration_sec" INTEGER NOT NULL DEFAULT 0,
    "views_count" INTEGER NOT NULL DEFAULT 0,
    "video_type" TEXT NOT NULL DEFAULT 'long',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "is_nsfw" BOOLEAN NOT NULL DEFAULT false,
    "digital_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "is_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "processing_status" TEXT NOT NULL DEFAULT 'pending',
    "processing_error" VARCHAR(500),
    "processing_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMP(3),
    "public_id" VARCHAR(16),
    "slug" VARCHAR(80),
    "category" TEXT DEFAULT 'General',
    "moderation_flag" VARCHAR(40),
    "thumbnail_is_custom" BOOLEAN NOT NULL DEFAULT false,
    "safety_status" TEXT NOT NULL DEFAULT 'pending',

    CONSTRAINT "video_pkey" PRIMARY KEY ("video_id")
);

-- CreateTable
CREATE TABLE "video_analytics" (
    "id" SERIAL NOT NULL,
    "video_id" INTEGER NOT NULL,
    "watch_time_sec" INTEGER NOT NULL DEFAULT 0,
    "viewer_country" TEXT,
    "device_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_analytics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "channel_id" INTEGER NOT NULL,
    "notify" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_comments" (
    "comment_id" SERIAL NOT NULL,
    "video_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "parent_id" INTEGER,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_comments_pkey" PRIMARY KEY ("comment_id")
);

-- CreateTable
CREATE TABLE "video_comment_likes" (
    "id" SERIAL NOT NULL,
    "comment_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_comment_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_likes" (
    "id" SERIAL NOT NULL,
    "video_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "is_like" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_likes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_watch_later" (
    "id" SERIAL NOT NULL,
    "video_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_watch_later_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playlist" (
    "playlist_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlist_pkey" PRIMARY KEY ("playlist_id")
);

-- CreateTable
CREATE TABLE "playlist_item" (
    "id" SERIAL NOT NULL,
    "playlist_id" INTEGER NOT NULL,
    "video_id" INTEGER NOT NULL,
    "added_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playlist_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_address" (
    "address_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "label" VARCHAR(60) NOT NULL,
    "street" VARCHAR(255) NOT NULL,
    "city" VARCHAR(120),
    "country" VARCHAR(120),
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_address_pkey" PRIMARY KEY ("address_id")
);

-- CreateTable
CREATE TABLE "watch_history" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "video_id" INTEGER NOT NULL,
    "last_position" INTEGER NOT NULL DEFAULT 0,
    "watched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "credited_sec" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "watch_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strug_wallet" (
    "wallet_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "status" TEXT NOT NULL DEFAULT 'active',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strug_wallet_pkey" PRIMARY KEY ("wallet_id")
);

-- CreateTable
CREATE TABLE "wallet_transaction" (
    "transaction_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "external_ref" VARCHAR,

    CONSTRAINT "wallet_transaction_pkey" PRIMARY KEY ("transaction_id")
);

-- CreateTable
CREATE TABLE "ads" (
    "ad_id" SERIAL NOT NULL,
    "advertiser_id" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "ad_type" TEXT NOT NULL,
    "vertical" TEXT NOT NULL,
    "media_url" TEXT NOT NULL,
    "target_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "target_views" INTEGER NOT NULL DEFAULT 1000,
    "current_views" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_pkey" PRIMARY KEY ("ad_id")
);

-- CreateTable
CREATE TABLE "ad_impressions" (
    "id" SERIAL NOT NULL,
    "ad_id" INTEGER NOT NULL,
    "video_id" INTEGER,
    "viewer_id" INTEGER NOT NULL,
    "revenue_generated" DECIMAL(10,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "event_type" TEXT NOT NULL DEFAULT 'impression',

    CONSTRAINT "ad_impressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_share_log" (
    "id" SERIAL NOT NULL,
    "video_id" INTEGER NOT NULL,
    "total_earned" DECIMAL(12,4) NOT NULL,
    "creator_share" DECIMAL(12,4) NOT NULL,
    "platform_share" DECIMAL(12,4) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_share_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vertical_profile" (
    "vertical_profile_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "vertical" VARCHAR(50) NOT NULL,
    "handle" VARCHAR(50),
    "display_name" VARCHAR(100),
    "business_name" VARCHAR(150),
    "bio" TEXT,
    "profile_pic_url" TEXT,
    "banner_url" TEXT,
    "website" VARCHAR(300),
    "location" VARCHAR(200),
    "is_customized" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vertical_profile_pkey" PRIMARY KEY ("vertical_profile_id")
);

-- CreateTable
CREATE TABLE "social_profile" (
    "profile_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "handle" VARCHAR(50) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "bio" TEXT,
    "profile_pic_url" TEXT,
    "banner_url" TEXT,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "is_shadow_banned" BOOLEAN NOT NULL DEFAULT false,
    "is_banned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "accepted_terms" BOOLEAN NOT NULL DEFAULT false,
    "show_activity_status" BOOLEAN NOT NULL DEFAULT true,
    "is_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "verification_type" "VerificationType" NOT NULL DEFAULT 'NONE',

    CONSTRAINT "social_profile_pkey" PRIMARY KEY ("profile_id")
);

-- CreateTable
CREATE TABLE "follower" (
    "id" SERIAL NOT NULL,
    "follower_id" INTEGER NOT NULL,
    "following_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "follower_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_story" (
    "story_id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "media_url" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "highlight_id" INTEGER,
    "music_url" TEXT,
    "music_title" VARCHAR(255),

    CONSTRAINT "social_story_pkey" PRIMARY KEY ("story_id")
);

-- CreateTable
CREATE TABLE "story_view" (
    "view_id" SERIAL NOT NULL,
    "story_id" INTEGER NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_view_pkey" PRIMARY KEY ("view_id")
);

-- CreateTable
CREATE TABLE "social_highlight" (
    "highlight_id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "title" VARCHAR(50) NOT NULL,
    "cover_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_highlight_pkey" PRIMARY KEY ("highlight_id")
);

-- CreateTable
CREATE TABLE "social_bookmark" (
    "bookmark_id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "social_post_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_bookmark_pkey" PRIMARY KEY ("bookmark_id")
);

-- CreateTable
CREATE TABLE "social_tag" (
    "tag_id" SERIAL NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "post_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_tag_pkey" PRIMARY KEY ("tag_id")
);

-- CreateTable
CREATE TABLE "social_search_history" (
    "search_id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "query" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_search_history_pkey" PRIMARY KEY ("search_id")
);

-- CreateTable
CREATE TABLE "social_seen_post" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "post_id" INTEGER NOT NULL,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_seen_post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_block" (
    "block_id" SERIAL NOT NULL,
    "blocker_id" INTEGER NOT NULL,
    "blocked_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_block_pkey" PRIMARY KEY ("block_id")
);

-- CreateTable
CREATE TABLE "social_mute" (
    "mute_id" SERIAL NOT NULL,
    "muter_id" INTEGER NOT NULL,
    "muted_id" INTEGER NOT NULL,
    "mute_posts" BOOLEAN NOT NULL DEFAULT true,
    "mute_story" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_mute_pkey" PRIMARY KEY ("mute_id")
);

-- CreateTable
CREATE TABLE "close_friend" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "friend_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "close_friend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_report" (
    "report_id" SERIAL NOT NULL,
    "reporter_id" INTEGER NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "social_report_pkey" PRIMARY KEY ("report_id")
);

-- CreateTable
CREATE TABLE "content_appeal" (
    "appeal_id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_appeal_pkey" PRIMARY KEY ("appeal_id")
);

-- CreateTable
CREATE TABLE "social_notification" (
    "notification_id" SERIAL NOT NULL,
    "receiver_id" INTEGER NOT NULL,
    "sender_id" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "target_id" INTEGER NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_notification_pkey" PRIMARY KEY ("notification_id")
);

-- CreateTable
CREATE TABLE "social_post_view" (
    "id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_post_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_audit_log" (
    "log_id" SERIAL NOT NULL,
    "admin_id" INTEGER,
    "profile_id" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "ip_address" VARCHAR(45),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "social_audit_log_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "user_activity_event" (
    "event_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "description" TEXT,
    "ip_address" VARCHAR(45),
    "user_agent" TEXT,
    "source" VARCHAR(16) NOT NULL DEFAULT 'live',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_activity_event_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "user_alert" (
    "alert_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "severity" VARCHAR(16) NOT NULL DEFAULT 'warning',
    "message" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'open',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_alert_pkey" PRIMARY KEY ("alert_id")
);

-- CreateTable
CREATE TABLE "user_note" (
    "note_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "author_member_id" INTEGER,
    "author_name" VARCHAR(255),
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_note_pkey" PRIMARY KEY ("note_id")
);

-- CreateTable
CREATE TABLE "user_tag" (
    "tag_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "tag" VARCHAR(64) NOT NULL,
    "color" VARCHAR(16),
    "created_by_member_id" INTEGER,
    "created_by_name" VARCHAR(255),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_tag_pkey" PRIMARY KEY ("tag_id")
);

-- CreateTable
CREATE TABLE "user_profile_history" (
    "history_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "field" VARCHAR(64) NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "changed_by" VARCHAR(32) NOT NULL DEFAULT 'user',
    "actor_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_profile_history_pkey" PRIMARY KEY ("history_id")
);

-- CreateTable
CREATE TABLE "live_stream_category" (
    "category_id" SERIAL NOT NULL,
    "category_name" VARCHAR(100) NOT NULL,
    "icon_url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "live_stream_category_pkey" PRIMARY KEY ("category_id")
);

-- CreateTable
CREATE TABLE "live_streamer_social_links" (
    "link_id" SERIAL NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "platform" VARCHAR(50) NOT NULL,
    "url" VARCHAR(500) NOT NULL,

    CONSTRAINT "live_streamer_social_links_pkey" PRIMARY KEY ("link_id")
);

-- CreateTable
CREATE TABLE "live_streamer_wallet" (
    "wallet_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "balance" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
    "currency" TEXT NOT NULL DEFAULT 'CAD',

    CONSTRAINT "live_streamer_wallet_pkey" PRIMARY KEY ("wallet_id")
);

-- CreateTable
CREATE TABLE "live_subscription" (
    "subscription_id" SERIAL NOT NULL,
    "subscriber_user_id" INTEGER NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "stripe_subscription_id" TEXT,
    "stripe_customer_id" TEXT,
    "stripe_price_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'incomplete',
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "price_cents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_subscription_pkey" PRIMARY KEY ("subscription_id")
);

-- CreateTable
CREATE TABLE "live_subscription_payment" (
    "payment_id" SERIAL NOT NULL,
    "stripe_invoice_id" TEXT NOT NULL,
    "subscription_id" INTEGER,
    "streamer_id" INTEGER NOT NULL,
    "subscriber_user_id" INTEGER,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "creator_share" DECIMAL(12,2) NOT NULL,
    "platform_share" DECIMAL(12,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_subscription_payment_pkey" PRIMARY KEY ("payment_id")
);

-- CreateTable
CREATE TABLE "live_streamer_profile" (
    "streamer_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "category_id" INTEGER NOT NULL,
    "handle" VARCHAR(50) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "profile_pic_url" TEXT,
    "banner_url" TEXT,
    "offline_banner_url" TEXT,
    "theme_color" TEXT NOT NULL DEFAULT '#9146FF',
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_nsfw" BOOLEAN NOT NULL DEFAULT false,
    "stream_delay_ms" INTEGER NOT NULL DEFAULT 0,
    "monetization_status" "LiveMonetizationStatus" NOT NULL DEFAULT 'NONE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "chat_mode" TEXT NOT NULL DEFAULT 'PUBLIC',
    "slow_mode_ms" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "stripe_account_id" VARCHAR(80),

    CONSTRAINT "live_streamer_profile_pkey" PRIMARY KEY ("streamer_id")
);

-- CreateTable
CREATE TABLE "live_session" (
    "session_id" SERIAL NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "stream_key" VARCHAR(100) NOT NULL,
    "ingest_url" VARCHAR(500) NOT NULL,
    "acs_room_id" VARCHAR(100),
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "status" "StreamStatus" NOT NULL DEFAULT 'IDLE',
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "playback_url" VARCHAR(500),

    CONSTRAINT "live_session_pkey" PRIMARY KEY ("session_id")
);

-- CreateTable
CREATE TABLE "live_chat_message" (
    "message_id" SERIAL NOT NULL,
    "session_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "username" VARCHAR(120),
    "text" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_chat_message_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "live_stream_schedule" (
    "schedule_id" SERIAL NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "scheduled_at" TIMESTAMP(3) NOT NULL,
    "is_cancelled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_stream_schedule_pkey" PRIMARY KEY ("schedule_id")
);

-- CreateTable
CREATE TABLE "community_post" (
    "post_id" SERIAL NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "content" TEXT,
    "image_url" VARCHAR(500),
    "is_poll" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_post_pkey" PRIMARY KEY ("post_id")
);

-- CreateTable
CREATE TABLE "community_poll_option" (
    "option_id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "option_text" VARCHAR(255) NOT NULL,
    "vote_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "community_poll_option_pkey" PRIMARY KEY ("option_id")
);

-- CreateTable
CREATE TABLE "community_poll_vote" (
    "vote_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "option_id" INTEGER NOT NULL,

    CONSTRAINT "community_poll_vote_pkey" PRIMARY KEY ("vote_id")
);

-- CreateTable
CREATE TABLE "community_post_like" (
    "like_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "post_id" INTEGER NOT NULL,

    CONSTRAINT "community_post_like_pkey" PRIMARY KEY ("like_id")
);

-- CreateTable
CREATE TABLE "live_stream_guest" (
    "guest_id" SERIAL NOT NULL,
    "session_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "status" "GuestStatus" NOT NULL DEFAULT 'INVITED',
    "joined_at" TIMESTAMP(3),
    "left_at" TIMESTAMP(3),

    CONSTRAINT "live_stream_guest_pkey" PRIMARY KEY ("guest_id")
);

-- CreateTable
CREATE TABLE "live_chat_moderator" (
    "mod_id" SERIAL NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_chat_moderator_pkey" PRIMARY KEY ("mod_id")
);

-- CreateTable
CREATE TABLE "live_chat_ban" (
    "ban_id" SERIAL NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "reason" VARCHAR(255),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_chat_ban_pkey" PRIMARY KEY ("ban_id")
);

-- CreateTable
CREATE TABLE "live_banned_word" (
    "word_id" SERIAL NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "word" VARCHAR(100) NOT NULL,

    CONSTRAINT "live_banned_word_pkey" PRIMARY KEY ("word_id")
);

-- CreateTable
CREATE TABLE "live_vod" (
    "vod_id" SERIAL NOT NULL,
    "session_id" INTEGER NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "video_url" VARCHAR(500) NOT NULL,
    "thumbnail_url" VARCHAR(500),
    "title" VARCHAR(255) NOT NULL,
    "duration_sec" INTEGER NOT NULL DEFAULT 0,
    "visibility" TEXT NOT NULL DEFAULT 'PUBLIC',
    "is_clip" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "live_vod_pkey" PRIMARY KEY ("vod_id")
);

-- CreateTable
CREATE TABLE "live_monetization_request" (
    "request_id" SERIAL NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "status" "LiveMonetizationStatus" NOT NULL DEFAULT 'PENDING',
    "admin_note" TEXT,
    "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "live_monetization_request_pkey" PRIMARY KEY ("request_id")
);

-- CreateTable
CREATE TABLE "live_payout_request" (
    "payout_id" SERIAL NOT NULL,
    "streamer_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "admin_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "stripe_transfer_id" VARCHAR(80),
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "live_payout_request_pkey" PRIMARY KEY ("payout_id")
);

-- CreateTable
CREATE TABLE "town_hall_post" (
    "post_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "content" VARCHAR(280) NOT NULL,
    "parent_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "media_type" VARCHAR(50),
    "media_url" TEXT,
    "quote_post_id" INTEGER,
    "scheduled_at" TIMESTAMP(3),
    "view_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "town_hall_post_pkey" PRIMARY KEY ("post_id")
);

-- CreateTable
CREATE TABLE "town_hall_post_like" (
    "like_id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "town_hall_post_like_pkey" PRIMARY KEY ("like_id")
);

-- CreateTable
CREATE TABLE "town_hall_repost" (
    "repost_id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "town_hall_repost_pkey" PRIMARY KEY ("repost_id")
);

-- CreateTable
CREATE TABLE "town_hall_post_view" (
    "id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "viewed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "town_hall_post_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "town_hall_post_save" (
    "save_id" SERIAL NOT NULL,
    "post_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "town_hall_post_save_pkey" PRIMARY KEY ("save_id")
);

-- CreateTable
CREATE TABLE "reservation" (
    "reservation_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "vendor_id" INTEGER NOT NULL,
    "date" VARCHAR(20) NOT NULL,
    "time" VARCHAR(20) NOT NULL,
    "party_size" INTEGER NOT NULL,
    "special_notes" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservation_pkey" PRIMARY KEY ("reservation_id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ads_wallet" (
    "ads_wallet_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "balance" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "status" TEXT NOT NULL DEFAULT 'active',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ads_wallet_pkey" PRIMARY KEY ("ads_wallet_id")
);

-- CreateTable
CREATE TABLE "ads_account_profile" (
    "profile_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "business_name" VARCHAR(255),
    "tax_id" VARCHAR(50),
    "brn" VARCHAR(50),
    "address" VARCHAR(500),
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "status" TEXT NOT NULL DEFAULT 'UNDER_REVIEW',
    "setup_completed" BOOLEAN NOT NULL DEFAULT false,
    "billing_threshold" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
    "sandbox_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ads_account_profile_pkey" PRIMARY KEY ("profile_id")
);

-- CreateTable
CREATE TABLE "ads_member" (
    "member_id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ADVERTISER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_member_pkey" PRIMARY KEY ("member_id")
);

-- CreateTable
CREATE TABLE "ads_brand_profile" (
    "brand_id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "brand_name" VARCHAR(255) NOT NULL,
    "logo_url" VARCHAR(500),
    "website" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_brand_profile_pkey" PRIMARY KEY ("brand_id")
);

-- CreateTable
CREATE TABLE "ads_tos_agreement" (
    "agreement_id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "signed_by_user_id" INTEGER NOT NULL,
    "ip_address" VARCHAR(45) NOT NULL,
    "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ads_tos_agreement_pkey" PRIMARY KEY ("agreement_id")
);

-- CreateTable
CREATE TABLE "ads_campaign" (
    "campaign_id" SERIAL NOT NULL,
    "ads_wallet_id" INTEGER NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "ad_type" TEXT NOT NULL,
    "vertical" TEXT NOT NULL,
    "media_url" TEXT NOT NULL,
    "target_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "bid_type" TEXT NOT NULL,
    "bid_amount" DECIMAL(12,4) NOT NULL,
    "daily_budget" DECIMAL(12,4) NOT NULL,
    "spent_today" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
    "total_budget" DECIMAL(12,4) NOT NULL,
    "total_spent" DECIMAL(12,4) NOT NULL DEFAULT 0.00,
    "target_countries" TEXT[],
    "target_cities" TEXT[],
    "target_interests" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "folder_tag" VARCHAR(100),
    "objective" TEXT NOT NULL DEFAULT 'AWARENESS',
    "dayparting_schedule" JSONB,
    "frequency_cap" INTEGER DEFAULT 3,
    "pacing_mode" TEXT NOT NULL DEFAULT 'STANDARD',
    "placements" TEXT[],
    "aspect_ratio" TEXT DEFAULT '1:1',
    "cta_text" TEXT DEFAULT 'LEARN_MORE',
    "description" VARCHAR(500),
    "duration_sec" INTEGER DEFAULT 0,
    "fallback_media_url" VARCHAR(500),
    "file_size_bytes" BIGINT DEFAULT 0,
    "headline" VARCHAR(100),
    "is_sensitive" BOOLEAN DEFAULT false,
    "media_hash" VARCHAR(64),
    "safety_score" DOUBLE PRECISION DEFAULT 1.0,
    "main_category" TEXT NOT NULL DEFAULT 'SOCIAL',
    "sub_category" TEXT NOT NULL DEFAULT 'strug_insta',

    CONSTRAINT "ads_campaign_pkey" PRIMARY KEY ("campaign_id")
);

-- CreateTable
CREATE TABLE "ads_targeting_profile" (
    "targeting_id" SERIAL NOT NULL,
    "campaign_id" INTEGER NOT NULL,
    "min_age" INTEGER DEFAULT 13,
    "max_age" INTEGER DEFAULT 65,
    "genders" TEXT[],
    "languages" TEXT[],
    "device_platforms" TEXT[],
    "geofence_lat" DOUBLE PRECISION,
    "geofence_long" DOUBLE PRECISION,
    "geofence_radius_km" DOUBLE PRECISION,
    "lookalike_source_id" INTEGER,
    "excluded_profile_ids" INTEGER[],
    "connected_channel_ids" INTEGER[],

    CONSTRAINT "ads_targeting_profile_pkey" PRIMARY KEY ("targeting_id")
);

-- CreateTable
CREATE TABLE "user_interest_profile" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "interests" JSONB NOT NULL DEFAULT '{}',
    "top_tokens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "top_creators" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "signal_count" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_interest_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_impression" (
    "id" SERIAL NOT NULL,
    "profile_id" INTEGER NOT NULL,
    "content_type" VARCHAR(10) NOT NULL,
    "content_id" INTEGER NOT NULL,
    "dwell_ms" INTEGER NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 1,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "source" VARCHAR(20),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_impression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_view" (
    "id" SERIAL NOT NULL,
    "video_id" INTEGER NOT NULL,
    "identifier" VARCHAR(80) NOT NULL,
    "viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "used_ad_token" (
    "jti" TEXT NOT NULL,
    "video_id" INTEGER NOT NULL,
    "user_id" INTEGER NOT NULL,
    "used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "used_ad_token_pkey" PRIMARY KEY ("jti")
);

-- CreateTable
CREATE TABLE "trending_topic" (
    "id" SERIAL NOT NULL,
    "token" VARCHAR(80) NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "window_days" INTEGER NOT NULL DEFAULT 3,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trending_topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bug_report" (
    "bug_report_id" SERIAL NOT NULL,
    "user_id" INTEGER,
    "email" VARCHAR(1000),
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "category" VARCHAR(50) NOT NULL DEFAULT 'bug',
    "severity" VARCHAR(20) NOT NULL DEFAULT 'medium',
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "page_url" VARCHAR(1000),
    "user_agent" VARCHAR(1000),
    "admin_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bug_report_pkey" PRIMARY KEY ("bug_report_id")
);

-- CreateTable
CREATE TABLE "bug_report_screenshot" (
    "screenshot_id" SERIAL NOT NULL,
    "bug_report_id" INTEGER NOT NULL,
    "screenshot_url" VARCHAR(1000) NOT NULL,
    "sequence_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "bug_report_screenshot_pkey" PRIMARY KEY ("screenshot_id")
);

-- CreateTable
CREATE TABLE "board_member" (
    "member_id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password" VARCHAR(2000) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "can_assign" BOOLEAN NOT NULL DEFAULT false,
    "can_review" BOOLEAN NOT NULL DEFAULT false,
    "can_manage_members" BOOLEAN NOT NULL DEFAULT false,
    "approved_by" INTEGER,
    "approved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "can_view_users" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "board_member_pkey" PRIMARY KEY ("member_id")
);

-- CreateTable
CREATE TABLE "board_task" (
    "task_id" SERIAL NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "description" TEXT NOT NULL,
    "status" VARCHAR(30) NOT NULL DEFAULT 'backlog',
    "assigner_id" INTEGER NOT NULL,
    "assignee_id" INTEGER,
    "reviewer_id" INTEGER,
    "priority" VARCHAR(20) NOT NULL DEFAULT 'medium',
    "vertical" VARCHAR(80),
    "deadline" TIMESTAMP(3),
    "doc_links" JSONB,
    "review_notes" TEXT,
    "source_type" VARCHAR(30),
    "source_id" INTEGER,
    "reopened_from" INTEGER,
    "ready_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "board_task_pkey" PRIMARY KEY ("task_id")
);

-- CreateTable
CREATE TABLE "board_subtask" (
    "subtask_id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "label" VARCHAR(255) NOT NULL,
    "is_done" BOOLEAN NOT NULL DEFAULT false,
    "pr_link" VARCHAR(500),
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "board_subtask_pkey" PRIMARY KEY ("subtask_id")
);

-- CreateTable
CREATE TABLE "board_pr_link" (
    "pr_link_id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "repo" VARCHAR(120),
    "merged" BOOLEAN NOT NULL DEFAULT false,
    "merged_at" TIMESTAMP(3),

    CONSTRAINT "board_pr_link_pkey" PRIMARY KEY ("pr_link_id")
);

-- CreateTable
CREATE TABLE "board_comment" (
    "comment_id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "author_id" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_comment_pkey" PRIMARY KEY ("comment_id")
);

-- CreateTable
CREATE TABLE "board_notification" (
    "notification_id" SERIAL NOT NULL,
    "member_id" INTEGER NOT NULL,
    "task_id" INTEGER,
    "type" VARCHAR(40) NOT NULL,
    "body" VARCHAR(500) NOT NULL,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_notification_pkey" PRIMARY KEY ("notification_id")
);

-- CreateTable
CREATE TABLE "board_activity" (
    "activity_id" SERIAL NOT NULL,
    "task_id" INTEGER NOT NULL,
    "actor_id" INTEGER,
    "action" VARCHAR(120) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "board_activity_pkey" PRIMARY KEY ("activity_id")
);

-- CreateTable
CREATE TABLE "store_profile" (
    "store_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "store_name" VARCHAR(255),
    "address" VARCHAR(1000),
    "bio" VARCHAR(2000),
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "prep_time" VARCHAR(255),
    "profile_pic_url" VARCHAR(1000),
    "cover_url" VARCHAR(1000),

    CONSTRAINT "store_profile_pkey" PRIMARY KEY ("store_id")
);

-- CreateTable
CREATE TABLE "work_category" (
    "work_category_id" SERIAL NOT NULL,
    "parent_id" INTEGER,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(140) NOT NULL,
    "icon_url" VARCHAR(1000),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_live" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_category_pkey" PRIMARY KEY ("work_category_id")
);

-- CreateTable
CREATE TABLE "worker_profile" (
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

    CONSTRAINT "worker_profile_pkey" PRIMARY KEY ("worker_profile_id")
);

-- CreateTable
CREATE TABLE "worker_category" (
    "worker_category_id" SERIAL NOT NULL,
    "worker_profile_id" INTEGER NOT NULL,
    "work_category_id" INTEGER NOT NULL,

    CONSTRAINT "worker_category_pkey" PRIMARY KEY ("worker_category_id")
);

-- CreateTable
CREATE TABLE "work_job" (
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
    "declined_worker_ids" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payment_method" VARCHAR(30),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    "service_mode" VARCHAR(10) DEFAULT 'mobile',

    CONSTRAINT "work_job_pkey" PRIMARY KEY ("work_job_id")
);

-- CreateTable
CREATE TABLE "work_job_offer" (
    "work_job_offer_id" SERIAL NOT NULL,
    "work_job_id" INTEGER NOT NULL,
    "worker_profile_id" INTEGER NOT NULL,
    "offered_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(6),
    "response" VARCHAR(10) DEFAULT 'pending',

    CONSTRAINT "work_job_offer_pkey" PRIMARY KEY ("work_job_offer_id")
);

-- CreateTable
CREATE TABLE "work_review" (
    "work_review_id" SERIAL NOT NULL,
    "work_job_id" INTEGER NOT NULL,
    "reviewer_id" INTEGER,
    "worker_profile_id" INTEGER,
    "rating" DOUBLE PRECISION,
    "comment" TEXT,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_review_pkey" PRIMARY KEY ("work_review_id")
);

-- CreateTable
CREATE TABLE "booking_listing" (
    "booking_listing_id" SERIAL NOT NULL,
    "vertical" VARCHAR(40) NOT NULL,
    "owner_id" INTEGER NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "location" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "price" DOUBLE PRECISION,
    "price_unit" VARCHAR(20) NOT NULL DEFAULT 'night',
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "instant_book" BOOLEAN NOT NULL DEFAULT false,
    "requires_deposit" BOOLEAN NOT NULL DEFAULT false,
    "deposit_amount" DOUBLE PRECISION,
    "fulfillment" VARCHAR(20) NOT NULL DEFAULT 'onsite',
    "capacity" INTEGER,
    "cleaning_fee" DOUBLE PRECISION DEFAULT 0,
    "service_fee_pct" DOUBLE PRECISION DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "attributes" JSONB,
    "images" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "booking_listing_pkey" PRIMARY KEY ("booking_listing_id")
);

-- CreateTable
CREATE TABLE "availability" (
    "availability_id" SERIAL NOT NULL,
    "booking_listing_id" INTEGER NOT NULL,
    "date" DATE,
    "time_from" VARCHAR(5),
    "time_to" VARCHAR(5),
    "is_blocked" BOOLEAN NOT NULL DEFAULT false,
    "price_override" DOUBLE PRECISION,
    "capacity_override" INTEGER,

    CONSTRAINT "availability_pkey" PRIMARY KEY ("availability_id")
);

-- CreateTable
CREATE TABLE "booking" (
    "booking_id" SERIAL NOT NULL,
    "booking_listing_id" INTEGER NOT NULL,
    "vertical" VARCHAR(40) NOT NULL,
    "guest_id" INTEGER NOT NULL,
    "host_id" INTEGER NOT NULL,
    "start_date" DATE,
    "end_date" DATE,
    "start_time" VARCHAR(5),
    "end_time" VARCHAR(5),
    "unit_count" INTEGER,
    "guests" INTEGER DEFAULT 1,
    "subtotal" DOUBLE PRECISION,
    "cleaning_fee" DOUBLE PRECISION DEFAULT 0,
    "service_fee" DOUBLE PRECISION DEFAULT 0,
    "deposit" DOUBLE PRECISION DEFAULT 0,
    "total" DOUBLE PRECISION,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "status" VARCHAR(20) NOT NULL DEFAULT 'requested',
    "payment_status" VARCHAR(20) NOT NULL DEFAULT 'unpaid',
    "payment_method" VARCHAR(40),
    "payment_intent_id" VARCHAR(255),
    "refund_status" VARCHAR(20) NOT NULL DEFAULT 'none',
    "refund_amount" DOUBLE PRECISION DEFAULT 0,
    "cancellation_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),
    "quantity" INTEGER DEFAULT 1,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("booking_id")
);

-- CreateTable
CREATE TABLE "booking_event" (
    "booking_event_id" SERIAL NOT NULL,
    "booking_id" INTEGER NOT NULL,
    "event_type" VARCHAR(40) NOT NULL,
    "actor_id" INTEGER,
    "from_status" VARCHAR(20),
    "to_status" VARCHAR(20),
    "metadata" JSONB,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_event_pkey" PRIMARY KEY ("booking_event_id")
);

-- CreateTable
CREATE TABLE "work_notification" (
    "work_notification_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "work_job_id" INTEGER,
    "title" VARCHAR(160) NOT NULL,
    "body" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_notification_pkey" PRIMARY KEY ("work_notification_id")
);

-- CreateTable
CREATE TABLE "status_incident" (
    "id" SERIAL NOT NULL,
    "service_id" VARCHAR(64) NOT NULL,
    "service_name" VARCHAR(128) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "severity" VARCHAR(16) NOT NULL DEFAULT 'down',
    "status" VARCHAR(16) NOT NULL DEFAULT 'ongoing',
    "summary" TEXT,
    "auto" BOOLEAN NOT NULL DEFAULT true,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "status_incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_category" (
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

    CONSTRAINT "quote_category_pkey" PRIMARY KEY ("quote_category_id")
);

-- CreateTable
CREATE TABLE "quote_provider" (
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

    CONSTRAINT "quote_provider_pkey" PRIMARY KEY ("quote_provider_id")
);

-- CreateTable
CREATE TABLE "quote_provider_city" (
    "quote_provider_city_id" SERIAL NOT NULL,
    "quote_provider_id" INTEGER NOT NULL,
    "city" VARCHAR(120) NOT NULL,
    "country" VARCHAR(60),

    CONSTRAINT "quote_provider_city_pkey" PRIMARY KEY ("quote_provider_city_id")
);

-- CreateTable
CREATE TABLE "quote_provider_category" (
    "quote_provider_category_id" SERIAL NOT NULL,
    "quote_provider_id" INTEGER NOT NULL,
    "quote_category_id" INTEGER NOT NULL,

    CONSTRAINT "quote_provider_category_pkey" PRIMARY KEY ("quote_provider_category_id")
);

-- CreateTable
CREATE TABLE "quote_request" (
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

    CONSTRAINT "quote_request_pkey" PRIMARY KEY ("quote_request_id")
);

-- CreateTable
CREATE TABLE "quote" (
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

    CONSTRAINT "quote_pkey" PRIMARY KEY ("quote_id")
);

-- CreateTable
CREATE TABLE "quote_appointment" (
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
    "availability_id" INTEGER,

    CONSTRAINT "quote_appointment_pkey" PRIMARY KEY ("quote_appointment_id")
);

-- CreateTable
CREATE TABLE "quote_provider_availability" (
    "quote_provider_availability_id" SERIAL NOT NULL,
    "quote_provider_id" INTEGER NOT NULL,
    "slot_start" TIMESTAMP(6) NOT NULL,
    "slot_end" TIMESTAMP(6),
    "is_booked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_provider_availability_pkey" PRIMARY KEY ("quote_provider_availability_id")
);

-- CreateTable
CREATE TABLE "quote_notification" (
    "quote_notification_id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "quote_request_id" INTEGER,
    "title" VARCHAR(160) NOT NULL,
    "body" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_notification_pkey" PRIMARY KEY ("quote_notification_id")
);

-- CreateTable
CREATE TABLE "contact_submissions" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "subject" VARCHAR(500),
    "message" TEXT NOT NULL,
    "submitted_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "status" VARCHAR(50) DEFAULT 'pending',

    CONSTRAINT "contact_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "newsletter_subscriptions" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "subscribed_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "is_active" BOOLEAN DEFAULT true,

    CONSTRAINT "newsletter_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_signups" (
    "id" SERIAL NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "business_name" VARCHAR(255),
    "created_at" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "trial_started" BOOLEAN DEFAULT false,

    CONSTRAINT "user_signups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wishlist_item" (
    "wishlist_item_id" SERIAL NOT NULL,
    "owner_id" INTEGER NOT NULL,
    "item_type" VARCHAR(20) NOT NULL,
    "item_ref_id" INTEGER,
    "title" VARCHAR(500) NOT NULL,
    "description" TEXT,
    "image_url" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'CAD',
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6),

    CONSTRAINT "wishlist_item_pkey" PRIMARY KEY ("wishlist_item_id")
);

-- CreateTable
CREATE TABLE "wishlist_contribution" (
    "contribution_id" SERIAL NOT NULL,
    "wishlist_item_id" INTEGER NOT NULL,
    "contributor_id" INTEGER NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "payment_method" VARCHAR(20) NOT NULL DEFAULT 'wallet',
    "status" VARCHAR(20) NOT NULL DEFAULT 'completed',
    "note" VARCHAR(500),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wishlist_contribution_pkey" PRIMARY KEY ("contribution_id")
);

-- CreateTable
CREATE TABLE "_social_feedTosocial_tag" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_social_feedTosocial_tag_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_social_profileTosocial_tag" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,

    CONSTRAINT "_social_profileTosocial_tag_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "idx_active_trip_driver" ON "active_trip"("driver_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_email_key" ON "admin"("email");

-- CreateIndex
CREATE INDEX "idx_appointments_provider" ON "appointments"("service_provider_id");

-- CreateIndex
CREATE INDEX "idx_appointments_user" ON "appointments"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_chat_channel_dm_key" ON "chat_channel"("dm_key");

-- CreateIndex
CREATE INDEX "idx_chat_channel_context" ON "chat_channel"("context_type", "context_id");

-- CreateIndex
CREATE INDEX "idx_chat_channel_last_message" ON "chat_channel"("last_message_at");

-- CreateIndex
CREATE UNIQUE INDEX "uq_chat_channel_context" ON "chat_channel"("context_type", "context_id");

-- CreateIndex
CREATE INDEX "idx_chat_messages_channel_sent" ON "chat_messages"("channel_id", "sent_at");

-- CreateIndex
CREATE INDEX "idx_chat_messages_sender_sent" ON "chat_messages"("sender_id", "sent_at");

-- CreateIndex
CREATE INDEX "idx_chat_participants_user_channel" ON "chat_participants"("user_id", "channel_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_chat_participants_channel_user" ON "chat_participants"("channel_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_journal_highlight_channel" ON "journal_highlight"("channel_id");

-- CreateIndex
CREATE INDEX "idx_journal_highlight_saved_by" ON "journal_highlight"("saved_by");

-- CreateIndex
CREATE INDEX "idx_journal_bucket_channel" ON "journal_bucket_item"("channel_id");

-- CreateIndex
CREATE INDEX "idx_journal_time_capsule_channel" ON "journal_time_capsule"("channel_id");

-- CreateIndex
CREATE INDEX "idx_journal_time_capsule_unlock" ON "journal_time_capsule"("unlock_date");

-- CreateIndex
CREATE INDEX "idx_journal_time_capsule_partner" ON "journal_time_capsule"("partner_id");

-- CreateIndex
CREATE UNIQUE INDEX "courier_customer_user_id_key" ON "courier_customer"("user_id");

-- CreateIndex
CREATE INDEX "idx_dg_order_intent" ON "dg_order"("payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "donations_payment_intent_id_key" ON "donations"("payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_orphan_payment_payment_intent_id_key" ON "stripe_orphan_payment"("payment_intent_id");

-- CreateIndex
CREATE INDEX "idx_driver_profile_user" ON "driver_profile"("user_id");

-- CreateIndex
CREATE INDEX "idx_employee_attendance_employee" ON "employee_attendance"("employee_id");

-- CreateIndex
CREATE INDEX "idx_employees_user" ON "employees"("employee_user_id");

-- CreateIndex
CREATE INDEX "idx_food_item_modifier_group_food_item" ON "food_item_modifier_group"("food_item_id");

-- CreateIndex
CREATE INDEX "idx_food_item_modifier_option_group" ON "food_item_modifier_option"("group_id");

-- CreateIndex
CREATE INDEX "idx_food_order_user" ON "food_order"("user_id");

-- CreateIndex
CREATE INDEX "idx_food_order_vendor" ON "food_order"("vendor_id");

-- CreateIndex
CREATE INDEX "idx_food_order_intent" ON "food_order"("payment_intent_id");

-- CreateIndex
CREATE INDEX "idx_food_vendor_owner" ON "food_vendor"("owner_id");

-- CreateIndex
CREATE INDEX "idx_product_listing_type" ON "product_listing"("product_type_id");

-- CreateIndex
CREATE INDEX "idx_product_listing_seller" ON "product_listing"("seller_id");

-- CreateIndex
CREATE INDEX "idx_product_order_buyer" ON "product_order"("buyer_id");

-- CreateIndex
CREATE INDEX "idx_product_order_seller" ON "product_order"("seller_id");

-- CreateIndex
CREATE INDEX "idx_product_order_intent" ON "product_order"("payment_intent_id");

-- CreateIndex
CREATE INDEX "idx_product_order_driver" ON "product_order"("driver_id");

-- CreateIndex
CREATE INDEX "idx_product_variation_listing" ON "product_variation"("listing_id");

-- CreateIndex
CREATE INDEX "idx_reward_tier_project" ON "reward_tier"("project_id");

-- CreateIndex
CREATE INDEX "idx_campaign_update_project" ON "campaign_update"("project_id");

-- CreateIndex
CREATE INDEX "idx_campaign_payout_project" ON "campaign_payout"("project_id");

-- CreateIndex
CREATE INDEX "idx_rental_listing_category" ON "rental_listing"("rental_category_id");

-- CreateIndex
CREATE INDEX "idx_rental_listing_owner" ON "rental_listing"("owner_id");

-- CreateIndex
CREATE INDEX "idx_ride_request_passenger" ON "ride_request"("passenger_id");

-- CreateIndex
CREATE INDEX "idx_service_order_buyer" ON "service_order"("buyer_id");

-- CreateIndex
CREATE INDEX "idx_services_category" ON "services"("service_category_id");

-- CreateIndex
CREATE UNIQUE INDEX "shared_ref_code_shared_to_ref_code_key" ON "shared_ref_code"("shared_to", "ref_code");

-- CreateIndex
CREATE INDEX "idx_social_comments_post" ON "social_comments"("social_post_id");

-- CreateIndex
CREATE INDEX "idx_social_comments_profile" ON "social_comments"("profile_id");

-- CreateIndex
CREATE INDEX "social_feed_profile_id_idx" ON "social_feed"("profile_id");

-- CreateIndex
CREATE INDEX "social_feed_status_idx" ON "social_feed"("status");

-- CreateIndex
CREATE INDEX "social_feed_profile_id_created_at_idx" ON "social_feed"("profile_id", "created_at");

-- CreateIndex
CREATE INDEX "social_feed_status_created_at_idx" ON "social_feed"("status", "created_at");

-- CreateIndex
CREATE INDEX "idx_social_interactions_post" ON "social_interactions"("social_post_id");

-- CreateIndex
CREATE INDEX "idx_social_interactions_profile" ON "social_interactions"("profile_id");

-- CreateIndex
CREATE INDEX "social_interactions_social_post_id_idx" ON "social_interactions"("social_post_id");

-- CreateIndex
CREATE INDEX "social_interactions_profile_id_idx" ON "social_interactions"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_ref_code_key" ON "user"("ref_code");

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");

-- CreateIndex
CREATE INDEX "idx_user_email" ON "user"("email");

-- CreateIndex
CREATE INDEX "idx_user_ref_code" ON "user"("ref_code");

-- CreateIndex
CREATE INDEX "user_account_status_idx" ON "user"("account_status");

-- CreateIndex
CREATE INDEX "user_deleted_at_idx" ON "user"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_service_provider_services_id_user_id_key" ON "user_service_provider"("services_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_name_key" ON "community"("name");

-- CreateIndex
CREATE UNIQUE INDEX "community_member_community_id_user_id_key" ON "community_member"("community_id", "user_id");

-- CreateIndex
CREATE INDEX "community_post_comment_parent_id_idx" ON "community_post_comment"("parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_post_vote_user_id_post_id_key" ON "community_post_vote"("user_id", "post_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_comment_vote_user_id_comment_id_key" ON "community_comment_vote"("user_id", "comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_post_save_user_id_post_id_key" ON "community_post_save"("user_id", "post_id");

-- CreateIndex
CREATE INDEX "saved_item_user_id_idx" ON "saved_item"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "saved_item_user_id_entity_type_entity_id_key" ON "saved_item"("user_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "pin_user_id_idx" ON "pin"("user_id");

-- CreateIndex
CREATE INDEX "pin_category_idx" ON "pin"("category");

-- CreateIndex
CREATE INDEX "pin_save_user_id_idx" ON "pin_save"("user_id");

-- CreateIndex
CREATE INDEX "pin_save_pin_id_idx" ON "pin_save"("pin_id");

-- CreateIndex
CREATE UNIQUE INDEX "pin_save_pin_id_user_id_key" ON "pin_save"("pin_id", "user_id");

-- CreateIndex
CREATE INDEX "pin_comment_pin_id_idx" ON "pin_comment"("pin_id");

-- CreateIndex
CREATE INDEX "pin_comment_user_id_idx" ON "pin_comment"("user_id");

-- CreateIndex
CREATE INDEX "food_cart_buyer_id_idx" ON "food_cart"("buyer_id");

-- CreateIndex
CREATE UNIQUE INDEX "ride_rating_trip_id_key" ON "ride_rating"("trip_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_email_key" ON "email_verification"("email");

-- CreateIndex
CREATE UNIQUE INDEX "channel_user_id_key" ON "channel"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_handle_key" ON "channel"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "video_digital_hash_key" ON "video"("digital_hash");

-- CreateIndex
CREATE UNIQUE INDEX "video_public_id_key" ON "video"("public_id");

-- CreateIndex
CREATE INDEX "video_channel_id_idx" ON "video"("channel_id");

-- CreateIndex
CREATE INDEX "video_status_created_at_idx" ON "video"("status", "created_at");

-- CreateIndex
CREATE INDEX "video_status_views_count_idx" ON "video"("status", "views_count");

-- CreateIndex
CREATE INDEX "video_video_type_status_idx" ON "video"("video_type", "status");

-- CreateIndex
CREATE INDEX "video_processing_status_created_at_idx" ON "video"("processing_status", "created_at");

-- CreateIndex
CREATE INDEX "video_moderation_flag_idx" ON "video"("moderation_flag");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_user_id_channel_id_key" ON "subscription"("user_id", "channel_id");

-- CreateIndex
CREATE INDEX "video_comments_video_id_idx" ON "video_comments"("video_id");

-- CreateIndex
CREATE INDEX "video_comments_video_id_parent_id_idx" ON "video_comments"("video_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_comment_likes_user_id_comment_id_key" ON "video_comment_likes"("user_id", "comment_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_likes_user_id_video_id_key" ON "video_likes"("user_id", "video_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_watch_later_user_id_video_id_key" ON "video_watch_later"("user_id", "video_id");

-- CreateIndex
CREATE INDEX "playlist_user_id_idx" ON "playlist"("user_id");

-- CreateIndex
CREATE INDEX "playlist_item_playlist_id_idx" ON "playlist_item"("playlist_id");

-- CreateIndex
CREATE UNIQUE INDEX "playlist_item_playlist_id_video_id_key" ON "playlist_item"("playlist_id", "video_id");

-- CreateIndex
CREATE INDEX "user_address_user_id_idx" ON "user_address"("user_id");

-- CreateIndex
CREATE INDEX "watch_history_user_id_watched_at_idx" ON "watch_history"("user_id", "watched_at");

-- CreateIndex
CREATE UNIQUE INDEX "watch_history_user_id_video_id_key" ON "watch_history"("user_id", "video_id");

-- CreateIndex
CREATE UNIQUE INDEX "strug_wallet_user_id_key" ON "strug_wallet"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_transaction_external_ref_key" ON "wallet_transaction"("external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "vertical_profile_handle_key" ON "vertical_profile"("handle");

-- CreateIndex
CREATE INDEX "vertical_profile_user_id_idx" ON "vertical_profile"("user_id");

-- CreateIndex
CREATE INDEX "vertical_profile_vertical_idx" ON "vertical_profile"("vertical");

-- CreateIndex
CREATE INDEX "vertical_profile_handle_idx" ON "vertical_profile"("handle");

-- CreateIndex
CREATE UNIQUE INDEX "vertical_profile_user_id_vertical_key" ON "vertical_profile"("user_id", "vertical");

-- CreateIndex
CREATE UNIQUE INDEX "social_profile_user_id_key" ON "social_profile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_profile_handle_key" ON "social_profile"("handle");

-- CreateIndex
CREATE INDEX "social_profile_user_id_idx" ON "social_profile"("user_id");

-- CreateIndex
CREATE INDEX "social_profile_handle_idx" ON "social_profile"("handle");

-- CreateIndex
CREATE INDEX "follower_follower_id_idx" ON "follower"("follower_id");

-- CreateIndex
CREATE INDEX "follower_following_id_idx" ON "follower"("following_id");

-- CreateIndex
CREATE UNIQUE INDEX "follower_follower_id_following_id_key" ON "follower"("follower_id", "following_id");

-- CreateIndex
CREATE INDEX "social_story_profile_id_idx" ON "social_story"("profile_id");

-- CreateIndex
CREATE INDEX "social_story_expires_at_idx" ON "social_story"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "story_view_story_id_profile_id_key" ON "story_view"("story_id", "profile_id");

-- CreateIndex
CREATE INDEX "social_highlight_profile_id_idx" ON "social_highlight"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_bookmark_profile_id_social_post_id_key" ON "social_bookmark"("profile_id", "social_post_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_tag_name_key" ON "social_tag"("name");

-- CreateIndex
CREATE INDEX "social_search_history_profile_id_idx" ON "social_search_history"("profile_id");

-- CreateIndex
CREATE INDEX "social_seen_post_profile_id_idx" ON "social_seen_post"("profile_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_seen_post_profile_id_post_id_key" ON "social_seen_post"("profile_id", "post_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_block_blocker_id_blocked_id_key" ON "social_block"("blocker_id", "blocked_id");

-- CreateIndex
CREATE UNIQUE INDEX "social_mute_muter_id_muted_id_key" ON "social_mute"("muter_id", "muted_id");

-- CreateIndex
CREATE UNIQUE INDEX "close_friend_profile_id_friend_id_key" ON "close_friend"("profile_id", "friend_id");

-- CreateIndex
CREATE INDEX "social_report_status_idx" ON "social_report"("status");

-- CreateIndex
CREATE INDEX "social_report_target_type_target_id_idx" ON "social_report"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "social_notification_receiver_id_is_read_created_at_idx" ON "social_notification"("receiver_id", "is_read", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "social_post_view_post_id_profile_id_key" ON "social_post_view"("post_id", "profile_id");

-- CreateIndex
CREATE INDEX "user_activity_event_created_at_idx" ON "user_activity_event"("created_at");

-- CreateIndex
CREATE INDEX "user_activity_event_user_id_idx" ON "user_activity_event"("user_id");

-- CreateIndex
CREATE INDEX "user_activity_event_type_idx" ON "user_activity_event"("type");

-- CreateIndex
CREATE INDEX "user_alert_status_idx" ON "user_alert"("status");

-- CreateIndex
CREATE INDEX "user_alert_severity_idx" ON "user_alert"("severity");

-- CreateIndex
CREATE UNIQUE INDEX "user_alert_user_id_type_key" ON "user_alert"("user_id", "type");

-- CreateIndex
CREATE INDEX "user_note_user_id_idx" ON "user_note"("user_id");

-- CreateIndex
CREATE INDEX "user_tag_tag_idx" ON "user_tag"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "user_tag_user_id_tag_key" ON "user_tag"("user_id", "tag");

-- CreateIndex
CREATE INDEX "user_profile_history_user_id_idx" ON "user_profile_history"("user_id");

-- CreateIndex
CREATE INDEX "user_profile_history_field_idx" ON "user_profile_history"("field");

-- CreateIndex
CREATE UNIQUE INDEX "live_stream_category_category_name_key" ON "live_stream_category"("category_name");

-- CreateIndex
CREATE UNIQUE INDEX "live_streamer_social_links_streamer_id_platform_key" ON "live_streamer_social_links"("streamer_id", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "live_streamer_wallet_user_id_key" ON "live_streamer_wallet"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_streamer_wallet_streamer_id_key" ON "live_streamer_wallet"("streamer_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_subscription_stripe_subscription_id_key" ON "live_subscription"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "live_subscription_streamer_id_idx" ON "live_subscription"("streamer_id");

-- CreateIndex
CREATE INDEX "live_subscription_stripe_subscription_id_idx" ON "live_subscription"("stripe_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_subscription_subscriber_user_id_streamer_id_key" ON "live_subscription"("subscriber_user_id", "streamer_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_subscription_payment_stripe_invoice_id_key" ON "live_subscription_payment"("stripe_invoice_id");

-- CreateIndex
CREATE INDEX "live_subscription_payment_streamer_id_idx" ON "live_subscription_payment"("streamer_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_streamer_profile_user_id_key" ON "live_streamer_profile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_streamer_profile_handle_key" ON "live_streamer_profile"("handle");

-- CreateIndex
CREATE INDEX "live_streamer_profile_handle_idx" ON "live_streamer_profile"("handle");

-- CreateIndex
CREATE INDEX "live_streamer_profile_category_id_idx" ON "live_streamer_profile"("category_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_session_stream_key_key" ON "live_session"("stream_key");

-- CreateIndex
CREATE INDEX "live_chat_message_session_id_idx" ON "live_chat_message"("session_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_poll_vote_user_id_option_id_key" ON "community_poll_vote"("user_id", "option_id");

-- CreateIndex
CREATE UNIQUE INDEX "community_post_like_user_id_post_id_key" ON "community_post_like"("user_id", "post_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_stream_guest_session_id_user_id_key" ON "live_stream_guest"("session_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_chat_moderator_streamer_id_user_id_key" ON "live_chat_moderator"("streamer_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_chat_ban_streamer_id_user_id_key" ON "live_chat_ban"("streamer_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "live_banned_word_streamer_id_word_key" ON "live_banned_word"("streamer_id", "word");

-- CreateIndex
CREATE INDEX "live_vod_streamer_id_idx" ON "live_vod"("streamer_id");

-- CreateIndex
CREATE INDEX "live_vod_session_id_idx" ON "live_vod"("session_id");

-- CreateIndex
CREATE INDEX "town_hall_post_scheduled_at_idx" ON "town_hall_post"("scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "town_hall_post_like_post_id_user_id_key" ON "town_hall_post_like"("post_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "town_hall_repost_post_id_user_id_key" ON "town_hall_repost"("post_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_town_hall_post_view_post" ON "town_hall_post_view"("post_id");

-- CreateIndex
CREATE UNIQUE INDEX "town_hall_post_view_post_id_user_id_key" ON "town_hall_post_view"("post_id", "user_id");

-- CreateIndex
CREATE INDEX "idx_town_hall_post_save_post" ON "town_hall_post_save"("post_id");

-- CreateIndex
CREATE INDEX "idx_town_hall_post_save_user" ON "town_hall_post_save"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "town_hall_post_save_post_id_user_id_key" ON "town_hall_post_save"("post_id", "user_id");

-- CreateIndex
CREATE INDEX "reservation_user_id_idx" ON "reservation"("user_id");

-- CreateIndex
CREATE INDEX "reservation_vendor_id_idx" ON "reservation"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ads_wallet_user_id_key" ON "ads_wallet"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ads_account_profile_user_id_key" ON "ads_account_profile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ads_member_profile_id_user_id_key" ON "ads_member"("profile_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ads_targeting_profile_campaign_id_key" ON "ads_targeting_profile"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_interest_profile_profile_id_key" ON "user_interest_profile"("profile_id");

-- CreateIndex
CREATE INDEX "user_interest_profile_profile_id_idx" ON "user_interest_profile"("profile_id");

-- CreateIndex
CREATE INDEX "content_impression_profile_id_idx" ON "content_impression"("profile_id");

-- CreateIndex
CREATE INDEX "content_impression_profile_id_content_type_idx" ON "content_impression"("profile_id", "content_type");

-- CreateIndex
CREATE UNIQUE INDEX "content_impression_profile_id_content_type_content_id_key" ON "content_impression"("profile_id", "content_type", "content_id");

-- CreateIndex
CREATE INDEX "video_view_video_id_idx" ON "video_view"("video_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_view_video_id_identifier_key" ON "video_view"("video_id", "identifier");

-- CreateIndex
CREATE INDEX "used_ad_token_used_at_idx" ON "used_ad_token"("used_at");

-- CreateIndex
CREATE UNIQUE INDEX "trending_topic_token_key" ON "trending_topic"("token");

-- CreateIndex
CREATE INDEX "trending_topic_score_idx" ON "trending_topic"("score");

-- CreateIndex
CREATE INDEX "idx_bug_report_status" ON "bug_report"("status");

-- CreateIndex
CREATE INDEX "idx_bug_report_public" ON "bug_report"("is_public", "status");

-- CreateIndex
CREATE INDEX "idx_bug_report_user" ON "bug_report"("user_id");

-- CreateIndex
CREATE INDEX "idx_bug_report_screenshot_report" ON "bug_report_screenshot"("bug_report_id");

-- CreateIndex
CREATE UNIQUE INDEX "board_member_email_key" ON "board_member"("email");

-- CreateIndex
CREATE INDEX "idx_board_member_status" ON "board_member"("status");

-- CreateIndex
CREATE INDEX "idx_board_task_status" ON "board_task"("status");

-- CreateIndex
CREATE INDEX "idx_board_task_assignee" ON "board_task"("assignee_id");

-- CreateIndex
CREATE INDEX "idx_board_task_reviewer" ON "board_task"("reviewer_id");

-- CreateIndex
CREATE INDEX "idx_board_subtask_task" ON "board_subtask"("task_id");

-- CreateIndex
CREATE INDEX "idx_board_pr_link_task" ON "board_pr_link"("task_id");

-- CreateIndex
CREATE INDEX "idx_board_comment_task" ON "board_comment"("task_id");

-- CreateIndex
CREATE INDEX "idx_board_notification_member" ON "board_notification"("member_id", "is_read");

-- CreateIndex
CREATE INDEX "idx_board_activity_task" ON "board_activity"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "store_profile_user_id_key" ON "store_profile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_category_slug_key" ON "work_category"("slug");

-- CreateIndex
CREATE INDEX "idx_work_category_parent" ON "work_category"("parent_id");

-- CreateIndex
CREATE INDEX "idx_worker_profile_user" ON "worker_profile"("user_id");

-- CreateIndex
CREATE INDEX "idx_worker_category_category" ON "worker_category"("work_category_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_worker_category" ON "worker_category"("worker_profile_id", "work_category_id");

-- CreateIndex
CREATE INDEX "idx_work_job_hirer" ON "work_job"("hirer_id");

-- CreateIndex
CREATE INDEX "idx_work_job_category" ON "work_job"("category_id");

-- CreateIndex
CREATE INDEX "idx_work_job_status" ON "work_job"("status");

-- CreateIndex
CREATE INDEX "idx_work_job_worker" ON "work_job"("assigned_worker_id");

-- CreateIndex
CREATE INDEX "idx_work_job_offer_job" ON "work_job_offer"("work_job_id");

-- CreateIndex
CREATE INDEX "idx_work_job_offer_worker" ON "work_job_offer"("worker_profile_id");

-- CreateIndex
CREATE INDEX "idx_work_review_job" ON "work_review"("work_job_id");

-- CreateIndex
CREATE INDEX "idx_work_review_worker" ON "work_review"("worker_profile_id");

-- CreateIndex
CREATE INDEX "idx_booking_listing_vertical" ON "booking_listing"("vertical");

-- CreateIndex
CREATE INDEX "idx_booking_listing_owner" ON "booking_listing"("owner_id");

-- CreateIndex
CREATE INDEX "idx_availability_listing_date" ON "availability"("booking_listing_id", "date");

-- CreateIndex
CREATE INDEX "idx_booking_listing" ON "booking"("booking_listing_id");

-- CreateIndex
CREATE INDEX "idx_booking_guest" ON "booking"("guest_id");

-- CreateIndex
CREATE INDEX "idx_booking_host" ON "booking"("host_id");

-- CreateIndex
CREATE INDEX "idx_booking_vertical" ON "booking"("vertical");

-- CreateIndex
CREATE INDEX "idx_booking_event_booking" ON "booking_event"("booking_id");

-- CreateIndex
CREATE INDEX "idx_work_notification_user" ON "work_notification"("user_id", "is_read", "created_at");

-- CreateIndex
CREATE INDEX "idx_status_incident_started" ON "status_incident"("started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "quote_category_slug_key" ON "quote_category"("slug");

-- CreateIndex
CREATE INDEX "idx_quote_category_parent" ON "quote_category"("parent_id");

-- CreateIndex
CREATE INDEX "idx_quote_provider_user" ON "quote_provider"("user_id");

-- CreateIndex
CREATE INDEX "idx_quote_provider_city_city" ON "quote_provider_city"("city");

-- CreateIndex
CREATE UNIQUE INDEX "uq_quote_provider_city" ON "quote_provider_city"("quote_provider_id", "city", "country");

-- CreateIndex
CREATE INDEX "idx_quote_prov_cat_category" ON "quote_provider_category"("quote_category_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_quote_provider_category" ON "quote_provider_category"("quote_provider_id", "quote_category_id");

-- CreateIndex
CREATE INDEX "idx_quote_request_requester" ON "quote_request"("requester_id");

-- CreateIndex
CREATE INDEX "idx_quote_request_category" ON "quote_request"("category_id");

-- CreateIndex
CREATE INDEX "idx_quote_request_status" ON "quote_request"("status");

-- CreateIndex
CREATE INDEX "idx_quote_request_city" ON "quote_request"("city");

-- CreateIndex
CREATE INDEX "idx_quote_request" ON "quote"("quote_request_id");

-- CreateIndex
CREATE INDEX "idx_quote_provider_quote" ON "quote"("provider_id");

-- CreateIndex
CREATE INDEX "idx_quote_appt_request" ON "quote_appointment"("quote_request_id");

-- CreateIndex
CREATE INDEX "idx_quote_appt_provider" ON "quote_appointment"("provider_id");

-- CreateIndex
CREATE INDEX "idx_quote_appt_requester" ON "quote_appointment"("requester_id");

-- CreateIndex
CREATE INDEX "idx_quote_prov_avail" ON "quote_provider_availability"("quote_provider_id", "slot_start");

-- CreateIndex
CREATE INDEX "idx_quote_notification_user" ON "quote_notification"("user_id", "is_read", "created_at");

-- CreateIndex
CREATE INDEX "idx_contact_email" ON "contact_submissions"("email");

-- CreateIndex
CREATE INDEX "idx_contact_status" ON "contact_submissions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "newsletter_subscriptions_email_key" ON "newsletter_subscriptions"("email");

-- CreateIndex
CREATE INDEX "idx_newsletter_email" ON "newsletter_subscriptions"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_signups_email_key" ON "user_signups"("email");

-- CreateIndex
CREATE INDEX "idx_user_signups_email" ON "user_signups"("email");

-- CreateIndex
CREATE INDEX "idx_wishlist_item_owner" ON "wishlist_item"("owner_id");

-- CreateIndex
CREATE INDEX "idx_wishlist_item_status" ON "wishlist_item"("status");

-- CreateIndex
CREATE INDEX "idx_wishlist_contribution_item" ON "wishlist_contribution"("wishlist_item_id");

-- CreateIndex
CREATE INDEX "idx_wishlist_contribution_user" ON "wishlist_contribution"("contributor_id");

-- CreateIndex
CREATE INDEX "_social_feedTosocial_tag_B_index" ON "_social_feedTosocial_tag"("B");

-- CreateIndex
CREATE INDEX "_social_profileTosocial_tag_B_index" ON "_social_profileTosocial_tag"("B");

-- AddForeignKey
ALTER TABLE "active_trip" ADD CONSTRAINT "active_trip_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver_profile"("driver_profile_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "active_trip" ADD CONSTRAINT "active_trip_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "ride_request"("ride_request_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "active_trip" ADD CONSTRAINT "active_trip_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "agents" ADD CONSTRAINT "agents_agent_user_id_fkey" FOREIGN KEY ("agent_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_rating" ADD CONSTRAINT "appointment_rating_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("appointment_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_rating" ADD CONSTRAINT "appointment_rating_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_reviews" ADD CONSTRAINT "appointment_reviews_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("appointment_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_reviews" ADD CONSTRAINT "appointment_reviews_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_service" ADD CONSTRAINT "appointment_service_service_category_id_fkey" FOREIGN KEY ("service_category_id") REFERENCES "appointment_service_category"("service_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointment_service_providers" ADD CONSTRAINT "appointment_service_providers_service_provider_user_id_fkey" FOREIGN KEY ("service_provider_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "checkouts"("checkout_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "appointment_service"("service_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_provider_id_fkey" FOREIGN KEY ("service_provider_id") REFERENCES "appointment_service_providers"("service_provider_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "bank_info" ADD CONSTRAINT "bank_info_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("employee_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "behance" ADD CONSTRAINT "behance_behance_user_id_fkey" FOREIGN KEY ("behance_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "behance_contacted" ADD CONSTRAINT "behance_contacted_behance_id_fkey" FOREIGN KEY ("behance_id") REFERENCES "behance"("behance_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "behance_contacted" ADD CONSTRAINT "behance_contacted_social_post_id_fkey" FOREIGN KEY ("social_post_id") REFERENCES "social_feed"("social_post_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "calm_lesson" ADD CONSTRAINT "calm_lesson_calm_provider_id_fkey" FOREIGN KEY ("calm_provider_id") REFERENCES "calm_providers"("calm_provider_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "calm_lesson_image" ADD CONSTRAINT "calm_lesson_image_calm_lesson_id_fkey" FOREIGN KEY ("calm_lesson_id") REFERENCES "calm_lesson"("calm_lesson_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "calm_lesson_order_buy" ADD CONSTRAINT "calm_lesson_order_buy_calm_lesson_id_fkey" FOREIGN KEY ("calm_lesson_id") REFERENCES "calm_lesson"("calm_lesson_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "calm_lesson_order_buy" ADD CONSTRAINT "calm_lesson_order_buy_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "calm_lesson_parts" ADD CONSTRAINT "calm_lesson_parts_calm_lesson_id_fkey" FOREIGN KEY ("calm_lesson_id") REFERENCES "calm_lesson"("calm_lesson_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "calm_providers" ADD CONSTRAINT "calm_providers_calm_provider_category_id_fkey" FOREIGN KEY ("calm_provider_category_id") REFERENCES "calm_category"("calm_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "calm_providers" ADD CONSTRAINT "calm_providers_provider_user_id_fkey" FOREIGN KEY ("provider_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cam_post" ADD CONSTRAINT "cam_post_talent_id_fkey" FOREIGN KEY ("talent_id") REFERENCES "talent"("talent_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cam_post_image" ADD CONSTRAINT "cam_post_image_cam_post_id_fkey" FOREIGN KEY ("cam_post_id") REFERENCES "cam_post"("cam_post_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cam_post_order" ADD CONSTRAINT "cam_post_order_cam_post_id_fkey" FOREIGN KEY ("cam_post_id") REFERENCES "cam_post"("cam_post_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cam_post_order" ADD CONSTRAINT "cam_post_order_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "checkouts"("checkout_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cam_post_order" ADD CONSTRAINT "cam_post_order_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "candidate" ADD CONSTRAINT "candidate_candidate_user_id_fkey" FOREIGN KEY ("candidate_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "carpool_booking" ADD CONSTRAINT "carpool_booking_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "carpool_offer"("carpool_offer_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "carpool_booking" ADD CONSTRAINT "carpool_booking_passenger_id_fkey" FOREIGN KEY ("passenger_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "carpool_offer" ADD CONSTRAINT "carpool_offer_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver_profile"("driver_profile_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "carpool_offer" ADD CONSTRAINT "carpool_offer_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("vehicle_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "carpool_waypoints" ADD CONSTRAINT "carpool_waypoints_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "carpool_offer"("carpool_offer_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chat_channel" ADD CONSTRAINT "chat_channel_platform_type_id_fkey" FOREIGN KEY ("platform_type_id") REFERENCES "platform_type"("platform_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channel"("channel_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_platform_type_id_fkey" FOREIGN KEY ("platform_type_id") REFERENCES "platform_type"("platform_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channel"("channel_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_platform_type_id_fkey" FOREIGN KEY ("platform_type_id") REFERENCES "platform_type"("platform_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "journal_highlight" ADD CONSTRAINT "journal_highlight_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channel"("channel_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "journal_highlight" ADD CONSTRAINT "journal_highlight_saved_by_fkey" FOREIGN KEY ("saved_by") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "journal_bucket_item" ADD CONSTRAINT "journal_bucket_item_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channel"("channel_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "journal_bucket_item" ADD CONSTRAINT "journal_bucket_item_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "journal_time_capsule" ADD CONSTRAINT "journal_time_capsule_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "chat_channel"("channel_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "journal_time_capsule" ADD CONSTRAINT "journal_time_capsule_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "journal_time_capsule" ADD CONSTRAINT "journal_time_capsule_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "checkouts" ADD CONSTRAINT "checkouts_share_id_fkey" FOREIGN KEY ("share_id") REFERENCES "shared_ref_code"("share_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cloth" ADD CONSTRAINT "cloth_cloth_category_id_fkey" FOREIGN KEY ("cloth_category_id") REFERENCES "cloth_category"("cloth_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cloth" ADD CONSTRAINT "cloth_cloth_type_id_fkey" FOREIGN KEY ("cloth_type_id") REFERENCES "cloth_type"("cloth_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cloth" ADD CONSTRAINT "cloth_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_platform_type_id_fkey" FOREIGN KEY ("platform_type_id") REFERENCES "platform_type"("platform_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_receiver_id_fkey" FOREIGN KEY ("receiver_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "connections" ADD CONSTRAINT "connections_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "courier_customer" ADD CONSTRAINT "courier_customer_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "courier_order" ADD CONSTRAINT "courier_order_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "checkouts"("checkout_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "courier_order" ADD CONSTRAINT "courier_order_courier_service_provider_id_fkey" FOREIGN KEY ("courier_service_provider_id") REFERENCES "courier_service_provider"("courier_service_provider_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "courier_order" ADD CONSTRAINT "courier_order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "courier_customer"("customer_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "courier_service_provider" ADD CONSTRAINT "courier_service_provider_courier_service_provider_user_id_fkey" FOREIGN KEY ("courier_service_provider_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cs_categories" ADD CONSTRAINT "cs_categories_cs_type_id_fkey" FOREIGN KEY ("cs_type_id") REFERENCES "cs_type"("cs_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cs_content" ADD CONSTRAINT "cs_content_cs_category_id_fkey" FOREIGN KEY ("cs_category_id") REFERENCES "cs_categories"("cs_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cs_content" ADD CONSTRAINT "cs_content_cs_type_id_fkey" FOREIGN KEY ("cs_type_id") REFERENCES "cs_type"("cs_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "cycle_prediction" ADD CONSTRAINT "cycle_prediction_flo_user_id_fkey" FOREIGN KEY ("flo_user_id") REFERENCES "flo_user"("flo_user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "delivery_driver" ADD CONSTRAINT "delivery_driver_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "delivery_driver" ADD CONSTRAINT "delivery_driver_vendor_type_id_fkey" FOREIGN KEY ("vendor_type_id") REFERENCES "vendor_type"("vendor_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dg_cart" ADD CONSTRAINT "dg_cart_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dg_cart" ADD CONSTRAINT "dg_cart_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "dg_content"("content_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dg_cart" ADD CONSTRAINT "dg_cart_dg_category_id_fkey" FOREIGN KEY ("dg_category_id") REFERENCES "dg_categories"("dg_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dg_content" ADD CONSTRAINT "dg_content_dg_category_id_fkey" FOREIGN KEY ("dg_category_id") REFERENCES "dg_categories"("dg_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dg_order" ADD CONSTRAINT "dg_order_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dg_order" ADD CONSTRAINT "dg_order_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "checkouts"("checkout_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dg_order" ADD CONSTRAINT "dg_order_content_id_fkey" FOREIGN KEY ("content_id") REFERENCES "dg_content"("content_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "dg_order" ADD CONSTRAINT "dg_order_dg_category_id_fkey" FOREIGN KEY ("dg_category_id") REFERENCES "dg_categories"("dg_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "discord_server" ADD CONSTRAINT "discord_server_server_owner_fkey" FOREIGN KEY ("server_owner") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "discord_stream" ADD CONSTRAINT "discord_stream_server_member_id_fkey" FOREIGN KEY ("server_member_id") REFERENCES "server_members"("server_member_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "donations" ADD CONSTRAINT "donations_donated_user_id_fkey" FOREIGN KEY ("donated_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "donations" ADD CONSTRAINT "donations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("project_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_profile" ADD CONSTRAINT "driver_profile_booking_type_id_fkey" FOREIGN KEY ("booking_type_id") REFERENCES "booking_type"("booking_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_profile" ADD CONSTRAINT "driver_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "emergency_contact" ADD CONSTRAINT "emergency_contact_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("employee_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employee_attendance" ADD CONSTRAINT "employee_attendance_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("employee_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_employee_user_id_fkey" FOREIGN KEY ("employee_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flash_card" ADD CONSTRAINT "flash_card_flash_card_category_id_fkey" FOREIGN KEY ("flash_card_category_id") REFERENCES "flash_card_category"("flash_card_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flash_card" ADD CONSTRAINT "flash_card_flash_card_creator_fkey" FOREIGN KEY ("flash_card_creator") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flash_card" ADD CONSTRAINT "flash_card_flash_card_deck_id_fkey" FOREIGN KEY ("flash_card_deck_id") REFERENCES "flash_card_deck"("flash_card_deck_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flash_card_deck" ADD CONSTRAINT "flash_card_deck_flash_card_deck_category_id_fkey" FOREIGN KEY ("flash_card_deck_category_id") REFERENCES "flash_card_category"("flash_card_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flash_card_deck" ADD CONSTRAINT "flash_card_deck_flash_card_deck_creator_fkey" FOREIGN KEY ("flash_card_deck_creator") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flash_card_deck_user" ADD CONSTRAINT "flash_card_deck_user_flash_card_deck_id_fkey" FOREIGN KEY ("flash_card_deck_id") REFERENCES "flash_card_deck"("flash_card_deck_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flash_card_deck_user" ADD CONSTRAINT "flash_card_deck_user_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flash_card_user_do" ADD CONSTRAINT "flash_card_user_do_flash_card_id_fkey" FOREIGN KEY ("flash_card_id") REFERENCES "flash_card"("flash_card_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flash_card_user_do" ADD CONSTRAINT "flash_card_user_do_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "flo_user" ADD CONSTRAINT "flo_user_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_category" ADD CONSTRAINT "food_category_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_category" ADD CONSTRAINT "food_category_vendor_type_id_fkey" FOREIGN KEY ("vendor_type_id") REFERENCES "vendor_type"("vendor_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_item" ADD CONSTRAINT "food_item_food_category_id_fkey" FOREIGN KEY ("food_category_id") REFERENCES "food_category"("food_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_item" ADD CONSTRAINT "food_item_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_item" ADD CONSTRAINT "food_item_vendor_type_id_fkey" FOREIGN KEY ("vendor_type_id") REFERENCES "vendor_type"("vendor_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_item_modifier_group" ADD CONSTRAINT "food_item_modifier_group_food_item_id_fkey" FOREIGN KEY ("food_item_id") REFERENCES "food_item"("food_item_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_item_modifier_option" ADD CONSTRAINT "food_item_modifier_option_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "food_item_modifier_group"("group_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_item_pics" ADD CONSTRAINT "food_item_pics_food_item_id_fkey" FOREIGN KEY ("food_item_id") REFERENCES "food_item"("food_item_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_item_pics" ADD CONSTRAINT "food_item_pics_vendor_type_id_fkey" FOREIGN KEY ("vendor_type_id") REFERENCES "vendor_type"("vendor_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_order" ADD CONSTRAINT "food_order_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "delivery_driver"("driver_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_order" ADD CONSTRAINT "food_order_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_order" ADD CONSTRAINT "food_order_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_order" ADD CONSTRAINT "food_order_vendor_type_id_fkey" FOREIGN KEY ("vendor_type_id") REFERENCES "vendor_type"("vendor_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_order_items" ADD CONSTRAINT "food_order_items_food_item_id_fkey" FOREIGN KEY ("food_item_id") REFERENCES "food_item"("food_item_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_order_items" ADD CONSTRAINT "food_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "food_order"("food_order_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_order_items" ADD CONSTRAINT "food_order_items_vendor_type_id_fkey" FOREIGN KEY ("vendor_type_id") REFERENCES "vendor_type"("vendor_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_vendor" ADD CONSTRAINT "food_vendor_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_vendor" ADD CONSTRAINT "food_vendor_vendor_type_id_fkey" FOREIGN KEY ("vendor_type_id") REFERENCES "vendor_type"("vendor_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "hire_influencer" ADD CONSTRAINT "hire_influencer_influencer_id_fkey" FOREIGN KEY ("influencer_id") REFERENCES "influencer"("influencer_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "hire_influencer" ADD CONSTRAINT "hire_influencer_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "influencer" ADD CONSTRAINT "influencer_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "job_application" ADD CONSTRAINT "job_application_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "candidate"("candidate_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "job_application" ADD CONSTRAINT "job_application_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("job_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("agent_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_job_category_id_fkey" FOREIGN KEY ("job_category_id") REFERENCES "job_categories"("job_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "leave" ADD CONSTRAINT "leave_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("employee_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lesson" ADD CONSTRAINT "lesson_language_id_fkey" FOREIGN KEY ("language_id") REFERENCES "language"("language_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lesson_user" ADD CONSTRAINT "lesson_user_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lesson"("lesson_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lesson_user" ADD CONSTRAINT "lesson_user_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loan_payment" ADD CONSTRAINT "loan_payment_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "loans"("loan_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loan_provider" ADD CONSTRAINT "loan_provider_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_loan_provider_id_fkey" FOREIGN KEY ("loan_provider_id") REFERENCES "loan_provider"("loan_provider_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_property_id_fkey" FOREIGN KEY ("property_id") REFERENCES "property"("property_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "loans" ADD CONSTRAINT "loans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meetup_attendees" ADD CONSTRAINT "meetup_attendees_meetup_event_id_fkey" FOREIGN KEY ("meetup_event_id") REFERENCES "meetup_event"("meetup_event_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meetup_attendees" ADD CONSTRAINT "meetup_attendees_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meetup_event" ADD CONSTRAINT "meetup_event_meetup_event_category_id_fkey" FOREIGN KEY ("meetup_event_category_id") REFERENCES "meetup_category"("meetup_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meetup_event" ADD CONSTRAINT "meetup_event_meetup_event_organizer_fkey" FOREIGN KEY ("meetup_event_organizer") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "meetup_event_image" ADD CONSTRAINT "meetup_event_image_meetup_event_id_fkey" FOREIGN KEY ("meetup_event_id") REFERENCES "meetup_event"("meetup_event_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payrolls" ADD CONSTRAINT "payrolls_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("employee_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "period" ADD CONSTRAINT "period_flo_user_id_fkey" FOREIGN KEY ("flo_user_id") REFERENCES "flo_user"("flo_user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "place" ADD CONSTRAINT "place_event_type_id_fkey" FOREIGN KEY ("event_type_id") REFERENCES "event_type"("event_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "place" ADD CONSTRAINT "place_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "place_orders" ADD CONSTRAINT "place_orders_event_type_id_fkey" FOREIGN KEY ("event_type_id") REFERENCES "event_type"("event_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "place_orders" ADD CONSTRAINT "place_orders_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "place"("place_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "place_orders" ADD CONSTRAINT "place_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "place_pics" ADD CONSTRAINT "place_pics_event_type_id_fkey" FOREIGN KEY ("event_type_id") REFERENCES "event_type"("event_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "place_pics" ADD CONSTRAINT "place_pics_place_id_fkey" FOREIGN KEY ("place_id") REFERENCES "place"("place_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_cart" ADD CONSTRAINT "product_cart_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_cart" ADD CONSTRAINT "product_cart_product_type_id_fkey" FOREIGN KEY ("product_type_id") REFERENCES "product_type"("product_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_cart" ADD CONSTRAINT "product_cart_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_cart" ADD CONSTRAINT "product_cart_variation_id_fkey" FOREIGN KEY ("variation_id") REFERENCES "product_variation"("variation_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_listing" ADD CONSTRAINT "product_listing_product_type_id_fkey" FOREIGN KEY ("product_type_id") REFERENCES "product_type"("product_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_listing" ADD CONSTRAINT "product_listing_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_order" ADD CONSTRAINT "product_order_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_order" ADD CONSTRAINT "product_order_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "checkouts"("checkout_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_order" ADD CONSTRAINT "product_order_product_type_id_fkey" FOREIGN KEY ("product_type_id") REFERENCES "product_type"("product_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_order" ADD CONSTRAINT "product_order_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_order" ADD CONSTRAINT "product_order_variation_id_fkey" FOREIGN KEY ("variation_id") REFERENCES "product_variation"("variation_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_ratings" ADD CONSTRAINT "product_ratings_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_ratings" ADD CONSTRAINT "product_ratings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "product_order"("order_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_ratings" ADD CONSTRAINT "product_ratings_product_type_id_fkey" FOREIGN KEY ("product_type_id") REFERENCES "product_type"("product_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_ratings" ADD CONSTRAINT "product_ratings_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_variation" ADD CONSTRAINT "product_variation_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "product_listing"("listing_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "product_variation" ADD CONSTRAINT "product_variation_product_type_id_fkey" FOREIGN KEY ("product_type_id") REFERENCES "product_type"("product_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "professional_profile" ADD CONSTRAINT "professional_profile_platform_type_id_fkey" FOREIGN KEY ("platform_type_id") REFERENCES "platform_type"("platform_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "professional_profile" ADD CONSTRAINT "professional_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reward_tier" ADD CONSTRAINT "reward_tier_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("project_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "campaign_update" ADD CONSTRAINT "campaign_update_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("project_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "campaign_payout" ADD CONSTRAINT "campaign_payout_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("project_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "property" ADD CONSTRAINT "property_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "question_answer_user" ADD CONSTRAINT "question_answer_user_question_option_answer_id_fkey" FOREIGN KEY ("question_option_answer_id") REFERENCES "question_option_answer"("question_option_answer_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "question_answer_user" ADD CONSTRAINT "question_answer_user_question_option_id_fkey" FOREIGN KEY ("question_option_id") REFERENCES "question_option"("question_option_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "question_answer_user" ADD CONSTRAINT "question_answer_user_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "question_option" ADD CONSTRAINT "question_option_lesson_id_fkey" FOREIGN KEY ("lesson_id") REFERENCES "lesson"("lesson_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "question_option_answer" ADD CONSTRAINT "question_option_answer_question_option_id_fkey" FOREIGN KEY ("question_option_id") REFERENCES "question_option"("question_option_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_cart" ADD CONSTRAINT "rental_cart_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_cart" ADD CONSTRAINT "rental_cart_rental_listing_id_fkey" FOREIGN KEY ("rental_listing_id") REFERENCES "rental_listing"("rental_listing_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_cart" ADD CONSTRAINT "rental_cart_rental_type_id_fkey" FOREIGN KEY ("rental_type_id") REFERENCES "rental_type"("rental_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_categories" ADD CONSTRAINT "rental_categories_rental_type_id_fkey" FOREIGN KEY ("rental_type_id") REFERENCES "rental_type"("rental_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_listing" ADD CONSTRAINT "rental_listing_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_listing" ADD CONSTRAINT "rental_listing_rental_category_id_fkey" FOREIGN KEY ("rental_category_id") REFERENCES "rental_categories"("rental_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_listing" ADD CONSTRAINT "rental_listing_rental_type_id_fkey" FOREIGN KEY ("rental_type_id") REFERENCES "rental_type"("rental_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_listing_pics" ADD CONSTRAINT "rental_listing_pics_rental_listing_id_fkey" FOREIGN KEY ("rental_listing_id") REFERENCES "rental_listing"("rental_listing_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_listing_pics" ADD CONSTRAINT "rental_listing_pics_rental_type_id_fkey" FOREIGN KEY ("rental_type_id") REFERENCES "rental_type"("rental_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_order" ADD CONSTRAINT "rental_order_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_order" ADD CONSTRAINT "rental_order_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "checkouts"("checkout_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_order" ADD CONSTRAINT "rental_order_rental_listing_id_fkey" FOREIGN KEY ("rental_listing_id") REFERENCES "rental_listing"("rental_listing_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_order" ADD CONSTRAINT "rental_order_rental_type_id_fkey" FOREIGN KEY ("rental_type_id") REFERENCES "rental_type"("rental_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_ratings" ADD CONSTRAINT "rental_ratings_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_ratings" ADD CONSTRAINT "rental_ratings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "rental_order"("order_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "rental_ratings" ADD CONSTRAINT "rental_ratings_rental_type_id_fkey" FOREIGN KEY ("rental_type_id") REFERENCES "rental_type"("rental_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ride_request" ADD CONSTRAINT "ride_request_passenger_id_fkey" FOREIGN KEY ("passenger_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ride_request" ADD CONSTRAINT "ride_request_requested_type_id_fkey" FOREIGN KEY ("requested_type_id") REFERENCES "vehicle_types"("vehicle_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "discord_server"("server_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "server_message" ADD CONSTRAINT "server_message_sender_user_id_fkey" FOREIGN KEY ("sender_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "server_message" ADD CONSTRAINT "server_message_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "discord_server"("server_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_cart" ADD CONSTRAINT "service_cart_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_cart" ADD CONSTRAINT "service_cart_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "user_service_provider"("provider_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_cart" ADD CONSTRAINT "service_cart_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_type"("service_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_category" ADD CONSTRAINT "service_category_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_type"("service_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_cv" ADD CONSTRAINT "service_cv_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "user_service_provider"("provider_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_cv" ADD CONSTRAINT "service_cv_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_type"("service_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_checkout_id_fkey" FOREIGN KEY ("checkout_id") REFERENCES "checkouts"("checkout_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "user_service_provider"("provider_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_order" ADD CONSTRAINT "service_order_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_type"("service_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_ratings" ADD CONSTRAINT "service_ratings_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_ratings" ADD CONSTRAINT "service_ratings_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "service_order"("order_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_ratings" ADD CONSTRAINT "service_ratings_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "user_service_provider"("provider_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "service_ratings" ADD CONSTRAINT "service_ratings_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_type"("service_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_service_category_id_fkey" FOREIGN KEY ("service_category_id") REFERENCES "service_category"("service_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_type"("service_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "shared_ref_code" ADD CONSTRAINT "shared_ref_code_ref_code_fkey" FOREIGN KEY ("ref_code") REFERENCES "user"("ref_code") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "shared_ref_code" ADD CONSTRAINT "shared_ref_code_shared_to_fkey" FOREIGN KEY ("shared_to") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "shift" ADD CONSTRAINT "shift_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("employee_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "social_comments" ADD CONSTRAINT "social_comments_parent_comment_id_fkey" FOREIGN KEY ("parent_comment_id") REFERENCES "social_comments"("comment_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "social_comments" ADD CONSTRAINT "social_comments_platform_type_id_fkey" FOREIGN KEY ("platform_type_id") REFERENCES "platform_type"("platform_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "social_comments" ADD CONSTRAINT "social_comments_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_comments" ADD CONSTRAINT "social_comments_social_post_id_fkey" FOREIGN KEY ("social_post_id") REFERENCES "social_feed"("social_post_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "social_feed" ADD CONSTRAINT "social_feed_platform_type_id_fkey" FOREIGN KEY ("platform_type_id") REFERENCES "platform_type"("platform_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "social_feed" ADD CONSTRAINT "social_feed_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_interactions" ADD CONSTRAINT "social_interactions_platform_type_id_fkey" FOREIGN KEY ("platform_type_id") REFERENCES "platform_type"("platform_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "social_interactions" ADD CONSTRAINT "social_interactions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_interactions" ADD CONSTRAINT "social_interactions_social_post_id_fkey" FOREIGN KEY ("social_post_id") REFERENCES "social_feed"("social_post_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "social_media_attachments" ADD CONSTRAINT "social_media_attachments_platform_type_id_fkey" FOREIGN KEY ("platform_type_id") REFERENCES "platform_type"("platform_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "social_media_attachments" ADD CONSTRAINT "social_media_attachments_social_post_id_fkey" FOREIGN KEY ("social_post_id") REFERENCES "social_feed"("social_post_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stream" ADD CONSTRAINT "stream_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "streamer"("streamer_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stream_chat" ADD CONSTRAINT "stream_chat_stream_id_fkey" FOREIGN KEY ("stream_id") REFERENCES "stream"("stream_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "stream_chat" ADD CONSTRAINT "stream_chat_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "streamer" ADD CONSTRAINT "streamer_streamer_user_id_fkey" FOREIGN KEY ("streamer_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "symptom_log" ADD CONSTRAINT "symptom_log_flo_user_id_fkey" FOREIGN KEY ("flo_user_id") REFERENCES "flo_user"("flo_user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "symptom_log" ADD CONSTRAINT "symptom_log_symptom_type_id_fkey" FOREIGN KEY ("symptom_type_id") REFERENCES "symptom_types"("symptom_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "talent" ADD CONSTRAINT "talent_talent_category_id_fkey" FOREIGN KEY ("talent_category_id") REFERENCES "talent_category"("talent_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "talent" ADD CONSTRAINT "talent_talent_user_id_fkey" FOREIGN KEY ("talent_user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_content_subscription_mapping" ADD CONSTRAINT "user_content_subscription_mapping_cs_type_id_fkey" FOREIGN KEY ("cs_type_id") REFERENCES "cs_type"("cs_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_content_subscription_mapping" ADD CONSTRAINT "user_content_subscription_mapping_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_service_provider" ADD CONSTRAINT "user_service_provider_service_category_id_fkey" FOREIGN KEY ("service_category_id") REFERENCES "service_category"("service_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_service_provider" ADD CONSTRAINT "user_service_provider_service_type_id_fkey" FOREIGN KEY ("service_type_id") REFERENCES "service_type"("service_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_service_provider" ADD CONSTRAINT "user_service_provider_services_id_fkey" FOREIGN KEY ("services_id") REFERENCES "services"("services_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_service_provider" ADD CONSTRAINT "user_service_provider_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "community" ADD CONSTRAINT "community_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_member" ADD CONSTRAINT "community_member_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "community"("community_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_member" ADD CONSTRAINT "community_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "community"("community_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_comment" ADD CONSTRAINT "community_post_comment_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "community_post_comment"("comment_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "community_post_comment" ADD CONSTRAINT "community_post_comment_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "community_posts"("community_post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_comment" ADD CONSTRAINT "community_post_comment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_vote" ADD CONSTRAINT "community_post_vote_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "community_posts"("community_post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_vote" ADD CONSTRAINT "community_post_vote_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_comment_vote" ADD CONSTRAINT "community_comment_vote_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "community_post_comment"("comment_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_comment_vote" ADD CONSTRAINT "community_comment_vote_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_save" ADD CONSTRAINT "community_post_save_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "community_posts"("community_post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_save" ADD CONSTRAINT "community_post_save_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_item" ADD CONSTRAINT "saved_item_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pin" ADD CONSTRAINT "pin_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pin_save" ADD CONSTRAINT "pin_save_pin_id_fkey" FOREIGN KEY ("pin_id") REFERENCES "pin"("pin_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pin_save" ADD CONSTRAINT "pin_save_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pin_comment" ADD CONSTRAINT "pin_comment_pin_id_fkey" FOREIGN KEY ("pin_id") REFERENCES "pin"("pin_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pin_comment" ADD CONSTRAINT "pin_comment_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_booking_type_id_fkey" FOREIGN KEY ("booking_type_id") REFERENCES "booking_type"("booking_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver_profile"("driver_profile_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_vehicle_type_id_fkey" FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_types"("vehicle_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "vehicle_types" ADD CONSTRAINT "vehicle_types_booking_type_id_fkey" FOREIGN KEY ("booking_type_id") REFERENCES "booking_type"("booking_type_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "food_cart" ADD CONSTRAINT "food_cart_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_cart" ADD CONSTRAINT "food_cart_food_item_id_fkey" FOREIGN KEY ("food_item_id") REFERENCES "food_item"("food_item_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "food_cart" ADD CONSTRAINT "food_cart_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_rating" ADD CONSTRAINT "ride_rating_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "active_trip"("trip_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ride_rating" ADD CONSTRAINT "ride_rating_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel" ADD CONSTRAINT "channel_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video" ADD CONSTRAINT "video_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel"("channel_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_analytics" ADD CONSTRAINT "video_analytics_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "video"("video_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channel"("channel_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_comments" ADD CONSTRAINT "video_comments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_comments" ADD CONSTRAINT "video_comments_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "video"("video_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_comment_likes" ADD CONSTRAINT "video_comment_likes_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "video_comments"("comment_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_comment_likes" ADD CONSTRAINT "video_comment_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_likes" ADD CONSTRAINT "video_likes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_likes" ADD CONSTRAINT "video_likes_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "video"("video_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_watch_later" ADD CONSTRAINT "video_watch_later_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_watch_later" ADD CONSTRAINT "video_watch_later_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "video"("video_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist" ADD CONSTRAINT "playlist_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_item" ADD CONSTRAINT "playlist_item_playlist_id_fkey" FOREIGN KEY ("playlist_id") REFERENCES "playlist"("playlist_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playlist_item" ADD CONSTRAINT "playlist_item_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "video"("video_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_address" ADD CONSTRAINT "user_address_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_history" ADD CONSTRAINT "watch_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_history" ADD CONSTRAINT "watch_history_video_id_fkey" FOREIGN KEY ("video_id") REFERENCES "video"("video_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strug_wallet" ADD CONSTRAINT "strug_wallet_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transaction" ADD CONSTRAINT "wallet_transaction_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vertical_profile" ADD CONSTRAINT "vertical_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_profile" ADD CONSTRAINT "social_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follower" ADD CONSTRAINT "follower_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "social_profile"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follower" ADD CONSTRAINT "follower_following_id_fkey" FOREIGN KEY ("following_id") REFERENCES "social_profile"("profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_story" ADD CONSTRAINT "social_story_highlight_id_fkey" FOREIGN KEY ("highlight_id") REFERENCES "social_highlight"("highlight_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_story" ADD CONSTRAINT "social_story_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_view" ADD CONSTRAINT "story_view_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "story_view" ADD CONSTRAINT "story_view_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "social_story"("story_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_highlight" ADD CONSTRAINT "social_highlight_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_bookmark" ADD CONSTRAINT "social_bookmark_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_bookmark" ADD CONSTRAINT "social_bookmark_social_post_id_fkey" FOREIGN KEY ("social_post_id") REFERENCES "social_feed"("social_post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_search_history" ADD CONSTRAINT "social_search_history_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_block" ADD CONSTRAINT "social_block_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_block" ADD CONSTRAINT "social_block_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_mute" ADD CONSTRAINT "social_mute_muted_id_fkey" FOREIGN KEY ("muted_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_mute" ADD CONSTRAINT "social_mute_muter_id_fkey" FOREIGN KEY ("muter_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_friend" ADD CONSTRAINT "close_friend_friend_id_fkey" FOREIGN KEY ("friend_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "close_friend" ADD CONSTRAINT "close_friend_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_report" ADD CONSTRAINT "social_report_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_appeal" ADD CONSTRAINT "content_appeal_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_notification" ADD CONSTRAINT "social_notification_receiver_id_fkey" FOREIGN KEY ("receiver_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_notification" ADD CONSTRAINT "social_notification_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_post_view" ADD CONSTRAINT "social_post_view_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "social_feed"("social_post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_post_view" ADD CONSTRAINT "social_post_view_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_audit_log" ADD CONSTRAINT "social_audit_log_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_activity_event" ADD CONSTRAINT "user_activity_event_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_alert" ADD CONSTRAINT "user_alert_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_note" ADD CONSTRAINT "user_note_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_tag" ADD CONSTRAINT "user_tag_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profile_history" ADD CONSTRAINT "user_profile_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_streamer_social_links" ADD CONSTRAINT "live_streamer_social_links_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_streamer_wallet" ADD CONSTRAINT "live_streamer_wallet_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_streamer_wallet" ADD CONSTRAINT "live_streamer_wallet_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_subscription" ADD CONSTRAINT "live_subscription_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_subscription" ADD CONSTRAINT "live_subscription_subscriber_user_id_fkey" FOREIGN KEY ("subscriber_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_streamer_profile" ADD CONSTRAINT "live_streamer_profile_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "live_stream_category"("category_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_streamer_profile" ADD CONSTRAINT "live_streamer_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_session" ADD CONSTRAINT "live_session_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_chat_message" ADD CONSTRAINT "live_chat_message_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "live_session"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_stream_schedule" ADD CONSTRAINT "live_stream_schedule_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post" ADD CONSTRAINT "community_post_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_poll_option" ADD CONSTRAINT "community_poll_option_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "community_post"("post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_poll_vote" ADD CONSTRAINT "community_poll_vote_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "community_poll_option"("option_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_post_like" ADD CONSTRAINT "community_post_like_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "community_post"("post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_stream_guest" ADD CONSTRAINT "live_stream_guest_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "live_session"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_stream_guest" ADD CONSTRAINT "live_stream_guest_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_chat_moderator" ADD CONSTRAINT "live_chat_moderator_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_chat_moderator" ADD CONSTRAINT "live_chat_moderator_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_chat_ban" ADD CONSTRAINT "live_chat_ban_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_chat_ban" ADD CONSTRAINT "live_chat_ban_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_banned_word" ADD CONSTRAINT "live_banned_word_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_vod" ADD CONSTRAINT "live_vod_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "live_session"("session_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_vod" ADD CONSTRAINT "live_vod_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_monetization_request" ADD CONSTRAINT "live_monetization_request_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "live_payout_request" ADD CONSTRAINT "live_payout_request_streamer_id_fkey" FOREIGN KEY ("streamer_id") REFERENCES "live_streamer_profile"("streamer_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "town_hall_post" ADD CONSTRAINT "town_hall_post_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "town_hall_post"("post_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "town_hall_post" ADD CONSTRAINT "town_hall_post_quote_post_id_fkey" FOREIGN KEY ("quote_post_id") REFERENCES "town_hall_post"("post_id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "town_hall_post" ADD CONSTRAINT "town_hall_post_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "town_hall_post_like" ADD CONSTRAINT "town_hall_post_like_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "town_hall_post"("post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "town_hall_post_like" ADD CONSTRAINT "town_hall_post_like_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "town_hall_repost" ADD CONSTRAINT "town_hall_repost_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "town_hall_post"("post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "town_hall_repost" ADD CONSTRAINT "town_hall_repost_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "town_hall_post_view" ADD CONSTRAINT "fk_post" FOREIGN KEY ("post_id") REFERENCES "town_hall_post"("post_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "town_hall_post_view" ADD CONSTRAINT "fk_user" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "town_hall_post_save" ADD CONSTRAINT "fk_thps_post" FOREIGN KEY ("post_id") REFERENCES "town_hall_post"("post_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "town_hall_post_save" ADD CONSTRAINT "fk_thps_user" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "food_vendor"("vendor_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_wallet" ADD CONSTRAINT "ads_wallet_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_account_profile" ADD CONSTRAINT "ads_account_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_member" ADD CONSTRAINT "ads_member_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "ads_account_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_member" ADD CONSTRAINT "ads_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_brand_profile" ADD CONSTRAINT "ads_brand_profile_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "ads_account_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_tos_agreement" ADD CONSTRAINT "ads_tos_agreement_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "ads_account_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_tos_agreement" ADD CONSTRAINT "ads_tos_agreement_signed_by_user_id_fkey" FOREIGN KEY ("signed_by_user_id") REFERENCES "user"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_campaign" ADD CONSTRAINT "ads_campaign_ads_wallet_id_fkey" FOREIGN KEY ("ads_wallet_id") REFERENCES "ads_wallet"("ads_wallet_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads_targeting_profile" ADD CONSTRAINT "ads_targeting_profile_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ads_campaign"("campaign_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bug_report" ADD CONSTRAINT "bug_report_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bug_report_screenshot" ADD CONSTRAINT "bug_report_screenshot_report_fkey" FOREIGN KEY ("bug_report_id") REFERENCES "bug_report"("bug_report_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_profile" ADD CONSTRAINT "store_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_category" ADD CONSTRAINT "work_category_parent_fkey" FOREIGN KEY ("parent_id") REFERENCES "work_category"("work_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "worker_profile" ADD CONSTRAINT "worker_profile_user_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "worker_category" ADD CONSTRAINT "worker_category_category_fkey" FOREIGN KEY ("work_category_id") REFERENCES "work_category"("work_category_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "worker_category" ADD CONSTRAINT "worker_category_worker_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profile"("worker_profile_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_job" ADD CONSTRAINT "work_job_category_fkey" FOREIGN KEY ("category_id") REFERENCES "work_category"("work_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_job" ADD CONSTRAINT "work_job_hirer_fkey" FOREIGN KEY ("hirer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_job_offer" ADD CONSTRAINT "work_job_offer_job_fkey" FOREIGN KEY ("work_job_id") REFERENCES "work_job"("work_job_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_job_offer" ADD CONSTRAINT "work_job_offer_worker_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profile"("worker_profile_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_review" ADD CONSTRAINT "work_review_job_fkey" FOREIGN KEY ("work_job_id") REFERENCES "work_job"("work_job_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_review" ADD CONSTRAINT "work_review_reviewer_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_review" ADD CONSTRAINT "work_review_worker_fkey" FOREIGN KEY ("worker_profile_id") REFERENCES "worker_profile"("worker_profile_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "availability" ADD CONSTRAINT "availability_listing_fkey" FOREIGN KEY ("booking_listing_id") REFERENCES "booking_listing"("booking_listing_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_listing_fkey" FOREIGN KEY ("booking_listing_id") REFERENCES "booking_listing"("booking_listing_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "booking_event" ADD CONSTRAINT "booking_event_booking_fkey" FOREIGN KEY ("booking_id") REFERENCES "booking"("booking_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "work_notification" ADD CONSTRAINT "work_notification_user_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_category" ADD CONSTRAINT "quote_category_parent_fkey" FOREIGN KEY ("parent_id") REFERENCES "quote_category"("quote_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_provider" ADD CONSTRAINT "quote_provider_user_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_provider_city" ADD CONSTRAINT "quote_provider_city_provider_fkey" FOREIGN KEY ("quote_provider_id") REFERENCES "quote_provider"("quote_provider_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_provider_category" ADD CONSTRAINT "quote_prov_cat_category_fkey" FOREIGN KEY ("quote_category_id") REFERENCES "quote_category"("quote_category_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_provider_category" ADD CONSTRAINT "quote_prov_cat_provider_fkey" FOREIGN KEY ("quote_provider_id") REFERENCES "quote_provider"("quote_provider_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_request" ADD CONSTRAINT "quote_request_category_fkey" FOREIGN KEY ("category_id") REFERENCES "quote_category"("quote_category_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_request" ADD CONSTRAINT "quote_request_requester_fkey" FOREIGN KEY ("requester_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_qp_fkey" FOREIGN KEY ("provider_id") REFERENCES "quote_provider"("quote_provider_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_qr_fkey" FOREIGN KEY ("quote_request_id") REFERENCES "quote_request"("quote_request_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_appointment" ADD CONSTRAINT "quote_appt_provider_fkey" FOREIGN KEY ("provider_id") REFERENCES "quote_provider"("quote_provider_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_appointment" ADD CONSTRAINT "quote_appt_quote_fkey" FOREIGN KEY ("quote_id") REFERENCES "quote"("quote_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_appointment" ADD CONSTRAINT "quote_appt_request_fkey" FOREIGN KEY ("quote_request_id") REFERENCES "quote_request"("quote_request_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_appointment" ADD CONSTRAINT "quote_appt_requester_fkey" FOREIGN KEY ("requester_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_provider_availability" ADD CONSTRAINT "quote_prov_avail_provider_fkey" FOREIGN KEY ("quote_provider_id") REFERENCES "quote_provider"("quote_provider_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "quote_notification" ADD CONSTRAINT "quote_notification_user_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("user_id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wishlist_item" ADD CONSTRAINT "wishlist_item_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wishlist_contribution" ADD CONSTRAINT "wishlist_contribution_wishlist_item_id_fkey" FOREIGN KEY ("wishlist_item_id") REFERENCES "wishlist_item"("wishlist_item_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "wishlist_contribution" ADD CONSTRAINT "wishlist_contribution_contributor_id_fkey" FOREIGN KEY ("contributor_id") REFERENCES "user"("user_id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "_social_feedTosocial_tag" ADD CONSTRAINT "_social_feedTosocial_tag_A_fkey" FOREIGN KEY ("A") REFERENCES "social_feed"("social_post_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_social_feedTosocial_tag" ADD CONSTRAINT "_social_feedTosocial_tag_B_fkey" FOREIGN KEY ("B") REFERENCES "social_tag"("tag_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_social_profileTosocial_tag" ADD CONSTRAINT "_social_profileTosocial_tag_A_fkey" FOREIGN KEY ("A") REFERENCES "social_profile"("profile_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_social_profileTosocial_tag" ADD CONSTRAINT "_social_profileTosocial_tag_B_fkey" FOREIGN KEY ("B") REFERENCES "social_tag"("tag_id") ON DELETE CASCADE ON UPDATE CASCADE;

