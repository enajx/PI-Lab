"""Make the 256px icon choices used by Settings and Electron."""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
CANDIDATES = ROOT / "icons-temp" / "joyplot-candidates"
PI_MASTERS = ROOT / "icons-temp"
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
    / "icons"
)
PALETTE_DATA = ROOT / "icons-temp" / "matplotlib-colormaps-3.11.2.json"
LEGACY_PALETTES = frozenset({"magma", "magma-iris"})
DISCRETE_PALETTES = frozenset({"flag", "prism"})
SELECTABLE_JOYPLOT_STYLES = {
    "25",
    "26",
    "27",
    "28",
    "29",
    "30",
    "31",
    "32",
    "33",
    "34",
    "35",
    "36",
    "37",
    "38",
    "39",
    "40",
    "41",
    "42",
    "43",
    "44",
    "45",
    "46",
    "47",
    "48",
    "49",
    "50",
    "51",
    "52",
}
SVG_NAMESPACE = "{http://www.w3.org/2000/svg}"
PATH_POINT = re.compile(r"(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)")
EXPANDED_VERTICAL_MARGIN_FRACTION = 0.72


def run(*args: str) -> None:
    """Run one image conversion and fail if it fails."""
    subprocess.run(args, check=True)


def load_palette_data() -> tuple[tuple[str, ...], dict[str, list[str]], frozenset[str]]:
    """Read the pinned Matplotlib colors and reject an incomplete export."""
    data = json.loads(PALETTE_DATA.read_text())
    if data["matplotlib_version"] != "3.11.2" or data["samples"] != 256:
        raise ValueError("expected 256 samples from Matplotlib 3.11.2")
    standard = tuple(name for group in data["categories"].values() for name in group)
    all_names = (*standard, *data["custom"])
    if len(standard) != 84 or len(all_names) != 85 or len(set(all_names)) != 85:
        raise ValueError("expected 84 Matplotlib maps and Magma + Iris")
    palettes = data["palettes"]
    if set(palettes) != set(all_names) or any(
        len(palettes[name]) != 256 for name in all_names
    ):
        raise ValueError("each icon palette needs 256 color samples")
    qualitative = frozenset(data["categories"]["Qualitative"])
    names = tuple(
        name for name in all_names if name not in qualitative | DISCRETE_PALETTES
    )
    if len(names) != 70:
        raise ValueError("expected 70 selectable icon color themes")
    return names, palettes, qualitative


def legacy_stops(palette: str) -> list[tuple[float, str]]:
    """Keep existing Magma and Magma + Iris choices visually unchanged."""
    source = CANDIDATES / f"25-ascending-peaks-{palette}.svg"
    gradient = ET.parse(source).getroot().find(f".//{SVG_NAMESPACE}linearGradient")
    if gradient is None:
        raise ValueError(f"missing gradient in {source}")
    return [
        (float(stop.attrib["offset"]), stop.attrib["stop-color"])
        for stop in gradient.findall(f"{SVG_NAMESPACE}stop")
    ]


def color_stops(
    palette: str,
    reversed_colors: bool,
    palettes: dict[str, list[str]],
    qualitative: frozenset[str],
    limited: bool,
) -> list[tuple[float, str]]:
    """Build smooth samples or hard boundaries for qualitative colormaps."""
    if palette in LEGACY_PALETTES:
        stops = legacy_stops(palette)
        stops = (
            [(offset, color) for offset, color in stops]
            if not reversed_colors
            else [(1 - offset, color) for offset, color in reversed(stops)]
        )
        return limit_color_stops(stops, False) if limited else stops
    colors = palettes[palette]
    if reversed_colors:
        colors = list(reversed(colors))
    if palette in qualitative:
        stops = [(0.0, colors[0])]
        for index in range(1, len(colors)):
            if colors[index] != colors[index - 1]:
                boundary = index / len(colors)
                stops.extend([(boundary, colors[index - 1]), (boundary, colors[index])])
        stops.append((1.0, colors[-1]))
        return limit_color_stops(stops, True) if limited else stops
    stops = [(index / (len(colors) - 1), color) for index, color in enumerate(colors)]
    return limit_color_stops(stops, False) if limited else stops


def limit_color_stops(
    stops: list[tuple[float, str]], qualitative: bool
) -> list[tuple[float, str]]:
    """Map the middle 80% of a palette across the whole visible icon."""
    lower, upper = 0.1, 0.9

    def color_at(position: float) -> str:
        """Find a color at one crop edge, including interpolation for smooth maps."""
        previous_offset, previous_color = stops[0]
        for offset, color in stops[1:]:
            if offset > position:
                if qualitative or offset == previous_offset:
                    return previous_color
                blend = (position - previous_offset) / (offset - previous_offset)
                first = tuple(
                    int(previous_color[index : index + 2], 16) for index in (1, 3, 5)
                )
                second = tuple(int(color[index : index + 2], 16) for index in (1, 3, 5))
                channels = (round(a + (b - a) * blend) for a, b in zip(first, second))
                return "#" + "".join(f"{channel:02x}" for channel in channels)
            previous_offset, previous_color = offset, color
        return previous_color

    middle = [
        ((offset - lower) / (upper - lower), color)
        for offset, color in stops
        if lower < offset < upper
    ]
    return [(0.0, color_at(lower)), *middle, (1.0, color_at(upper))]


def gradient_svg(
    palette: str,
    reversed_colors: bool,
    limited: bool,
    palettes: dict[str, list[str]],
    qualitative: frozenset[str],
    left: int,
    right: int,
) -> str:
    """Draw a full-resolution horizontal color strip for a Pi glyph."""
    stops = "".join(
        f'<stop offset="{offset:.8f}" stop-color="{color}"/>'
        for offset, color in color_stops(
            palette, reversed_colors, palettes, qualitative, limited
        )
    )
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" '
        'viewBox="0 0 256 256">'
        f'<defs><linearGradient id="fill" gradientUnits="userSpaceOnUse" '
        f'x1="{left}" y1="0" x2="{right}" y2="0">{stops}'
        '</linearGradient></defs><rect width="256" height="256" fill="url(#fill)"/>'
        "</svg>"
    )


def expanded_joyplot_svg(source: Path, fit_source: Path) -> bytes:
    """Widen the plot and modestly reduce its vertical margins."""
    root = ET.parse(source).getroot()
    fit_paths = ET.parse(fit_source).getroot().findall(f"{SVG_NAMESPACE}path")
    return serialize_svg(expand_joyplot(root, fit_paths, source))


def expand_joyplot(
    root: ET.Element, fit_paths: list[ET.Element], source: Path
) -> ET.Element:
    """Apply the existing expanded transform to a recolored Joyplot vector."""
    paths = root.findall(f"{SVG_NAMESPACE}path")
    if not paths:
        raise ValueError(f"missing joyplot paths in {source}")
    if not fit_paths:
        raise ValueError(f"missing fit paths for {source}")
    y_values = [
        float(y) for path in fit_paths for _, y in PATH_POINT.findall(path.attrib["d"])
    ]
    if not y_values:
        raise ValueError(f"missing joyplot points in {source}")
    min_y = min(y_values)
    max_y = max(y_values)

    # The ridges taper to zero at their ends. Fit their visible parts, not the
    # full path width, so narrow and broad styles both fill the tile.
    visible_x = []
    for path in fit_paths:
        if path.attrib.get("fill") == "none":
            continue
        ridge = [(float(x), float(y)) for x, y in PATH_POINT.findall(path.attrib["d"])]
        baseline = ridge[0][1]
        visible_x.extend(x for x, y in ridge if baseline - y >= 3)
    if not visible_x:
        raise ValueError(f"missing visible joyplot ridges in {source}")
    min_visible_x = min(visible_x)
    max_visible_x = max(visible_x)
    target_left, target_right = 96, 928
    scale_x = (target_right - target_left) / (max_visible_x - min_visible_x)
    offset_x = target_left - min_visible_x * scale_x
    target_top = 64 + (min_y - 64) * EXPANDED_VERTICAL_MARGIN_FRACTION
    target_bottom = 960 - (960 - max_y) * EXPANDED_VERTICAL_MARGIN_FRACTION
    scale_y = (target_bottom - target_top) / (max_y - min_y)
    offset_y = target_top - min_y * scale_y

    definitions = root.find(f"{SVG_NAMESPACE}defs")
    if definitions is None:
        raise ValueError(f"missing joyplot definitions in {source}")
    clip = ET.SubElement(
        definitions, f"{SVG_NAMESPACE}clipPath", {"id": "expanded-tile"}
    )
    ET.SubElement(
        clip,
        f"{SVG_NAMESPACE}rect",
        {"x": "64", "y": "64", "width": "896", "height": "896", "rx": "210"},
    )
    clipping_group = ET.SubElement(
        root,
        f"{SVG_NAMESPACE}g",
        {"clip-path": "url(#expanded-tile)"},
    )
    group = ET.SubElement(
        clipping_group,
        f"{SVG_NAMESPACE}g",
        {
            "transform": f"matrix({scale_x:.8f} 0 0 {scale_y:.8f} {offset_x:.8f} {offset_y:.8f})"
        },
    )
    for path in paths:
        root.remove(path)
        group.append(path)
    return root


def serialize_svg(root: ET.Element) -> bytes:
    """Write a vector with the default SVG namespace intact."""
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def recolored_joyplot_svg(
    source: Path,
    fit_source: Path,
    palette: str,
    reversed_colors: bool,
    limited: bool,
    expanded: bool,
    palettes: dict[str, list[str]],
    qualitative: frozenset[str],
) -> bytes:
    """Replace only the fill gradient, leaving every ridge path unchanged."""
    root = ET.parse(source).getroot()
    gradient = root.find(f".//{SVG_NAMESPACE}linearGradient")
    if gradient is None:
        raise ValueError(f"missing joyplot gradient in {source}")
    for stop in list(gradient):
        gradient.remove(stop)
    for offset, color in color_stops(
        palette, reversed_colors, palettes, qualitative, limited
    ):
        ET.SubElement(
            gradient,
            f"{SVG_NAMESPACE}stop",
            {"offset": f"{offset:.8f}", "stop-color": color},
        )

    # The ridges run to zero at their ends. Give each ridge the complete map
    # across the part whose fill remains visible at Dock size.
    if palette not in LEGACY_PALETTES or limited:
        definitions = root.find(f"{SVG_NAMESPACE}defs")
        if definitions is None:
            raise ValueError(f"missing joyplot definitions in {source}")
        row = 0
        for path in root.findall(f"{SVG_NAMESPACE}path"):
            if path.attrib.get("fill") == "none":
                continue
            ridge = [
                (float(x), float(y)) for x, y in PATH_POINT.findall(path.attrib["d"])
            ]
            baseline = ridge[0][1]
            visible_x = [x for x, y in ridge if baseline - y >= 25]
            if not visible_x:
                raise ValueError(f"missing visible joyplot ridge in {source}")
            row_gradient = deepcopy(gradient)
            row_gradient.attrib.update(
                {
                    "id": f"fill-{row}",
                    "gradientUnits": "userSpaceOnUse",
                    "x1": f"{min(visible_x):.2f}",
                    "x2": f"{max(visible_x):.2f}",
                    "y1": "0",
                    "y2": "0",
                }
            )
            definitions.append(row_gradient)
            path.attrib["fill"] = f"url(#fill-{row})"
            row += 1
        definitions.remove(gradient)

    if expanded:
        fit_paths = ET.parse(fit_source).getroot().findall(f"{SVG_NAMESPACE}path")
        root = expand_joyplot(root, fit_paths, source)
    return serialize_svg(root)


def make_expanded_joyplot(
    source: Path, fit_source: Path, destination: Path, temporary: Path
) -> None:
    """Render one enlarged joyplot without changing its regular PNG."""
    vector = temporary / f"{destination.stem}.svg"
    full_size = temporary / f"{destination.stem}-1024.png"
    vector.write_bytes(expanded_joyplot_svg(source, fit_source))
    run("rsvg-convert", "--output", str(full_size), str(vector))
    run("magick", str(full_size), "-resize", "256x256", str(destination))


def render_joyplot_choice(
    source: Path,
    fit_source: Path,
    palette: str,
    reversed_colors: bool,
    limited: bool,
    expanded: bool,
    palettes: dict[str, list[str]],
    qualitative: frozenset[str],
    destination: Path,
    temporary: Path,
) -> None:
    """Render one Joyplot from its existing paths and selected colors."""
    if palette in LEGACY_PALETTES and not reversed_colors and not limited:
        if destination.exists():
            return
        if expanded:
            make_expanded_joyplot(source, fit_source, destination, temporary)
        else:
            run(
                "magick",
                str(source.with_suffix(".png")),
                "-resize",
                "256x256",
                str(destination),
            )
        return

    vector = temporary / f"{destination.stem}.svg"
    vector.write_bytes(
        recolored_joyplot_svg(
            source,
            fit_source,
            palette,
            reversed_colors,
            limited,
            expanded,
            palettes,
            qualitative,
        )
    )
    run(
        "rsvg-convert",
        "--width",
        "256",
        "--height",
        "256",
        "--output",
        str(destination),
        str(vector),
    )


def render_pi_choice(
    mask: Path,
    tile: Path,
    destination: Path,
    temporary: Path,
    preserve_existing: bool,
    palette: str,
    reversed_colors: bool,
    limited: bool,
    palettes: dict[str, list[str]],
    qualitative: frozenset[str],
    bounds: tuple[int, int],
) -> None:
    """Apply one gradient to an existing Pi font mask."""
    if preserve_existing and destination.exists():
        return
    left, right = (0, 256) if palette in LEGACY_PALETTES and not limited else bounds
    vector = temporary / f"{destination.stem}-gradient.svg"
    gradient = temporary / f"{destination.stem}-gradient.png"
    vector.write_text(
        gradient_svg(
            palette, reversed_colors, limited, palettes, qualitative, left, right
        )
    )
    run("rsvg-convert", "--output", str(gradient), str(vector))
    glyph = temporary / f"{destination.stem}-glyph.png"
    run(
        "magick",
        str(gradient),
        str(mask),
        "-compose",
        "CopyOpacity",
        "-composite",
        str(glyph),
    )
    run(
        "magick",
        str(tile),
        str(glyph),
        "-compose",
        "Over",
        "-composite",
        str(destination),
    )


def mask_horizontal_bounds(mask: Path) -> tuple[int, int]:
    """Fit a color strip to a glyph's visible horizontal pixels."""
    result = subprocess.run(
        ["magick", str(mask), "-threshold", "5%", "-format", "%@", "info:"],
        check=True,
        capture_output=True,
        text=True,
    )
    match = re.fullmatch(r"(\d+)x\d+\+(\d+)\+\d+", result.stdout.strip())
    if match is None:
        raise ValueError(f"could not measure Pi glyph bounds in {mask}")
    width, left = map(int, match.groups())
    return left, left + width


def main() -> None:
    """Generate every selectable palette and both directions for both families."""
    palette_names, palettes, qualitative = load_palette_data()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    expected: set[Path] = set()

    vectors = {
        source.name[:2]: source
        for source in CANDIDATES.glob("*-magma.svg")
        if source.name[:2] in SELECTABLE_JOYPLOT_STYLES
    }
    if set(vectors) != SELECTABLE_JOYPLOT_STYLES:
        raise ValueError("missing a selectable Joyplot geometry vector")

    with tempfile.TemporaryDirectory(prefix="pi-lab-expanded-icons-") as directory:
        temporary = Path(directory)
        with ThreadPoolExecutor(max_workers=8) as pool:
            jobs = []
            for number, magma_source in sorted(vectors.items()):
                for palette in palette_names:
                    source = (
                        magma_source.with_name(
                            magma_source.name.replace("-magma.svg", f"-{palette}.svg")
                        )
                        if palette in LEGACY_PALETTES
                        else magma_source
                    )
                    fit_source = vectors["25"] if number == "37" else source
                    for reversed_colors in (False, True):
                        direction = "-reversed" if reversed_colors else ""
                        for limited in (False, True):
                            range_suffix = "-limited" if limited else ""
                            for expanded in (False, True):
                                size = "-expanded" if expanded else ""
                                filename = (
                                    f"joyplot-{number}-{palette}"
                                    f"{direction}{range_suffix}{size}.png"
                                )
                                destination = OUTPUT / filename
                                expected.add(destination)
                                jobs.append(
                                    pool.submit(
                                        render_joyplot_choice,
                                        source,
                                        fit_source,
                                        palette,
                                        reversed_colors,
                                        limited,
                                        expanded,
                                        palettes,
                                        qualitative,
                                        destination,
                                        temporary,
                                    )
                                )
            for job in jobs:
                job.result()

    masters = sorted(PI_MASTERS.glob("[0-9][0-9]-*.png"))
    if len(masters) != 12:
        raise ValueError(f"expected 12 Pi font masters, found {len(masters)}")
    with tempfile.TemporaryDirectory(prefix="pi-lab-icon-choices-") as directory:
        temporary = Path(directory)
        tile_svg = temporary / "tile.svg"
        tile_svg.write_text(
            '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" '
            'viewBox="0 0 1024 1024">'
            '<rect x="64" y="64" width="896" height="896" rx="210" fill="#fff"/>'
            "</svg>"
        )
        tile = temporary / "tile.png"
        run("rsvg-convert", "--output", str(tile), str(tile_svg))
        masks: dict[str, Path] = {}
        bounds: dict[str, tuple[int, int]] = {}
        for master in masters:
            font = master.stem[3:]
            grayscale = temporary / f"{font}-inverse.png"
            alpha = temporary / f"{font}-alpha.png"
            mask = temporary / f"{font}-mask.png"
            run(
                "magick",
                str(master),
                "-resize",
                "256x256",
                "-alpha",
                "off",
                "-colorspace",
                "gray",
                "-negate",
                str(grayscale),
            )
            run(
                "magick",
                str(master),
                "-resize",
                "256x256",
                "-alpha",
                "extract",
                str(alpha),
            )
            run(
                "magick",
                str(grayscale),
                str(alpha),
                "-compose",
                "Multiply",
                "-composite",
                str(mask),
            )
            masks[font] = mask
            bounds[font] = mask_horizontal_bounds(mask)

        with ThreadPoolExecutor(max_workers=8) as pool:
            jobs = []
            for font, mask in masks.items():
                for palette in palette_names:
                    for reversed_colors in (False, True):
                        direction = "-reversed" if reversed_colors else ""
                        for limited in (False, True):
                            range_suffix = "-limited" if limited else ""
                            filename = (
                                f"pi-{font}-{palette}{direction}{range_suffix}.png"
                            )
                            destination = OUTPUT / filename
                            expected.add(destination)
                            jobs.append(
                                pool.submit(
                                    render_pi_choice,
                                    mask,
                                    tile,
                                    destination,
                                    temporary,
                                    palette in LEGACY_PALETTES
                                    and not reversed_colors
                                    and not limited,
                                    palette,
                                    reversed_colors,
                                    limited,
                                    palettes,
                                    qualitative,
                                    bounds[font],
                                )
                            )
            for job in jobs:
                job.result()

    expected_count = len(palette_names) * (len(vectors) * 8 + len(masks) * 4)
    if len(expected) != expected_count or any(
        not path.is_file() or path.stat().st_size == 0 for path in expected
    ):
        raise ValueError(f"expected {expected_count:,} complete color choices")
    for existing in OUTPUT.glob("*.png"):
        if existing.name.startswith(("joyplot-", "pi-")) and existing not in expected:
            existing.unlink()


if __name__ == "__main__":
    main()
