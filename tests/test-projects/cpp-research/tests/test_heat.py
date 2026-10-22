import csv
import math
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class HeatSimulationTests(unittest.TestCase):
    def test_simulation_matches_analytic_solution_and_refines(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "heat"
            subprocess.run(
                ["c++", "-std=c++17", "-O2", str(ROOT / "heat.cpp"), "-o", str(executable)],
                check=True,
                capture_output=True,
                text=True,
            )
            errors = []
            for cells, steps in ((32, 32), (64, 128)):
                output = Path(directory) / f"profile-{cells}.csv"
                subprocess.run(
                    [str(executable), "--cells", str(cells), "--steps", str(steps), "--output", str(output)],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                with output.open(newline="") as file:
                    rows = list(csv.DictReader(file))
                self.assertEqual(len(rows), cells + 1)
                self.assertTrue(all(math.isfinite(float(row["numerical"])) for row in rows))
                self.assertEqual(float(rows[0]["numerical"]), 0.0)
                self.assertLess(abs(float(rows[cells // 2]["numerical"]) - float(rows[cells // 2]["exact"])), 0.01)
                errors.append(sum((float(row["numerical"]) - float(row["exact"])) ** 2 for row in rows) / len(rows))
            self.assertLess(errors[1], errors[0])


if __name__ == "__main__":
    unittest.main()
