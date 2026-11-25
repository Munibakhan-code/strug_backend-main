-- Idempotent apply of the board_rbac_roles migration to a DB whose migrate pipeline is
-- jammed (P3009). Safe to re-run: every statement is IF NOT EXISTS. Mirrors
-- prisma/migrations/20260713112603_board_rbac_roles/migration.sql.

CREATE TABLE IF NOT EXISTS "board_role" (
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

CREATE UNIQUE INDEX IF NOT EXISTS "board_role_key_key" ON "board_role"("key");
CREATE INDEX IF NOT EXISTS "idx_board_role_builtin" ON "board_role"("is_builtin");

ALTER TABLE "board_member" ADD COLUMN IF NOT EXISTS "role_id" INTEGER;
ALTER TABLE "board_member" ADD COLUMN IF NOT EXISTS "access_overrides" JSONB;

CREATE INDEX IF NOT EXISTS "idx_board_member_role" ON "board_member"("role_id");

SELECT to_regclass('public.board_role') AS board_role_table,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_name = 'board_member' AND column_name IN ('role_id','access_overrides')) AS new_columns;
