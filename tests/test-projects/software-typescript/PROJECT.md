# Sensor Summary

A small TypeScript command-line application. It reads a sensor trace from a CSV
file and reports its minimum, maximum, duration, and time-weighted mean. Unequal
sample intervals make the time-weighted mean different from a plain average.

## Run

Requires [Bun](https://bun.sh/). No package install or network access is needed.

```sh
bun run start
bun test
```

Pass another CSV file with `bun run src/cli.ts path/to/trace.csv`. The file must
have the header `time_s,value`, at least two rows, and strictly increasing time
stamps. The command prints JSON and exits with an error for invalid input.

`src/cli.ts` handles the command line, `src/summary.ts` parses and summarizes the
data, and `tests/cli.test.ts` tests the command through its entry point.
