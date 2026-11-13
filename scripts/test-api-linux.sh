#!/usr/bin/env bash
# Runs the API test suite on Linux, in a python:3.14-slim container.
#
# Why: some guarantees only exist on Linux, which is what production runs on.
# The query workers' memory cap (RLIMIT_DATA) is ignored by macOS, so those
# tests are skipped by `pnpm test:api` on a Mac and only run here.
#
# Needs Docker and the Compose Postgres (`docker compose up -d`). The container
# joins the Compose network and uses a separate `<db>_test` database, like the
# local test run. The repo is mounted read-only and copied inside, so nothing
# in your working tree (including .venv) is touched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  echo "error: .env not found (copy .env.example to .env)" >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a; source .env; set +a

NETWORK="$(docker compose ps -q postgres | xargs -r docker inspect \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}')"
if [[ -z "$NETWORK" ]]; then
  echo "error: the Compose postgres container isn't running (docker compose up -d)" >&2
  exit 1
fi

TEST_DATABASE_URL="postgresql+psycopg://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB}_test"

docker run --rm \
  --network "$NETWORK" \
  -v "$ROOT/services/api:/src:ro" \
  -v collab-sql-notebook-uv-cache:/root/.cache/uv \
  -e TEST_DATABASE_URL="$TEST_DATABASE_URL" \
  python:3.14-slim sh -c '
    set -e
    pip install --quiet --root-user-action=ignore uv
    mkdir /app
    cd /src
    tar --exclude=.venv --exclude=.pytest_cache --exclude=.mypy_cache \
        --exclude=.ruff_cache --exclude=__pycache__ -cf - . | tar -xf - -C /app
    cd /app
    uv sync --quiet --frozen
    uv run pytest -q -rs "$@"
  ' sh "$@"
