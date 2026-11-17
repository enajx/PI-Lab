"""Write the HDF5 and Parquet fixtures for the Analysis reader tests.

Run from this folder:
  uv run --no-project --with h5py --with pandas --with pyarrow python make_fixtures.py
"""

import h5py
import numpy as np
import pandas as pd

with h5py.File("runs.h5", "w") as f:
    f["loss"] = 1.0 / (np.arange(100) + 1)
    f["grid"] = np.arange(12, dtype="<i4").reshape(3, 4)
    f["scalar"] = 7.5
    group = f.create_group("eval")
    group["names"] = np.array([b"alpha", b"beta"])
    group["cube"] = np.zeros((2, 3, 4))
    table = np.zeros(3, dtype=[("step", "<i8"), ("acc", "<f4")])
    table["step"] = [0, 10, 20]
    table["acc"] = [0.5, 0.75, 0.875]
    group["table"] = table

frame = pd.DataFrame(
    {
        "step": np.arange(4),
        "loss": [0.5, 0.4, 0.3, 0.25],
        "name": ["a", "b", None, "d"],
        "when": pd.date_range("2024-01-01", periods=4, freq="D"),
    }
)
for codec in ("snappy", "gzip", "zstd", "brotli", "none"):
    frame.to_parquet(f"frame-{codec}.parquet", compression=None if codec == "none" else codec)

# A long-format result table: many rows per question (one per option order,
# repetition and option), like a benchmark's per-option output. Synthetic.
rows = []
for question in range(1, 7):
    for option_order in range(3):
        for repetition in range(2):
            for position, option in enumerate("abc"):
                rows.append(
                    {
                        "model": "model-x",
                        "question": question,
                        "option_order": option_order,
                        "repetition": repetition,
                        "option": option,
                        "probability": round(0.1 + 0.05 * position + 0.01 * question, 4),
                        "is_gold": position == question % 3,
                        "length": 20 + 7 * question + 3 * position + option_order,
                    }
                )
long = pd.DataFrame(rows)
long.to_parquet("long.parquet")
long.to_pickle("long-frame.pkl")
with h5py.File("long.h5", "w") as f:
    table = np.zeros(
        len(long),
        dtype=[
            ("question", "<i8"),
            ("option_order", "<i8"),
            ("repetition", "<i8"),
            ("probability", "<f8"),
            ("length", "<i8"),
        ],
    )
    for name in table.dtype.names:
        table[name] = long[name].to_numpy()
    f["table"] = table
long.to_csv("long.csv", index=False)
