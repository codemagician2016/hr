-- Feature 1: hierarchical RBAC data-scope band on BusinessRole (additive, defaults ALL → no regression)
CREATE TYPE "ScopeBand" AS ENUM ('NONE', 'SELF', 'TEAM', 'DEPARTMENT', 'ALL');
ALTER TABLE "BusinessRole" ADD COLUMN "defaultScope" "ScopeBand" NOT NULL DEFAULT 'ALL';
