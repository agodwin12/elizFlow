#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ElizFlow VPS deploy script
#
# Run this ON THE VPS (ubuntu@51.75.31.246). It:
#   1. Backs up the existing PostgreSQL database (safety first).
#   2. Preserves your secrets (.env, firebase-service-account.json).
#   3. Pulls the latest code on the deploy branch.
#   4. Applies the additive Prisma migration to your EXISTING database.
#   5. Rebuilds and restarts the Docker container.
#   6. Health-checks the running API.
#
# It NEVER creates a database container — it uses the Postgres already on
# the VPS, exactly as before. The migration is additive (new columns have
# defaults, new tables) so existing data is safe.
#
# Usage:
#   cd <app-dir>            # e.g. /var/www/elizflow  (must contain .env)
#   bash deploy/deploy.sh
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

BRANCH="${BRANCH:-claude/elizflow-pos-backend-evnayv}"
APP_DIR="${APP_DIR:-$(pwd)}"
cd "$APP_DIR"

echo "▶ App directory: $APP_DIR"
echo "▶ Deploy branch: $BRANCH"

# ── 0. Sanity checks ────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  echo "❌ No .env found in $APP_DIR. Run this from the app directory that holds your .env."
  exit 1
fi

# Load DATABASE_URL from .env (strip optional surrounding quotes).
DB_URL="$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//; s/^'"'"'//; s/'"'"'$//')"
if [[ -z "${DB_URL:-}" ]]; then
  echo "❌ DATABASE_URL not found in .env"
  exit 1
fi
echo "✓ Found DATABASE_URL"

# ── 1. Backup the database ──────────────────────────────────────────
STAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="$APP_DIR/backups"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/elizflow_db_$STAMP.sql.gz"
echo "▶ Backing up database to $BACKUP_FILE ..."
if command -v pg_dump >/dev/null 2>&1; then
  pg_dump "$DB_URL" | gzip > "$BACKUP_FILE"
else
  # Fall back to a dockerised pg_dump if pg_dump is not on the host.
  docker run --rm --network host -e PGURL="$DB_URL" postgres:16-alpine \
    sh -c 'pg_dump "$PGURL"' | gzip > "$BACKUP_FILE"
fi
echo "✓ Backup complete ($(du -h "$BACKUP_FILE" | cut -f1))"

# ── 2. Preserve secrets, then update code ───────────────────────────
echo "▶ Preserving secrets and fetching latest code ..."
cp -f .env /tmp/elizflow.env.bak
[[ -f firebase-service-account.json ]] && cp -f firebase-service-account.json /tmp/elizflow.fb.bak || true

git fetch origin "$BRANCH"
git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH" "origin/$BRANCH"
git reset --hard "origin/$BRANCH"

# Restore secrets (they are gitignored, but restore in case of a clean checkout).
cp -f /tmp/elizflow.env.bak .env
[[ -f /tmp/elizflow.fb.bak ]] && cp -f /tmp/elizflow.fb.bak firebase-service-account.json || true
echo "✓ Code updated, secrets restored"

if [[ ! -f firebase-service-account.json ]]; then
  echo "⚠  firebase-service-account.json is missing — push notifications will be disabled."
  echo "   Place the real file in $APP_DIR before/after this deploy."
fi

# ── 3. Apply the database migration (against your EXISTING Postgres) ─
echo "▶ Applying Prisma migration (additive, safe) ..."
docker run --rm --network host \
  -e DATABASE_URL="$DB_URL" \
  -v "$APP_DIR/prisma":/app/prisma \
  -v "$APP_DIR/prisma.config.ts":/app/prisma.config.ts:ro \
  -v "$APP_DIR/package.json":/app/package.json:ro \
  -w /app node:20-alpine \
  sh -c "npm i -g prisma@7 >/dev/null 2>&1 || npm i prisma@7; npx prisma migrate deploy" \
  || {
    echo "⚠ Dockerised migrate failed; trying via the built image instead ...";
    docker compose run --rm -e DATABASE_URL="$DB_URL" backend npx prisma migrate deploy;
  }
echo "✓ Migration applied"

# ── 4. Rebuild and restart the container ────────────────────────────
echo "▶ Rebuilding and restarting the container ..."
docker compose down --remove-orphans 2>/dev/null || true
docker compose build
docker compose up -d
echo "✓ Container started"

# ── 5. Health check ─────────────────────────────────────────────────
echo "▶ Waiting for the API to become healthy ..."
OK=0
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:11000/health >/dev/null 2>&1; then OK=1; break; fi
  sleep 2
done
if [[ "$OK" == "1" ]]; then
  echo "✅ Deploy successful. API is healthy:"
  curl -s http://127.0.0.1:11000/health; echo
  curl -s http://127.0.0.1:11000/ready; echo
else
  echo "❌ API did not become healthy in time. Check logs:"
  echo "   docker compose logs --tail=80 backend"
  exit 1
fi

echo ""
echo "─────────────────────────────────────────────────────────────"
echo " Deploy complete."
echo " • DB backup:      $BACKUP_FILE"
echo " • Rollback DB:    gunzip -c $BACKUP_FILE | psql \"\$DATABASE_URL\""
echo " • App logs:       docker compose logs -f backend"
echo "─────────────────────────────────────────────────────────────"
