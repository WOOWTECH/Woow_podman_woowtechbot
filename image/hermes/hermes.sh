#!/bin/sh
# /usr/local/bin/hermes: Hermes Agent as this image installs it, read-only under /opt/hermes. Its
# settings, sign-ins and conversations are in $HERMES_HOME (default ~/.hermes, on the /data volume).
# A new Hermes comes with a new image; it never updates itself.
export HERMES_RUNTIME_DIR="${HERMES_RUNTIME_DIR:-/opt/hermes/tools}"
export HERMES_PYTHON="${HERMES_PYTHON:-/opt/hermes/.venv/bin/python}"
exec /opt/hermes/.venv/bin/hermes "$@"
