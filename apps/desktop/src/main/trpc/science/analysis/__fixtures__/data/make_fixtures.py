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
