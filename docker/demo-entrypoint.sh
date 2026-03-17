#!/bin/bash
set -e

mkdir -p "${HOMENFV_STORAGE_ROOT:-/app/storage}"

if [ $# -eq 0 ]; then
    exec /usr/local/bin/homenfv-agent
fi

exec "$@"
