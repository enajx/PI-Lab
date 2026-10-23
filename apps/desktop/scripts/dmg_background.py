"""Build the installer with its Finder background inside the signed app bundle."""

import argparse
from pathlib import Path
from typing import Any

from dmgbuild.core import build_dmg
from ds_store import DSStore
from mac_alias import Alias


def relocate_background(mount: Path) -> None:
    """Point Finder at the bundled artwork before compression and signing."""
    resources = list(mount.glob("*.app/Contents/Resources/dmg-background.tiff"))
    if len(resources) != 1:
        raise RuntimeError("Installer requires exactly one bundled DMG background")
    background = mount / ".background.tiff"
    if background.read_bytes() != resources[0].read_bytes():
        raise RuntimeError("Bundled and installer background artwork differ")
    with DSStore.open(str(mount / ".DS_Store"), "r+") as store:
        settings = store["."]["icvp"]
        settings["backgroundImageAlias"] = Alias.for_file(str(resources[0])).to_bytes()
        store["."]["icvp"] = settings
        if list(store.find(".background.tiff", b"Iloc")):
            del store[".background.tiff"][b"Iloc"]
    background.unlink()


def main() -> None:
    """Accept electron-builder's dmgbuild arguments and retain its build lifecycle."""
    parser = argparse.ArgumentParser()
    parser.add_argument("-s", "--settings", required=True)
    parser.add_argument("volume_name")
    parser.add_argument("filename")
    args = parser.parse_args()
    mount: Path | None = None
    relocated = False

    def callback(event: dict[str, Any]) -> None:
        """Capture the staging mount and rewrite metadata before it is detached."""
        nonlocal mount, relocated
        if (
            event.get("type") != "command::finished"
            and event.get("type") != "operation::finished"
        ):
            return
        if event.get("command") == "hdiutil::attach" and event.get("ret") == 0:
            mounts = [
                item["mount-point"]
                for item in event["output"]["system-entities"]
                if "mount-point" in item
            ]
            if len(mounts) != 1:
                raise RuntimeError("Expected exactly one installer staging mount")
            mount = Path(mounts[0])
        if event.get("operation") == "dsstore::create":
            if mount is None:
                raise RuntimeError("Installer staging mount was not reported")
            relocate_background(mount)
            relocated = True

    build_dmg(
        args.filename, args.volume_name, settings_file=args.settings, callback=callback
    )
    if not relocated:
        raise RuntimeError("Installer background relocation did not run")


if __name__ == "__main__":
    main()
