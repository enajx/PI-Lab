"""Check the visible-range crop used by generated app icons."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("generate-app-icon-choices.py")
SPEC = importlib.util.spec_from_file_location("generate_app_icon_choices", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot load {SCRIPT}")
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class LimitedColorRangeTest(unittest.TestCase):
    """Verify the crop endpoints and independent reverse direction."""

    def test_middle_80_percent_uses_palette_positions_10_and_90(self) -> None:
        """Use exact colors from a simple black-to-white gradient."""
        palettes = {"simple": ["#000000", "#ffffff"]}
        qualitative: frozenset[str] = frozenset()

        full = GENERATOR.color_stops(
            "simple", False, palettes, qualitative, False
        )
        limited = GENERATOR.color_stops(
            "simple", False, palettes, qualitative, True
        )
        reversed_limited = GENERATOR.color_stops(
            "simple", True, palettes, qualitative, True
        )

        self.assertEqual(full, [(0.0, "#000000"), (1.0, "#ffffff")])
        self.assertEqual(limited, [(0.0, "#1a1a1a"), (1.0, "#e6e6e6")])
        self.assertEqual(
            reversed_limited, [(0.0, "#e6e6e6"), (1.0, "#1a1a1a")]
        )


if __name__ == "__main__":
    unittest.main()
