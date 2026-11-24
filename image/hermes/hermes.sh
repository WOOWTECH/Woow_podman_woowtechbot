#!/bin/sh
# /usr/local/bin/hermes: Hermes Agent as this image installs it, read-only under /opt/hermes. Its
# settings, sign-ins and conversations are in $HERMES_HOME (default ~/.hermes, on the /data volume).
# A new Hermes comes with a new image; it never updates itself.
export HERMES_RUNTIME_DIR="${HERMES_RUNTIME_DIR:-/opt/hermes/tools}"
export HERMES_PYTHON="${HERMES_PYTHON:-/opt/hermes/.venv/bin/python}"
# The app starts a conversation with `hermes acp`. What all conversations share is started on its own
# first (see gateway.py), once Hermes has a model; before that the app only asks for the model list.
if [ "$#" = 1 ] && [ "$1" = acp ] && grep -q '^model:' "${HERMES_HOME:-${HOME:-/}/.hermes}/config.yaml" 2>/dev/null; then
  "$HERMES_PYTHON" -I /opt/woowtechbot-podman/hermes/gateway.py </dev/null >/dev/null 2>&1 || :
fi
exec /opt/hermes/.venv/bin/hermes "$@"
