import csv
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class DigitTrainingTests(unittest.TestCase):
    def test_bundled_data_has_distinct_balanced_splits(self) -> None:
        splits = []
        for name, expected_per_class in (("train", 20), ("test", 10)):
            with (ROOT / "data" / f"{name}.csv").open(newline="") as file:
                rows = list(csv.reader(file))
            self.assertEqual(len(rows), expected_per_class * 10)
            self.assertTrue(all(len(row) == 65 for row in rows))
            self.assertEqual(
                {label: sum(row[-1] == str(label) for row in rows) for label in range(10)},
                {label: expected_per_class for label in range(10)},
            )
            splits.append({tuple(row) for row in rows})
        self.assertFalse(splits[0] & splits[1])

    def test_train_command_writes_improving_metrics(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "metrics.csv"
            subprocess.run(
                [sys.executable, str(ROOT / "train.py"), "--epochs", "3", "--output", str(output)],
                check=True,
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            with output.open(newline="") as file:
                metrics = list(csv.DictReader(file))
            self.assertEqual(len(metrics), 4)
            self.assertLess(float(metrics[-1]["train_loss"]), float(metrics[0]["train_loss"]))
            self.assertTrue(all(0 <= float(row["test_accuracy"]) <= 1 for row in metrics))


if __name__ == "__main__":
    unittest.main()
