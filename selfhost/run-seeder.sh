#!/bin/bash
# Run seeder against a running compose stack.
#
# Older images generated Prisma from the published @trycompai/db schema and left
# the seeder resolving the wrong client. The verified path here uses the local
# workspace generator and runs the TypeScript seed directly:
#
#   node packages/db/scripts/generate-prisma-client-js.js
#   bun packages/db/prisma/seed/seed.ts
#
# Seeder loads ~17 frameworks (SOC 2, ISO 27001, HIPAA, GDPR, NIST, PCI...) +
# 50 control templates + 37 policy templates + 74 task templates + 980 requirements.

set -e

cd "$(dirname "$0")/.."

if [ -n "${COMPOSE:-}" ]; then
  read -r -a COMPOSE_ARGS <<< "$COMPOSE"
else
  COMPOSE_ARGS=(docker compose -f docker-compose.yml -f selfhost/docker-compose.selfhost.yml)
fi

echo "==> running migrator (idempotent)"
"${COMPOSE_ARGS[@]}" run --rm migrator

echo "==> running seeder with local Prisma client"
"${COMPOSE_ARGS[@]}" run --rm --entrypoint /bin/sh seeder -c '
  node packages/db/scripts/generate-prisma-client-js.js
  bun packages/db/prisma/seed/seed.ts
'

echo "==> verify seeded data"
"${COMPOSE_ARGS[@]}" exec -T db psql -U comp -d comp -c "
SELECT 'frameworks' AS t, COUNT(*) FROM \"FrameworkEditorFramework\" UNION ALL
SELECT 'requirement_templates', COUNT(*) FROM \"FrameworkEditorRequirement\" UNION ALL
SELECT 'control_templates', COUNT(*) FROM \"FrameworkEditorControlTemplate\" UNION ALL
SELECT 'policy_templates', COUNT(*) FROM \"FrameworkEditorPolicyTemplate\" UNION ALL
SELECT 'task_templates', COUNT(*) FROM \"FrameworkEditorTaskTemplate\";"
