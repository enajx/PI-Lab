# Heat diffusion accuracy

## Question

How does spatial resolution affect the error of an explicit heat-equation solver?

## Method

`heat.cpp` solves one-dimensional diffusion on the unit interval with zero endpoint values and initial profile `sin(pi*x)`. It compares the final numerical profile with the known exact solution. The stable time step is `0.4 * dx²`. The run saves both profiles as `results/profile.csv` and prints root mean squared error.

Compile and run on a CPU with a C++17 compiler:

```sh
c++ -std=c++17 -O2 heat.cpp -o heat
./heat
python3 -m unittest discover -s tests
```

The test compiles its own temporary executable. Use `./heat --cells 1024 --steps 1000000` for a longer run. `--output` changes the profile path. The final time changes with both cells and steps, so keep final time fixed when comparing resolutions.

## Status

The solver and convergence check are ready for local runs. The default run is intentionally small.
