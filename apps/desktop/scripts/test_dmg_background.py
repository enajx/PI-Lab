"""Verify installer background relocation with real Finder metadata."""

import tempfile
from pathlib import Path

from dmg_background import relocate_background
from ds_store import DSStore
from mac_alias import Alias


def test_background_moves_into_bundle_without_root_icon() -> None:
    """Finder points inside the app and retains the existing icon layout."""
    with tempfile.TemporaryDirectory() as temporary:
        mount = Path(temporary)
        resource = mount / "PI Lab.app/Contents/Resources/dmg-background.tiff"
        resource.parent.mkdir(parents=True)
        resource.write_bytes(b"test background")
        (mount / ".background.tiff").write_bytes(resource.read_bytes())
        with DSStore.open(str(mount / ".DS_Store"), "w+") as store:
            store["."]["icvp"] = {"backgroundType": 2, "iconSize": 96.0}
            store[".background.tiff"]["Iloc"] = (280, 65)
            store["PI Lab.app"]["Iloc"] = (140, 180)
            store["Applications"]["Iloc"] = (420, 180)
        relocate_background(mount)
        assert not (mount / ".background.tiff").exists()
        with DSStore.open(str(mount / ".DS_Store"), "r") as store:
            settings = store["."]["icvp"]
            alias = Alias.from_bytes(settings["backgroundImageAlias"])
            assert alias.target.filename == "dmg-background.tiff"
            assert settings["iconSize"] == 96.0
            assert store["PI Lab.app"]["Iloc"] == (140, 180)
            assert store["Applications"]["Iloc"] == (420, 180)
            assert not list(store.find(".background.tiff", b"Iloc"))


if __name__ == "__main__":
    test_background_moves_into_bundle_without_root_icon()
