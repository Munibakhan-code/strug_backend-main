-- Prevent concurrent first-time getOrCreateWorkerProfile() calls (availability toggle
-- racing an add-service call) from creating two worker_profile rows for one user_id.
DROP INDEX IF EXISTS "idx_worker_profile_user";

-- CreateIndex
CREATE UNIQUE INDEX "worker_profile_user_id_key" ON "worker_profile"("user_id");
