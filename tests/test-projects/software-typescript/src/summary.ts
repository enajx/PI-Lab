export type Sample = {
  timeSeconds: number;
  value: number;
};

export type Summary = {
  samples: number;
  durationSeconds: number;
  min: number;
  max: number;
  timeWeightedMean: number;
};

/** Parse a two-column sensor trace with strictly increasing time stamps. */
export function parseTrace(csv: string): Sample[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.shift() !== "time_s,value") {
    throw new Error("Expected CSV header: time_s,value");
  }

  const samples = lines.map((line, index) => {
    const columns = line.split(",");
    if (columns.length !== 2 || columns.some((column) => column.trim() === "")) {
      throw new Error(`Invalid row ${index + 2}: expected time_s,value`);
    }
    const timeSeconds = Number(columns[0]);
    const value = Number(columns[1]);
    if (!Number.isFinite(timeSeconds) || !Number.isFinite(value)) {
      throw new Error(`Invalid row ${index + 2}: expected finite numbers`);
    }
    return { timeSeconds, value };
  });

  if (samples.length < 2) {
    throw new Error("A trace needs at least two samples");
  }
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].timeSeconds <= samples[index - 1].timeSeconds) {
      throw new Error(`Invalid row ${index + 2}: time must increase`);
    }
  }
  return samples;
}

/** Calculate a mean that accounts for unequal gaps between samples. */
export function summarize(samples: Sample[]): Summary {
  let area = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    area += ((previous.value + current.value) / 2) *
      (current.timeSeconds - previous.timeSeconds);
  }
  const durationSeconds = samples.at(-1)!.timeSeconds - samples[0].timeSeconds;
  return {
    samples: samples.length,
    durationSeconds,
    min: Math.min(...samples.map((sample) => sample.value)),
    max: Math.max(...samples.map((sample) => sample.value)),
    timeWeightedMean: area / durationSeconds,
  };
}
