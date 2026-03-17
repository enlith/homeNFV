#!/bin/bash
set -e

# Create storage directory if it doesn't exist
mkdir -p "${HOMENFV_STORAGE_ROOT:-/app/storage}"

# If no arguments, run the agent
if [ $# -eq 0 ]; then
    exec /usr/local/bin/homenfv-agent
fi

# Otherwise run whatever command was passed
exec "$@"