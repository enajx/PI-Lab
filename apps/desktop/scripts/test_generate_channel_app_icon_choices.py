"""Check the channel icon vectors before raster assets are generated."""

from __future__ import annotations

import importlib.util
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


SCRIPT = Path(__file__).with_name("generate-channel-app-icon-choices.py")
SPEC = importlib.util.spec_from_file_location("generate_channel_app_icon_choices", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {SCRIPT}")
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)
SVG = "{http://www.w3.org/2000/svg}"


class ChannelIconVectorTest(unittest.TestCase):
    """Keep channel color on the tile and the selected symbol white."""

    def test_joyplot_uses_channel_background_and_white_ridges(self) -> None:
        """The original ridge paths survive the color inversion."""
        _, palettes, qualitative = GENERATOR.BASE.load_palette_data()
        source = next(GENERATOR.CANDIDATES.glob("25-*-magma.svg"))
        original = ET.parse(source).getroot()
        rendered = ET.fromstring(
            GENERATOR.channel_joyplot_svg(
                source, source, "alpha", False, False, False, palettes, qualitative
            )
        )

        self.assertEqual(
            [path.attrib["d"] for path in rendered.findall(f"{SVG}path")],
            [path.attrib["d"] for path in original.findall(f"{SVG}path")],
        )
        self.assertEqual(rendered.find(f"{SVG}rect").attrib["fill"], "url(#fill)")
        paths = rendered.findall(f"{SVG}path")
        self.assertTrue(all(path.attrib["fill"] == "#fff" for path in paths[::2]))
        self.assertTrue(all(path.attrib["stroke-opacity"] == "0.42" for path in paths[1::2]))
        colors = {
            stop.attrib["stop-color"]
            for stop in rendered.findall(f".//{SVG}linearGradient/{SVG}stop")
        }
        self.assertIn(palettes["viridis"][0], colors)
        self.assertIn(palettes["viridis"][-1], colors)

    def test_pi_background_reverses_magma_without_changing_glyph_mask(self) -> None:
        """Reverse acts on the fixed Beta palette."""
        _, palettes, qualitative = GENERATOR.BASE.load_palette_data()
        forward = ET.fromstring(
            GENERATOR.channel_tile_svg("beta", False, False, palettes, qualitative)
        )
        reverse = ET.fromstring(
            GENERATOR.channel_tile_svg("beta", True, False, palettes, qualitative)
        )
        stops = lambda root: [
            stop.attrib["stop-color"]
            for stop in root.findall(f".//{SVG}linearGradient/{SVG}stop")
        ]
        self.assertEqual(stops(forward), list(reversed(stops(reverse))))
        self.assertEqual(forward.find(f"{SVG}rect").attrib["rx"], "52.5")


if __name__ == "__main__":
    unittest.main()
