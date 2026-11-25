-- RBAC v2 for the internal board (2026-07-13). Introduces named roles with a per-dashboard
-- access map, replacing the coarse can_* flags as the enforcement primitive. Additive only:
-- the legacy can_* columns are kept (deprecated) for backfill/rollback. Built-in roles and
-- per-member role assignment are populated by scripts/seed-board-roles.js after this runs.

-- The role table: access is { dashboardId: "read" | "write" } (absent = no access).
CREATE TABLE "board_role" (
    "role_id"        SERIAL       NOT NULL,
    "key"            VARCHAR(60)  NOT NULL,
    "name"           VARCHAR(120) NOT NULL,
    "description"    VARCHAR(500),
    "is_builtin"     BOOLEAN      NOT NULL DEFAULT false,
    "access"         JSONB        NOT NULL DEFAULT '{}',
    "manage_members" BOOLEAN      NOT NULL DEFAULT false,
    "review_tasks"   BOOLEAN      NOT NULL DEFAULT false,
    "assign_tasks"   BOOLEAN      NOT NULL DEFAULT false,
    "is_super_admin" BOOLEAN      NOT NULL DEFAULT false,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "board_role_pkey" PRIMARY KEY ("role_id")
);

CREATE UNIQUE INDEX "board_role_key_key" ON "board_role"("key");
CREATE INDEX "idx_board_role_builtin" ON "board_role"("is_builtin");

-- The member's assigned role + optional per-member override map ("Custom" tuning).
ALTER TABLE "board_member" ADD COLUMN "role_id" INTEGER;
ALTER TABLE "board_member" ADD COLUMN "access_overrides" JSONB;

CREATE INDEX "idx_board_member_role" ON "board_member"("role_id");
