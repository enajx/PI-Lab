"""Numerically solve logistic growth and compare against its exact solution."""
module LogisticStudy

using Printf

export exact, solve

"""Return the analytic population at a given time."""
function exact(rate::Float64, capacity::Float64, initial::Float64, time::Float64)::Float64
    return capacity / (1.0 + (capacity / initial - 1.0) * exp(-rate * time))
end

"""Solve logistic growth with fourth-order Runge-Kutta time steps."""
function solve(rate::Float64, capacity::Float64, initial::Float64, dt::Float64, steps::Int)
    if rate <= 0 || capacity <= 0 || initial <= 0 || initial >= capacity || dt <= 0 || steps < 1
        throw(ArgumentError("rate, capacity, dt and steps must be positive; initial must be in (0, capacity)"))
    end
    samples = [(time=0.0, population=initial)]
    population = initial
    growth(value) = rate * value * (1.0 - value / capacity)
    for step in 1:steps
        k1 = growth(population)
        k2 = growth(population + dt * k1 / 2)
        k3 = growth(population + dt * k2 / 2)
        k4 = growth(population + dt * k3)
        population += dt * (k1 + 2k2 + 2k3 + k4) / 6
        push!(samples, (time=step * dt, population=population))
    end
    return samples
end

"""Read run settings from paired command-line arguments."""
function parse_options(arguments::Vector{String})
    if isodd(length(arguments))
        throw(ArgumentError("Every option needs a value"))
    end
    settings = Dict(
        "--rate" => "1.2",
        "--capacity" => "10.0",
        "--initial" => "0.5",
        "--dt" => "0.02",
        "--steps" => "200",
        "--sample-every" => "10",
        "--output" => joinpath(@__DIR__, "results", "trajectory.csv"),
    )
    for index in 1:2:length(arguments)
        key = arguments[index]
        if !haskey(settings, key)
            throw(ArgumentError("Unknown option: $key"))
        end
        settings[key] = arguments[index + 1]
    end
    return settings
end

"""Run the study and write sampled numerical and exact trajectories."""
function main(arguments::Vector{String})
    settings = parse_options(arguments)
    rate = parse(Float64, settings["--rate"])
    capacity = parse(Float64, settings["--capacity"])
    initial = parse(Float64, settings["--initial"])
    dt = parse(Float64, settings["--dt"])
    steps = parse(Int, settings["--steps"])
    sample_every = parse(Int, settings["--sample-every"])
    if sample_every < 1
        throw(ArgumentError("sample-every must be positive"))
    end
    samples = solve(rate, capacity, initial, dt, steps)
    output = settings["--output"]
    mkpath(dirname(output))
    open(output, "w") do file
        println(file, "time,numerical,exact")
        for (index, sample) in enumerate(samples)
            if index == 1 || index == length(samples) || (index - 1) % sample_every == 0
                println(file, "$(sample.time),$(sample.population),$(exact(rate, capacity, initial, sample.time))")
            end
        end
    end
    final = samples[end]
    error = abs(final.population - exact(rate, capacity, initial, final.time))
    @printf("steps=%d final_time=%.3f absolute_error=%.8g\n", steps, final.time, error)
    println("Saved trajectory to $output")
end

end

if abspath(PROGRAM_FILE) == @__FILE__
    LogisticStudy.main(ARGS)
end
