#!/usr/bin/env bash
# Nightly backup (cron: 15 2 * * * /opt/greenhouse/deploy/mysql/backup.sh). Keeps 14 days.
set -euo pipefail
cd "$(dirname "$0")"
source mysql.env
mkdir -p backup
f="backup/greenhouse-$(date +%F).sql.gz"
docker exec greenhouse-mysql mysqldump -u root -p"$MYSQL_ROOT_PASSWORD" --single-transaction greenhouse | gzip > "$f"
find backup -name 'greenhouse-*.sql.gz' -mtime +14 -delete
# Copy to a USB stick if one is mounted at /media/backup
if mountpoint -q /media/backup; then cp "$f" /media/backup/; fi
echo "backup written: $f"
