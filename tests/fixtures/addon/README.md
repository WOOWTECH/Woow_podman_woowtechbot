Test doubles for the HA add-on modules that image/rootfs/opt/woowtechbot-podman/*.cjs load from
/opt/omb-addon inside the image. They are written for these tests and only mimic each module's
interface and a few refusals; the real modules are exercised by tests/smoke.sh on a host with the
real image.
The android-push-settings.cjs fixture is copied byte-for-byte from HA rc.23 PR #31 so the
Podman entry validates the same relay URL and credential shape during repo tests.
