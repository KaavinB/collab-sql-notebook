#!/usr/bin/env bash
# Runs the API test suite on Linux, in a python:3.14-slim container.
#
# Why: some guarantees only exist on Linux, which is what production runs on.
# The query workers' memory cap (RLIMIT_DATA) is ignored by macOS, so those
# tests are skipped by `pnpm test:api` on a Mac and only run here.
#
# Needs Docker and the Compose Postgres (`docker compose up -d`). The container
# joins the Compose network and uses the same `<db>_test` database as
# `pnpm test:api`, so don't run both at once: each test session drops and
# recreates that database's tables. The repo is mounted read-only and copied
# inside, so nothing in your working tree (including .venv) is touched.
#
# The image is pinned by digest and uv by version, so a rerun tests the same
# toolchain. To update: `docker buildx imagetools inspect python:3.14-slim`.
set -euo pipefail

IMAGE="python:3.14-slim@sha256:9aaa474097d094040649f2162a627c0049b408f52138d980916788d80f04802f"
UV_VERSION="0.13.0"

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

# The credentials go in as separate variables and the URL is built inside the
# container with proper escaping: a password containing @, / or % would
# otherwise produce a broken (or different) URL.
docker run --rm \
  --network "$NETWORK" \
  -v "$ROOT/services/api:/src:ro" \
  -v collab-sql-notebook-uv-cache:/root/.cache/uv \
  -e POSTGRES_USER -e POSTGRES_PASSWORD -e POSTGRES_DB \
  -e UV_VERSION="$UV_VERSION" \
  "$IMAGE" sh -c '
    set -e
    pip install --quiet --root-user-action=ignore "uv==$UV_VERSION"
    TEST_DATABASE_URL="$(python -c "
import os
from urllib.parse import quote
user = quote(os.environ[\"POSTGRES_USER\"], safe=\"\")
password = quote(os.environ[\"POSTGRES_PASSWORD\"], safe=\"\")
database = quote(os.environ[\"POSTGRES_DB\"] + \"_test\", safe=\"\")
print(f\"postgresql+psycopg://{user}:{password}@postgres:5432/{database}\")
")"
    export TEST_DATABASE_URL
    mkdir /app
    cd /src
    tar --exclude=.venv --exclude=.pytest_cache --exclude=.mypy_cache \
        --exclude=.ruff_cache --exclude=__pycache__ -cf - . | tar -xf - -C /app
    cd /app
    uv sync --quiet --frozen
    uv run pytest -q -rs "$@"
  ' sh "$@"
