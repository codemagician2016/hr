#!/bin/bash
# Nightly PostgreSQL backup.
#
# How it works:
#   1. pg_dump -Fc (custom-format, compressed) to /home/ubuntu/db-backups/
#   2. Keep the last BACKUP_RETENTION_DAYS (default 7) nightly dumps locally
#   3. If BACKUP_S3_BUCKET is set, also upload to S3 using the same AWS
#      credentials the backend already uses (SES). Otherwise skip S3 quietly.
#
# Runs via cron on the EC2 instance (see installer comment at the bottom).
# Safe to run manually: ./backup-db.sh
#
# Recovery:
#   # Encrypted backup (the new format):
#   gpg --batch --pinentry-mode loopback --passphrase "$BACKUP_GPG_PASSPHRASE" \
#       --decrypt --output backup.dump sitepresso-YYYYMMDD-HHMMSS.dump.gpg
#   pg_restore -d sitepresso_prod backup.dump
#
#   # Legacy unencrypted backup (pre-2026-04-28):
#   pg_restore -d sitepresso_prod /home/ubuntu/db-backups/sitepresso-YYYYMMDD-HHMMSS.dump
#
set -euo pipefail

# Load DATABASE_URL + AWS creds from the backend .env without mangling
# values that contain '@' or other shell-special characters (passwords
# often do). We read the file line-by-line instead of xargs.
#
# Path precedence:
#   1. First positional arg, e.g. ./backup-db.sh /home/ubuntu/sitepresso-prod/backend/.env
#   2. BACKUP_ENV_FILE env var
#   3. Default to staging — /home/ubuntu/sitepresso/backend/.env
if [ -n "${1:-}" ] && [ -f "$1" ]; then
  ENV_FILE="$1"
elif [ -n "${BACKUP_ENV_FILE:-}" ] && [ -f "$BACKUP_ENV_FILE" ]; then
  ENV_FILE="$BACKUP_ENV_FILE"
else
  ENV_FILE="/home/ubuntu/sitepresso/backend/.env"
fi
echo "[$(date -u +%F\ %T)] using env file: $ENV_FILE"
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      DATABASE_URL|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION|BACKUP_S3_BUCKET|BACKUP_RETENTION_DAYS|BACKUP_GPG_PASSPHRASE)
        # Strip surrounding quotes if present
        value="${value%\"}"
        value="${value#\"}"
        value="${value%\'}"
        value="${value#\'}"
        export "$key=$value"
        ;;
    esac
  done < <(grep -E '^(DATABASE_URL|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION|BACKUP_S3_BUCKET|BACKUP_RETENTION_DAYS|BACKUP_GPG_PASSPHRASE)=' "$ENV_FILE")
fi

: "${DATABASE_URL:?DATABASE_URL not set — cannot back up}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"

# Parse DATABASE_URL into individual PG* env vars. Greedy regex matches
# everything up to the LAST '@' before the host so that an unescaped
# '@' in the password doesn't confuse libpq (which pg_dump uses under
# the hood and is stricter than Prisma's URL parser).
_url_regex='^postgres(ql)?://([^:]+):(.*)@([^:/]+)(:([0-9]+))?/([^?]+)'
if [[ "$DATABASE_URL" =~ $_url_regex ]]; then
  export PGUSER="${BASH_REMATCH[2]}"
  export PGPASSWORD="${BASH_REMATCH[3]}"
  export PGHOST="${BASH_REMATCH[4]}"
  export PGPORT="${BASH_REMATCH[6]:-5432}"
  export PGDATABASE="${BASH_REMATCH[7]}"
else
  echo "Could not parse DATABASE_URL — expected postgres(ql)://user:pass@host[:port]/dbname"
  exit 2
fi

BACKUP_DIR="/home/ubuntu/db-backups"
mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
# Include the parent dir name (sitepresso vs sitepresso-prod) so staging +
# prod backups never overwrite each other locally OR in S3.
ENV_TAG="$(basename "$(dirname "$(dirname "$ENV_FILE")")")"
BACKUP_FILE="$BACKUP_DIR/${ENV_TAG}-$TIMESTAMP.dump"

echo "[$(date -u +%F\ %T)] starting backup → $BACKUP_FILE"

# -Fc = custom compressed format. Smaller + faster to restore than plain SQL.
# --no-owner / --no-privileges keep the dump portable across environments.
# Uses the PG* env vars we just exported above — no URL passed so libpq
# can't misparse the password.
pg_dump --format=custom --compress=9 --no-owner --no-privileges \
  --file="$BACKUP_FILE"

SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
echo "[$(date -u +%F\ %T)] done — size $SIZE"

# Encrypt the dump at rest with AES-256 (GPG symmetric).
# Requires BACKUP_GPG_PASSPHRASE in .env. Without it, we skip encryption
# (back-compat for envs that haven't been configured yet) but log a
# warning. Privacy Policy claims encryption-at-rest for backups, so the
# passphrase should always be set in production .env files.
ENCRYPTED_FILE="${BACKUP_FILE}.gpg"
if [ -n "${BACKUP_GPG_PASSPHRASE:-}" ]; then
  if command -v gpg >/dev/null 2>&1; then
    echo "[$(date -u +%F\ %T)] encrypting → $ENCRYPTED_FILE"
    gpg --batch --yes --pinentry-mode loopback \
        --passphrase "$BACKUP_GPG_PASSPHRASE" \
        --symmetric --cipher-algo AES256 \
        --output "$ENCRYPTED_FILE" \
        "$BACKUP_FILE"
    # Replace plaintext dump with the encrypted one. From here on the
    # only on-disk artefact is the .gpg file; rotation + S3 upload
    # operate on that.
    rm -f "$BACKUP_FILE"
    BACKUP_FILE="$ENCRYPTED_FILE"
    SIZE="$(du -h "$BACKUP_FILE" | cut -f1)"
    echo "[$(date -u +%F\ %T)] encrypted — size $SIZE"
  else
    echo "[$(date -u +%F\ %T)] WARNING: gpg not installed; backup left unencrypted"
  fi
else
  echo "[$(date -u +%F\ %T)] WARNING: BACKUP_GPG_PASSPHRASE not set; backup left unencrypted"
fi

# Ship to S3 if configured. Uses the AWS credentials already on the box.
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  if command -v aws >/dev/null 2>&1; then
    S3_KEY="postgres-backups/$(basename "$BACKUP_FILE")"
    echo "[$(date -u +%F\ %T)] uploading to s3://$BACKUP_S3_BUCKET/$S3_KEY"
    aws s3 cp "$BACKUP_FILE" "s3://$BACKUP_S3_BUCKET/$S3_KEY" --only-show-errors --sse AES256
    echo "[$(date -u +%F\ %T)] upload done (server-side encrypted with SSE-AES256)"
  else
    echo "[$(date -u +%F\ %T)] aws CLI not installed — skipping S3 upload"
  fi
fi

# Rotate — delete local dumps older than RETENTION_DAYS. Match the
# tagged file pattern (env-tag-YYYYMMDD-HHMMSS.dump[.gpg]). S3 lifecycle
# rules handle remote retention; do NOT try to delete S3 objects from
# here (keeps the IAM policy narrower).
find "$BACKUP_DIR" -maxdepth 1 \
  \( -name '*.dump' -o -name '*.dump.gpg' \) \
  -mtime +"$RETENTION_DAYS" -delete

echo "[$(date -u +%F\ %T)] rotation complete (kept last $RETENTION_DAYS days)"

# -----------------------------------------------------------------------------
# Installer — run once on the EC2 box to schedule nightly backups
# -----------------------------------------------------------------------------
# Both staging + prod live on the same EC2, so install TWO cron entries
# 30 minutes apart so they don't fight for I/O.
#
# chmod +x /home/ubuntu/sitepresso/backend/scripts/backup-db.sh
# (crontab -l 2>/dev/null;
#  echo "15 2 * * * /home/ubuntu/sitepresso/backend/scripts/backup-db.sh /home/ubuntu/sitepresso/backend/.env >> /home/ubuntu/db-backup-staging.log 2>&1";
#  echo "45 2 * * * /home/ubuntu/sitepresso/backend/scripts/backup-db.sh /home/ubuntu/sitepresso-prod/backend/.env >> /home/ubuntu/db-backup-prod.log 2>&1"
# ) | crontab -
