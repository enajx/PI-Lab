# Optical digit classification

## Question

Can a small neural network learn to classify 8 × 8 handwritten digits from a tiny dataset?

## Method

`train.py` trains a 64-input, one-hidden-layer, ten-output neural network with stochastic gradient descent. The bundled UCI dataset subset has 20 training and 10 test samples per digit. The test samples come from UCI's separate test split. Accuracy from this small sample is illustrative, not a benchmark result.

Run from this folder with Python 3.9 or later:

```sh
python3 train.py
python3 -m unittest discover -s tests
```

Use `python3 train.py --epochs 40` for a longer CPU run. `--hidden`, `--learning-rate`, and `--seed` are also adjustable. Each run saves per-epoch loss and accuracy to `results/metrics.csv`.

## Status

The example is ready for a local training run. Compare loss and test accuracy before interpreting changes to the model.

## Data source

See [DATA_CREDIT.md](DATA_CREDIT.md) for the source, license, and subset procedure.
