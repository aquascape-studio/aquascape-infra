#!/usr/bin/env bash
# Dev scales to 0 outside 01:30–04:00 Pacific daily. Run this to bring it up
# off-hours; the next scheduled 04:00 sleep (or `scripts/wake-dev.sh 0`) stops it again.
#
# Usage: scripts/wake-dev.sh [count]   (default 1)
set -euo pipefail

count="${1:-1}"
for svc in web sim; do
  aws application-autoscaling register-scalable-target \
    --service-namespace ecs \
    --scalable-dimension ecs:service:DesiredCount \
    --resource-id "service/aquascape-dev/aquascape-${svc}-dev" \
    --min-capacity "$count" --max-capacity "$count"
done
echo "web/sim set to ${count}; waiting for services to stabilise..."
aws ecs wait services-stable --cluster aquascape-dev --services aquascape-web-dev aquascape-sim-dev
echo "done"
