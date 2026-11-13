"""Write the pickle fixtures for the Analysis safe unpickler tests.

Run from this folder, once per pandas version:
  uv run --no-project --with "pandas<3" python make_fixtures.py p2
  uv run --no-project --python 3.10 --with "pandas<2" --with "numpy<2" python make_fixtures.py p1
  uv run --no-project --with "pandas>=3" python make_fixtures.py p3
  uv run --no-project --with "pandas>=3" --with pyarrow python make_fixtures.py p3a
(p3a: pandas 3 with pyarrow installed stores strings as pyarrow arrays.)
`object-all-none.npy` is a real file from a research project (200 Nones).
"""

import dataclasses
import pickle
import sys

import numpy as np
import pandas as pd

tag = sys.argv[1]


@dataclasses.dataclass
class RunConfig:
    lr: float


def dump(name: str, value: object, protocol: int) -> None:
    with open(name, "wb") as file:
        pickle.dump(value, file, protocol=protocol)


frame = pd.DataFrame(
    {
        "step": np.arange(4),
        "loss": [0.5, 0.4, 0.3, 0.25],
        "name": ["a", "b", "c", "d"],
        "when": pd.date_range("2024-01-01", periods=4, freq="D"),
    }
)
dump(f"{tag}-frame.pkl", frame, 4)
dump(f"{tag}-series.pkl", pd.Series([1.0, 2.0, 3.0], name="acc"), 4)
dump(
    f"{tag}-series-dates.pkl",
    pd.Series([3, 1, 2], index=pd.date_range("2024-03-01", periods=3, freq="D"), name="count"),
    4,
)

if tag == "p3a":
    dump("p3a-names.pkl", pd.Series(["a", None, "c"], name="names"), 4)

if tag == "p2":
    plain = {
        "none": None,
        "flags": [True, False],
        "ints": (1, -2, 2**70),
        "floats": [0.5, float("nan")],
        "text": "héllo",
        "raw": b"\x00\x01",
        "nested": {"set": {3}, "frozen": frozenset([4])},
        "curve": np.array([1.5, 2.5, 3.5]),
        "grid": np.arange(6, dtype=">i4").reshape(2, 3),
        "scalar": np.float32(0.25),
    }
    for protocol in (0, 2, 4, 5):
        dump(f"plain-p{protocol}.pkl", plain, protocol)
    dump("refused-class.pkl", {"config": RunConfig(0.1)}, 4)
    dump("all-none-list.pkl", [None] * 5, 4)
    dump("multiindex.pkl", frame.set_index(["step", "name"]), 4)
    np.save("object-mixed.npy", np.array([1, 2.5, None, 4], dtype=object), allow_pickle=True)
