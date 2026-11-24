"""image/hermes/payload.py SRC DEST: put the official Hermes Agent install into the image.

Run while the image is built, with the official image's own Python and its /opt/hermes mounted
read-only at SRC. The install is copied whole except the optional browser package (woowtechbot has
its own Chrome and browser tools), and the virtual environment is pointed at the Python that comes
with it. Refuses any release other than the reviewed one, so a new digest is a decision, not a
side effect. The HA add-on and the PaaS image install Hermes the same way.
"""
import json
import os
import shutil
import sys

RELEASE = {"baseVersion": "0.22.5", "commit": "bf0203a794a07aac3ff764972ab9087baa4e4f4e", "dirty": False}
PYTHON = "python3.14"


def fail(text):
    sys.exit(f"hermes payload: {text}")


def load(path):
    with open(path, encoding="utf-8") as file:
        return json.load(file)


def stage(src, dest):
    stamp = load(os.path.join(src, "install-stamp.json"))
    for key, value in RELEASE.items():
        if stamp.get(key) != value:
            fail(f"not the reviewed release: {key} is {stamp.get(key)!r}")
    facts = load(os.path.join(src, "tools", "facts.json"))
    try:
        browser = facts["packages"].pop("chromium")["entry"]
        python = facts["packages"]["python"]["entry"]
    except KeyError as error:
        fail(f"the tool store has no {error}")
    skipped = os.path.join(src, "tools", browser)
    interpreter = os.path.join("tools", python, "bin", PYTHON)
    if not os.path.isdir(skipped) or not os.access(os.path.join(src, interpreter), os.X_OK):
        fail("unexpected tool store layout")
    shutil.copytree(src, dest, symlinks=True,
                    ignore=lambda folder, names: [n for n in names if os.path.join(folder, n) == skipped])

    # the tool store's own record, as an install without the browser writes it
    with open(os.path.join(dest, "tools", "facts.json"), "w", encoding="utf-8") as file:
        json.dump(facts, file, indent=2, sort_keys=True)
        file.write("\n")

    # the virtual environment: its Python is /usr/local/bin/python3 in the official image
    link = os.path.join(dest, ".venv", "bin", "python")
    if not os.path.islink(link):
        fail("the virtual environment has no python link")
    os.symlink(os.path.join(dest, interpreter), link + ".new")
    os.replace(link + ".new", link)
    config = os.path.join(dest, ".venv", "pyvenv.cfg")
    with open(config, encoding="utf-8") as file:
        lines = file.read().splitlines()
    if sum(line.startswith("home = ") for line in lines) != 1:
        fail("unexpected pyvenv.cfg")
    home = os.path.join(dest, os.path.dirname(interpreter))
    with open(config, "w", encoding="utf-8") as file:
        file.write("".join(f"home = {home}\n" if line.startswith("home = ") else f"{line}\n" for line in lines))
    print(f"Hermes {stamp['baseVersion']} ({stamp['commit'][:8]}) without {browser}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        fail("usage: payload.py SRC DEST")
    stage(sys.argv[1], sys.argv[2])
