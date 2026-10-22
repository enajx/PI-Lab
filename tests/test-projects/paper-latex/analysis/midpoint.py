"""Reproduce the midpoint estimates and errors in the sample paper."""

from math import pi


def estimate_pi(n: int) -> float:
    """Approximate pi using n midpoint intervals."""
    return 4.0 / n * sum(1.0 / (1.0 + ((k + 0.5) / n) ** 2) for k in range(n))


for intervals in (8, 32, 128):
    estimate = estimate_pi(intervals)
    print(f"{intervals:3d}  {estimate:.9f}  {abs(estimate - pi):.4e}")
