"""image/hermes/gateway.py: start the gateway that all Hermes conversations share, on its own.

hermes.sh runs this before `hermes acp`. The gateway is one process for all of Hermes, and by itself
`hermes acp` starts it as its own child when none runs. The app ends a conversation's whole process
tree when it closes the conversation (after some idle minutes, for example), so the gateway would end
with the conversation that happened to start it, in the middle of the other conversations' turns
("Gateway disconnected; turn outcome is unknown"). Started here it is a child of process 1, and still
ends by itself after 10 idle minutes.

Uses Hermes' own start, with the same checks and the same lock. Whatever goes wrong here, `hermes acp`
then does what it does anyway.
"""
import os
import sys
import time

WAIT = 30  # seconds until the new gateway has its lock; `hermes acp` waits for it to be ready


def main():
    sys.path.insert(0, "/opt/hermes")
    from hermes_cli.gateway_runtime import discover_gateway_endpoint, ensure_gateway_runtime, gateway_profile_home
    from hermes_constants import get_hermes_home

    home = gateway_profile_home(get_hermes_home())
    if discover_gateway_endpoint(home).state != "absent":
        return
    middle = os.fork()
    if not middle:
        # Two forks and a session of its own: from here on a child of process 1, and so is the gateway
        # once this process has ended.
        os.setsid()
        if os.fork():
            os._exit(0)
        try:
            ensure_gateway_runtime(home, idle_exit=True)
        finally:
            os._exit(0)
    os.waitpid(middle, 0)
    end = time.monotonic() + WAIT
    while time.monotonic() < end and discover_gateway_endpoint(home).state == "absent":
        time.sleep(0.1)


if __name__ == "__main__":
    main()
