Test doubles for the HA add-on modules that image/rootfs/opt/woowtechbot-podman/*.cjs load from
/opt/omb-addon inside the image. They are written for these tests and only mimic each module's
interface and a few refusals; the real modules are exercised by tests/smoke.sh on a host with the
real image.
