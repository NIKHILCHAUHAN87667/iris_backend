ALTER TABLE "users"
ADD COLUMN "clerk_user_id" VARCHAR(255);

CREATE UNIQUE INDEX "users_clerk_user_id_key"
ON "users"("clerk_user_id");
