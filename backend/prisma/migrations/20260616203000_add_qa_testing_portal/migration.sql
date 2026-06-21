CREATE TABLE IF NOT EXISTS "QaUser" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "password" TEXT NOT NULL,
  "name" TEXT,
  "isAdmin" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "passwordChangedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "QaUser_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "QaProject" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "nextIssueNumber" INTEGER NOT NULL DEFAULT 1001,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "QaProject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "QaProjectVertical" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "QaProjectVertical_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "QaProjectMember" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "canTest" BOOLEAN NOT NULL DEFAULT true,
  "canApproveRecommendations" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "QaProjectMember_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "QaIssue" (
  "id" TEXT NOT NULL,
  "publicId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "projectIssueNumber" INTEGER NOT NULL,
  "verticalId" TEXT,
  "type" TEXT NOT NULL DEFAULT 'BUG',
  "description" TEXT NOT NULL,
  "imageUrl" TEXT,
  "imageDataUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'NEW',
  "createdById" TEXT,
  "agentClaimedAt" TIMESTAMP(3),
  "agentClaimedBy" TEXT,
  "verifiedAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "QaIssue_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "QaIssueComment" (
  "id" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "authorUserId" TEXT,
  "actorType" TEXT NOT NULL DEFAULT 'USER',
  "body" TEXT NOT NULL,
  "fromStatus" TEXT,
  "toStatus" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "QaIssueComment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "QaUser_email_key" ON "QaUser"("email");
CREATE INDEX IF NOT EXISTS "QaUser_isActive_createdAt_idx" ON "QaUser"("isActive", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "QaProject_key_key" ON "QaProject"("key");
CREATE INDEX IF NOT EXISTS "QaProject_isActive_name_idx" ON "QaProject"("isActive", "name");

CREATE UNIQUE INDEX IF NOT EXISTS "QaProjectVertical_projectId_key_key" ON "QaProjectVertical"("projectId", "key");
CREATE INDEX IF NOT EXISTS "QaProjectVertical_projectId_isActive_sortOrder_idx" ON "QaProjectVertical"("projectId", "isActive", "sortOrder");

CREATE UNIQUE INDEX IF NOT EXISTS "QaProjectMember_userId_projectId_key" ON "QaProjectMember"("userId", "projectId");
CREATE INDEX IF NOT EXISTS "QaProjectMember_projectId_isActive_idx" ON "QaProjectMember"("projectId", "isActive");
CREATE INDEX IF NOT EXISTS "QaProjectMember_userId_isActive_idx" ON "QaProjectMember"("userId", "isActive");

CREATE UNIQUE INDEX IF NOT EXISTS "QaIssue_publicId_key" ON "QaIssue"("publicId");
CREATE UNIQUE INDEX IF NOT EXISTS "QaIssue_projectId_projectIssueNumber_key" ON "QaIssue"("projectId", "projectIssueNumber");
CREATE INDEX IF NOT EXISTS "QaIssue_projectId_status_createdAt_idx" ON "QaIssue"("projectId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "QaIssue_projectId_type_createdAt_idx" ON "QaIssue"("projectId", "type", "createdAt");
CREATE INDEX IF NOT EXISTS "QaIssue_verticalId_status_idx" ON "QaIssue"("verticalId", "status");
CREATE INDEX IF NOT EXISTS "QaIssue_createdById_createdAt_idx" ON "QaIssue"("createdById", "createdAt");

CREATE INDEX IF NOT EXISTS "QaIssueComment_issueId_createdAt_idx" ON "QaIssueComment"("issueId", "createdAt");
CREATE INDEX IF NOT EXISTS "QaIssueComment_authorUserId_createdAt_idx" ON "QaIssueComment"("authorUserId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'QaProjectVertical_projectId_fkey') THEN
    ALTER TABLE "QaProjectVertical"
      ADD CONSTRAINT "QaProjectVertical_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "QaProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'QaProjectMember_userId_fkey') THEN
    ALTER TABLE "QaProjectMember"
      ADD CONSTRAINT "QaProjectMember_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "QaUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'QaProjectMember_projectId_fkey') THEN
    ALTER TABLE "QaProjectMember"
      ADD CONSTRAINT "QaProjectMember_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "QaProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'QaIssue_projectId_fkey') THEN
    ALTER TABLE "QaIssue"
      ADD CONSTRAINT "QaIssue_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "QaProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'QaIssue_verticalId_fkey') THEN
    ALTER TABLE "QaIssue"
      ADD CONSTRAINT "QaIssue_verticalId_fkey"
      FOREIGN KEY ("verticalId") REFERENCES "QaProjectVertical"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'QaIssue_createdById_fkey') THEN
    ALTER TABLE "QaIssue"
      ADD CONSTRAINT "QaIssue_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "QaUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'QaIssueComment_issueId_fkey') THEN
    ALTER TABLE "QaIssueComment"
      ADD CONSTRAINT "QaIssueComment_issueId_fkey"
      FOREIGN KEY ("issueId") REFERENCES "QaIssue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'QaIssueComment_authorUserId_fkey') THEN
    ALTER TABLE "QaIssueComment"
      ADD CONSTRAINT "QaIssueComment_authorUserId_fkey"
      FOREIGN KEY ("authorUserId") REFERENCES "QaUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
