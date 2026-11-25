-- Add a dedicated capability flag for the internal dashboards' User Management
-- read access. board_member already gates the task board via can_assign /
-- can_review / can_manage_members; this adds can_view_users for the new
-- board-authed user-read endpoints (routes/board-admin-users-routes.js).
--
-- Additive + idempotent (prod has migration drift — see CLAUDE.md). Defaults to
-- false: no member gains user-data access until a supervisor explicitly grants it.

ALTER TABLE "board_member"
  ADD COLUMN IF NOT EXISTS "can_view_users" BOOLEAN NOT NULL DEFAULT false;
