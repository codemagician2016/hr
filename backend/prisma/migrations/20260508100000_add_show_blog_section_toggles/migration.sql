-- AlterTable: add blog page layout section toggles to BusinessContent (corrected table name)
ALTER TABLE "BusinessContent" ADD COLUMN "showBlogServices"     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BusinessContent" ADD COLUMN "showBlogAbout"        BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BusinessContent" ADD COLUMN "showBlogTestimonials" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BusinessContent" ADD COLUMN "showBlogContact"      BOOLEAN NOT NULL DEFAULT false;
