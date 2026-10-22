# Logistic growth simulation

## Question

How close does a fourth-order numerical solver stay to the exact logistic growth curve?

## Method

`simulate.jl` solves `du/dt = r*u*(1 - u/K)` using fourth-order Runge-Kutta steps. It compares each sampled value with the analytic curve and writes `results/trajectory.csv`. It uses only Julia's standard library.

Run with Julia 1.9 or later:

```sh
julia simulate.jl
julia test/runtests.jl
```

Use `julia simulate.jl --steps 1000000 --dt 0.000004 --sample-every 10000` for a longer CPU run over the same final time as the default. `--rate`, `--capacity`, `--initial`, and `--output` are also adjustable.

## Status

The code is ready for a local Julia run. Julia must be installed to execute or test this example.
