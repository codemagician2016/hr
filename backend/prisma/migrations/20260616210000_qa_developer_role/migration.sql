-- QA workflow roles: add a Developer role to project membership. Developers move
-- issues Development/Back-to-Development → Ready for QA; testers (and PMs for
-- recommendations) verify Ready for QA → Completed/Back-to-Development. Additive.
ALTER TABLE "QaProjectMember" ADD COLUMN IF NOT EXISTS "canDevelop" BOOLEAN NOT NULL DEFAULT false;
