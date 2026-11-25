-- Restricted RBAC tier: access to KYC / restricted dashboards, stricter than
-- can_manage_members. Default false; granted per board member.
ALTER TABLE "board_member" ADD COLUMN "can_access_restricted" BOOLEAN NOT NULL DEFAULT false;
