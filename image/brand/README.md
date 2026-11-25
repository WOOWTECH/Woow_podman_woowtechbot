The woowtech bot icons of the web app. The HA add-on image still ships the MausBot ones; the PaaS
edition replaced them, and the Containerfile copies these files over them in /app/dist.
image/rootfs/opt/woowtechbot-podman/brand.cjs checks their sha256 and points index.html and the web
manifest at them.

They are byte for byte the files the PaaS edition serves (https://openmausbot.woowtech.io/<file>,
from paas-odoo-ci woowtechbot/assets), copied on 2026-11-25:

| File | Size | sha256 |
|---|---|---|
| app-icon.svg | 997 | d9f7d603282c81a3a6645cbffdd4427ac1c5613d71fe1b994c6bb79689ab5f39 |
| app-icon-192.png | 4601 | 18e0662796488c75f37a1f9962886d422f001d0abe1271ddc23042eeca259ca1 |
| app-icon-512.png | 12200 | 5f13e4046b1014d25c5689da4a47cacba3bf7ef5223df08d237985315cb69c6e |
| apple-touch-icon.png | 2722 | 217fe540639eabae893ba14d284d913f2bd31b76a545d1d1612ef56ef3f8e1ac |

Tile: woowtech blue #6183FC. Robot glyph: Material Design Icons "robot-happy" (@mdi/svg 7.4.47,
Pictogrammers, Apache License 2.0). When PaaS changes its icons, copy the new files here and update
the sha256 values in brand.cjs.
