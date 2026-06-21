#!/bin/bash
# One-shot ECR setup for Sitepresso Docker migration.
#
# Run from your laptop (NOT EC2) with AWS credentials configured for the
# ap-south-1 account that owns the staging EC2.
#
# What this does:
#   1. Creates 13 ECR repositories (one per active sub-app)
#   2. Attaches a lifecycle policy that keeps the last 10 images per repo
#      (older images expire automatically — caps storage costs)
#   3. Prints the registry URL you'll paste into the GH Actions secret
#      ECR_REGISTRY
#
# Idempotent — safe to re-run; existing repos are skipped, lifecycle
# policies are upserted. Will NOT delete anything.

set -euo pipefail

REGION="ap-south-1"

# 13 active sub-apps that get Docker images. Order matches docker-compose.yml.
REPOS=(
  backend
  platform
  business
  router
  booking-staff
  booking-customer
  shop-manager
  shop-delivery
  shop-customer
  shop-public
  web-staff
  web-customer
  web-public
)

LIFECYCLE_POLICY='{
  "rules": [{
    "rulePriority": 1,
    "description": "Keep last 10 images, expire older",
    "selection": {
      "tagStatus": "any",
      "countType": "imageCountMoreThan",
      "countNumber": 10
    },
    "action": { "type": "expire" }
  }]
}'

echo "===== Sitepresso ECR setup — region $REGION ====="

# Verify AWS credentials work + grab account ID for the registry URL
ACCOUNT_ID=$(aws sts get-caller-identity --query 'Account' --output text)
echo "AWS Account: $ACCOUNT_ID"
echo "Registry:    $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
echo ""

CREATED=0
EXISTED=0
for repo in "${REPOS[@]}"; do
  REPO_NAME="sitepresso-$repo"
  if aws ecr describe-repositories --repository-names "$REPO_NAME" --region "$REGION" >/dev/null 2>&1; then
    echo "✓  exists:  $REPO_NAME"
    EXISTED=$((EXISTED + 1))
  else
    aws ecr create-repository \
      --repository-name "$REPO_NAME" \
      --region "$REGION" \
      --image-scanning-configuration scanOnPush=true \
      --image-tag-mutability MUTABLE \
      >/dev/null
    echo "+  created: $REPO_NAME"
    CREATED=$((CREATED + 1))
  fi

  # Always upsert the lifecycle policy (no-op if already correct)
  aws ecr put-lifecycle-policy \
    --repository-name "$REPO_NAME" \
    --region "$REGION" \
    --lifecycle-policy-text "$LIFECYCLE_POLICY" \
    >/dev/null
done

echo ""
echo "===== Summary ====="
echo "Created:    $CREATED new repos"
echo "Existed:    $EXISTED repos already present"
echo "Total:      ${#REPOS[@]} repos managed"
echo ""
echo "===== Next step ====="
echo "Add this value to GitHub Actions secrets as ECR_REGISTRY:"
echo ""
echo "  $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
echo ""
echo "Path: GitHub repo → Settings → Secrets and variables → Actions → New repository secret"
echo ""
echo "===== Done ====="
