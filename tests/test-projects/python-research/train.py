"""Train a small neural network on bundled optical digit data."""

import argparse
import csv
import math
import random
from pathlib import Path
from typing import List, Tuple


ROOT = Path(__file__).resolve().parent
Sample = Tuple[List[float], int]


def load_samples(path: Path) -> List[Sample]:
    """Read 64 pixel counts and one digit label from each CSV row."""
    samples: List[Sample] = []
    with path.open(newline="") as file:
        for row in csv.reader(file):
            if len(row) != 65:
                raise ValueError(f"Expected 65 columns in {path}")
            pixels = [int(value) for value in row[:64]]
            label = int(row[64])
            if any(value < 0 or value > 16 for value in pixels) or label not in range(10):
                raise ValueError(f"Invalid digit sample in {path}")
            samples.append(([value / 16.0 for value in pixels], label))
    if not samples:
        raise ValueError(f"No digit samples in {path}")
    return samples


class Network:
    """One hidden tanh layer and a ten-class softmax output."""

    def __init__(self, hidden_size: int, seed: int) -> None:
        generator = random.Random(seed)
        self.hidden_weights = [
            [generator.uniform(-0.15, 0.15) for _ in range(64)] for _ in range(hidden_size)
        ]
        self.hidden_bias = [0.0] * hidden_size
        self.output_weights = [
            [generator.uniform(-0.15, 0.15) for _ in range(hidden_size)] for _ in range(10)
        ]
        self.output_bias = [0.0] * 10

    def forward(self, pixels: List[float]) -> Tuple[List[float], List[float]]:
        """Return hidden activations and output probabilities."""
        hidden = [
            math.tanh(sum(weight * pixel for weight, pixel in zip(weights, pixels)) + bias)
            for weights, bias in zip(self.hidden_weights, self.hidden_bias)
        ]
        logits = [
            sum(weight * value for weight, value in zip(weights, hidden)) + bias
            for weights, bias in zip(self.output_weights, self.output_bias)
        ]
        offset = max(logits)
        exponentials = [math.exp(logit - offset) for logit in logits]
        total = sum(exponentials)
        return hidden, [value / total for value in exponentials]

    def train_one(self, pixels: List[float], label: int, learning_rate: float) -> None:
        """Apply one stochastic gradient step for cross-entropy loss."""
        hidden, probabilities = self.forward(pixels)
        output_error = [value - (index == label) for index, value in enumerate(probabilities)]
        hidden_error = [
            (1.0 - value * value)
            * sum(output_error[index] * self.output_weights[index][hidden_index] for index in range(10))
            for hidden_index, value in enumerate(hidden)
        ]
        for index, error in enumerate(output_error):
            for hidden_index, value in enumerate(hidden):
                self.output_weights[index][hidden_index] -= learning_rate * error * value
            self.output_bias[index] -= learning_rate * error
        for hidden_index, error in enumerate(hidden_error):
            for pixel_index, value in enumerate(pixels):
                self.hidden_weights[hidden_index][pixel_index] -= learning_rate * error * value
            self.hidden_bias[hidden_index] -= learning_rate * error


def evaluate(network: Network, samples: List[Sample]) -> Tuple[float, float]:
    """Return mean cross-entropy and classification accuracy."""
    loss = 0.0
    correct = 0
    for pixels, label in samples:
        _, probabilities = network.forward(pixels)
        loss -= math.log(max(probabilities[label], 1e-15))
        correct += max(range(10), key=probabilities.__getitem__) == label
    return loss / len(samples), correct / len(samples)


def main() -> None:
    """Run the reproducible training study and save epoch metrics."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--epochs", type=int, default=3)
    parser.add_argument("--hidden", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=0.03)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--output", type=Path, default=ROOT / "results" / "metrics.csv")
    args = parser.parse_args()
    if args.epochs < 1 or args.hidden < 1 or not 0 < args.learning_rate <= 1:
        parser.error("epochs and hidden must be positive; learning-rate must be in (0, 1]")

    training = load_samples(ROOT / "data" / "train.csv")
    testing = load_samples(ROOT / "data" / "test.csv")
    network = Network(args.hidden, args.seed)
    shuffle = random.Random(args.seed)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", newline="") as file:
        writer = csv.writer(file)
        writer.writerow(["epoch", "train_loss", "train_accuracy", "test_loss", "test_accuracy"])
        for epoch in range(args.epochs + 1):
            train_loss, train_accuracy = evaluate(network, training)
            test_loss, test_accuracy = evaluate(network, testing)
            writer.writerow([epoch, train_loss, train_accuracy, test_loss, test_accuracy])
            print(f"epoch={epoch} train_loss={train_loss:.3f} test_accuracy={test_accuracy:.3f}")
            if epoch < args.epochs:
                shuffle.shuffle(training)
                for pixels, label in training:
                    network.train_one(pixels, label, args.learning_rate)
    print(f"Saved metrics to {args.output}")


if __name__ == "__main__":
    main()
