#!/usr/bin/env bash
# After a CDK deploy of AquascapeStudio-App-dev, the web/sim services get reset
# to the nginx placeholder image in AppStack. This re-registers the last
# CI-built task definitions at the current CDK size (0.25 vCPU / 0.5 GB) and
# points the services back at them.
#
# Usage: scripts/restore-app-images-dev.sh web:32 sim:11
set -euo pipefail

for spec in "$@"; do
  svc="${spec%%:*}"; rev="${spec##*:}"
  family="aquascape-${svc}-dev"
  def=$(aws ecs describe-task-definition --task-definition "${family}:${rev}" --query taskDefinition --output json \
    | jq '.cpu="256" | .memory="512"
          | del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy,.deregisteredAt)')
  arn=$(aws ecs register-task-definition --cli-input-json "$def" --query taskDefinition.taskDefinitionArn --output text)
  aws ecs update-service --cluster aquascape-dev --service "$family" --task-definition "$arn" --query service.taskDefinition --output text
done
aws ecs wait services-stable --cluster aquascape-dev --services $(for s in "$@"; do echo "aquascape-${s%%:*}-dev"; done)
echo "done"
