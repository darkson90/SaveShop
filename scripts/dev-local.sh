#!/usr/bin/env bash
# Avvia i servizi Node in locale senza Docker (richiede PostgreSQL con PostGIS, RabbitMQ e Redis già attivi).
# Porte: auth 3001, user 3002, store 3003, catalog 3004, list 3005, pricing 3006, analytics 3007, notification 3008.
set -euo pipefail
cd "$(dirname "$0")/.."
PG=${PG:-postgres://spesa:spesa@localhost:5432}
LOGS=${LOGS:-./.logs}
mkdir -p "$LOGS"

export SERVICE_TOKEN=${SERVICE_TOKEN:-dev-only-service-token}
export AMQP_URL=${AMQP_URL:-amqp://guest:guest@localhost:5672}
export JWT_PUBLIC_KEY_FILE=$PWD/keys/jwt-public.pem
export AUTH_URL=http://localhost:3001 USER_URL=http://localhost:3002 STORE_URL=http://localhost:3003
export CATALOG_URL=http://localhost:3004 LIST_URL=http://localhost:3005 PRICING_URL=http://localhost:3006
export ANALYTICS_URL=http://localhost:3007

start() {
  local name=$1 port=$2; shift 2
  (cd "services/$name" && env PORT="$port" DATABASE_URL="$PG/${name}_db" "$@" node dist/main.js >"../../$LOGS/$name.log" 2>&1 &)
  echo "avviato $name su :$port (log: $LOGS/$name.log)"
}

start auth 3001 JWT_PRIVATE_KEY_FILE="$PWD/keys/jwt-private.pem"
start user 3002 LOYALTY_KEY=dev-only-loyalty-key
start store 3003
start catalog 3004
start list 3005
start pricing 3006 REDIS_URL=redis://localhost:6379/0
start analytics 3007 REDIS_URL=redis://localhost:6379/1
start notification 3008
