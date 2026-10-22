"""Generate the fixed-palette Alpha and Beta app icon choices.

Run with ``uv run python apps/desktop/scripts/generate-channel-app-icon-choices.py``.
Requires ImageMagick and librsvg, like generate-app-icon-choices.py.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import ModuleType


ROOT = Path(__file__).resolve().parents[3]
CANDIDATES = ROOT / "apps" / "desktop" / "assets" / "icons" / "sources" / "joyplot-candidates"
PI_MASTERS = ROOT / "apps" / "desktop" / "assets" / "icons" / "sources" / "pi-masters"
OUTPUT = (
    ROOT
    / "apps"
    / "desktop"
    / "src"
    / "renderer"
    / "routes"
    / "_shell"
    / "settings"
    / "components"
    / "AppIconGallery"
    / "channel-icons"
)
EXPLORATION_OUTPUT = ROOT / "apps" / "desktop" / ".tmp" / "icon-explorations" / "colored"
SVG = "{http://www.w3.org/2000/svg}"
CHANNEL_PALETTES = {"alpha": "viridis", "beta": "magma"}
CHANNEL_OUTLINES = {"alpha": "#153f3c", "beta": "#4c1b58"}


def load_base_generator() -> ModuleType:
    """Reuse the pinned palette data and Joyplot expansion math."""
    source = Path(__file__).with_name("generate-app-icon-choices.py")
    specification = importlib.util.spec_from_file_location("app_icon_choices", source)
    if specification is None or specification.loader is None:
        raise RuntimeError(f"cannot load {source}")
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


BASE = load_base_generator()


def channel_stops(
    channel: str,
    reversed_colors: bool,
    limited: bool,
    palettes: dict[str, list[str]],
    qualitative: frozenset[str],
) -> list[tuple[float, str]]:
    """Use one fixed color map per channel while preserving range controls."""
    return BASE.color_stops(
        CHANNEL_PALETTES[channel], reversed_colors, palettes, qualitative, limited
    )


def channel_joyplot_svg(
    source: Path,
    fit_source: Path,
    channel: str,
    reversed_colors: bool,
    limited: bool,
    expanded: bool,
    palettes: dict[str, list[str]],
    qualitative: frozenset[str],
) -> bytes:
    """Keep the selected ridges white over the channel's colored tile."""
    root = ET.parse(source).getroot()
    gradient = root.find(f".//{SVG}linearGradient")
    tile = root.find(f"{SVG}rect")
    if gradient is None or tile is None:
        raise ValueError(f"missing Joyplot tile or gradient in {source}")
    gradient.attrib.update(
        {"gradientUnits": "userSpaceOnUse", "x1": "64", "y1": "0", "x2": "960", "y2": "0"}
    )
    for stop in list(gradient):
        gradient.remove(stop)
    for offset, color in channel_stops(
        channel, reversed_colors, limited, palettes, qualitative
    ):
        ET.SubElement(
            gradient, f"{SVG}stop", {"offset": f"{offset:.8f}", "stop-color": color}
        )
    tile.attrib["fill"] = "url(#fill)"

    if expanded:
        fit_paths = ET.parse(fit_source).getroot().findall(f"{SVG}path")
        root = BASE.expand_joyplot(root, fit_paths, source)

    for path in root.iter(f"{SVG}path"):
        if path.attrib.get("fill") == "none":
            path.attrib["stroke"] = CHANNEL_OUTLINES[channel]
            path.attrib["stroke-opacity"] = "0.42"
        else:
            path.attrib["fill"] = "#fff"
    return BASE.serialize_svg(root)


def channel_tile_svg(
    channel: str,
    reversed_colors: bool,
    limited: bool,
    palettes: dict[str, list[str]],
    qualitative: frozenset[str],
) -> bytes:
    """Draw the Pi family's existing rounded tile with channel colors."""
    root = ET.Element(
        f"{SVG}svg",
        {"width": "256", "height": "256", "viewBox": "0 0 256 256"},
    )
    definitions = ET.SubElement(root, f"{SVG}defs")
    gradient = ET.SubElement(
        definitions,
        f"{SVG}linearGradient",
        {"id": "fill", "gradientUnits": "userSpaceOnUse", "x1": "16", "y1": "0", "x2": "240", "y2": "0"},
    )
    for offset, color in channel_stops(
        channel, reversed_colors, limited, palettes, qualitative
    ):
        ET.SubElement(
            gradient, f"{SVG}stop", {"offset": f"{offset:.8f}", "stop-color": color}
        )
    ET.SubElement(
        root,
        f"{SVG}rect",
        {
            "x": "16",
            "y": "16",
            "width": "224",
            "height": "224",
            "rx": "52.5",
            "fill": "url(#fill)",
        },
    )
    return BASE.serialize_svg(root)


def render_joyplot(
    source: Path,
    fit_source: Path,
    channel: str,
    reversed_colors: bool,
    limited: bool,
    expanded: bool,
    palettes: dict[str, list[str]],
    qualitative: frozenset[str],
    destination: Path,
    temporary: Path,
) -> None:
    """Rasterize one selected Joyplot into its channel PNG."""
    vector = temporary / f"{destination.stem}.svg"
    vector.write_bytes(
        channel_joyplot_svg(
            source,
            fit_source,
            channel,
            reversed_colors,
            limited,
            expanded,
            palettes,
            qualitative,
        )
    )
    BASE.run(
        "rsvg-convert",
        "--width",
        "256",
        "--height",
        "256",
        "--output",
        str(destination),
        str(vector),
    )


def make_pi_masks(masters: list[Path], temporary: Path) -> dict[str, Path]:
    """Extract the glyph silhouettes from the existing 12 font masters."""
    masks: dict[str, Path] = {}
    for master in masters:
        font = master.stem[3:]
        grayscale = temporary / f"{font}-inverse.png"
        alpha = temporary / f"{font}-alpha.png"
        mask = temporary / f"{font}-mask.png"
        BASE.run(
            "magick", str(master), "-resize", "256x256", "-alpha", "off",
            "-colorspace", "gray", "-negate", str(grayscale),
        )
        BASE.run(
            "magick", str(master), "-resize", "256x256", "-alpha", "extract",
            str(alpha),
        )
        BASE.run(
            "magick", str(grayscale), str(alpha), "-compose", "Multiply",
            "-composite", str(mask),
        )
        masks[font] = mask
    return masks


def render_pi(mask: Path, tile: Path, destination: Path, temporary: Path) -> None:
    """Apply the unchanged Pi silhouette in white over the colored tile."""
    glyph = temporary / f"{destination.stem}-glyph.png"
    BASE.run(
        "magick", "-size", "256x256", "xc:white", str(mask),
        "-compose", "CopyOpacity", "-composite", str(glyph),
    )
    BASE.run(
        "magick", str(tile), str(glyph), "-compose", "Over", "-composite",
        str(destination),
    )


def main() -> None:
    """Keep Alpha's base shapes in the app; write full choices to an ignored cache."""
    explore_all = sys.argv[1:] == ["--explore-all"]
    if sys.argv[1:] and not explore_all:
        raise ValueError("usage: generate-channel-app-icon-choices.py [--explore-all]")
    _, palettes, qualitative = BASE.load_palette_data()
    output = EXPLORATION_OUTPUT if explore_all else OUTPUT
    channels = tuple(CHANNEL_PALETTES) if explore_all else ("alpha",)
    directions = (False, True) if explore_all else (False,)
    ranges = (False, True) if explore_all else (False,)
    output.mkdir(parents=True, exist_ok=True)
    vectors = {
        source.name[:2]: source
        for source in CANDIDATES.glob("*-magma.svg")
        if source.name[:2] in BASE.SELECTABLE_JOYPLOT_STYLES
    }
    if set(vectors) != BASE.SELECTABLE_JOYPLOT_STYLES:
        raise ValueError("missing a selectable Joyplot geometry vector")
    masters = sorted(PI_MASTERS.glob("[0-9][0-9]-*.png"))
    if len(masters) != 12:
        raise ValueError(f"expected 12 Pi font masters, found {len(masters)}")

    expected: set[Path] = set()
    with tempfile.TemporaryDirectory(prefix="pi-lab-channel-icons-") as directory:
        temporary = Path(directory)
        masks = make_pi_masks(masters, temporary)
        with ThreadPoolExecutor(max_workers=8) as pool:
            jobs = []
            for channel in channels:
                for number, source in sorted(vectors.items()):
                    fit_source = vectors["25"] if number == "37" else source
                    for reversed_colors in directions:
                        direction = "-reversed" if reversed_colors else ""
                        for limited in ranges:
                            range_suffix = "-limited" if limited else ""
                            for expanded in (False, True):
                                size = "-expanded" if expanded else ""
                                destination = output / (
                                    f"joyplot-{number}-{channel}"
                                    f"{direction}{range_suffix}{size}.png"
                                )
                                expected.add(destination)
                                jobs.append(
                                    pool.submit(
                                        render_joyplot,
                                        source, fit_source, channel, reversed_colors,
                                        limited, expanded, palettes, qualitative,
                                        destination, temporary,
                                    )
                                )
                for reversed_colors in directions:
                    direction = "-reversed" if reversed_colors else ""
                    for limited in ranges:
                        range_suffix = "-limited" if limited else ""
                        tile_vector = temporary / (
                            f"tile-{channel}{direction}{range_suffix}.svg"
                        )
                        tile_png = tile_vector.with_suffix(".png")
                        tile_vector.write_bytes(
                            channel_tile_svg(
                                channel, reversed_colors, limited,
                                palettes, qualitative,
                            )
                        )
                        BASE.run("rsvg-convert", "--output", str(tile_png), str(tile_vector))
                        for font, mask in masks.items():
                            destination = output / (
                                f"pi-{font}-{channel}{direction}{range_suffix}.png"
                            )
                            expected.add(destination)
                            jobs.append(
                                pool.submit(render_pi, mask, tile_png, destination, temporary)
                            )
            for job in jobs:
                job.result()

    expected_count = len(channels) * (
        len(vectors) * len(directions) * len(ranges) * 2
        + len(masks) * len(directions) * len(ranges)
    )
    if len(expected) != expected_count or any(
        not path.is_file() or path.stat().st_size == 0 for path in expected
    ):
        raise ValueError(f"expected {expected_count} complete channel icons")
    for existing in output.glob("*.png"):
        if existing.name.startswith(("joyplot-", "pi-")) and existing not in expected:
            existing.unlink()


if __name__ == "__main__":
    main()
