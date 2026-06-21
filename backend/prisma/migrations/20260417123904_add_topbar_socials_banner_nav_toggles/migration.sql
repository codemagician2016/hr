-- AlterTable
ALTER TABLE "BusinessContent" ADD COLUMN     "businessEmail" TEXT,
ADD COLUMN     "businessHoursText" TEXT,
ADD COLUMN     "heroBannerUrl" TEXT,
ADD COLUMN     "heroLine3" TEXT,
ADD COLUMN     "showNavAbout" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showNavContact" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showNavHome" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "showNavServices" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "socialFacebook" TEXT,
ADD COLUMN     "socialInstagram" TEXT,
ADD COLUMN     "socialLinkedin" TEXT,
ADD COLUMN     "socialTwitter" TEXT,
ADD COLUMN     "socialYoutube" TEXT;
