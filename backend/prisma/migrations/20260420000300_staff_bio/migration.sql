-- Staff card richer content: dedicated subtitle (role line) and bio
-- paragraph shown on the public storefront's Team section cards.
-- AlterTable
ALTER TABLE "User"
  ADD COLUMN "subtitle" TEXT,
  ADD COLUMN "bio"      TEXT;
