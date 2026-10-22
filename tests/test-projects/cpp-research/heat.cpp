// Solve one-dimensional heat diffusion and compare it with the exact sine mode.
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

struct Options {
    int cells = 128;
    int steps = 1000;
    std::filesystem::path output = "results/profile.csv";
};

// Read the small command line interface used for quick and long runs.
Options parse_options(int argc, char* argv[]) {
    Options options;
    for (int index = 1; index < argc; index += 2) {
        if (index + 1 >= argc) {
            throw std::invalid_argument("Every option needs a value");
        }
        const std::string key = argv[index];
        const std::string value = argv[index + 1];
        if (key == "--cells") {
            options.cells = std::stoi(value);
        } else if (key == "--steps") {
            options.steps = std::stoi(value);
        } else if (key == "--output") {
            options.output = value;
        } else {
            throw std::invalid_argument("Unknown option: " + key);
        }
    }
    if (options.cells < 4 || options.steps < 1 || options.output.empty()) {
        throw std::invalid_argument("cells must be at least 4, steps positive, output nonempty");
    }
    return options;
}

// Advance u_t = u_xx on [0, 1] with zero endpoints and an explicit stable step.
int main(int argc, char* argv[]) {
    const Options options = parse_options(argc, argv);
    const double pi = std::acos(-1.0);
    const double dx = 1.0 / options.cells;
    const double dt = 0.4 * dx * dx;
    std::vector<double> current(options.cells + 1, 0.0);
    std::vector<double> next(options.cells + 1, 0.0);
    for (int index = 1; index < options.cells; ++index) {
        current[index] = std::sin(pi * index * dx);
    }
    for (int step = 0; step < options.steps; ++step) {
        for (int index = 1; index < options.cells; ++index) {
            next[index] = current[index]
                + 0.4 * (current[index - 1] - 2.0 * current[index] + current[index + 1]);
        }
        current.swap(next);
    }

    const double time = options.steps * dt;
    if (!options.output.parent_path().empty()) {
        std::filesystem::create_directories(options.output.parent_path());
    }
    std::ofstream file(options.output);
    if (!file) {
        throw std::runtime_error("Cannot open output file: " + options.output.string());
    }
    file << std::setprecision(17) << "x,numerical,exact\n";
    double squared_error = 0.0;
    for (int index = 0; index <= options.cells; ++index) {
        const double x = index * dx;
        const double exact = std::exp(-pi * pi * time) * std::sin(pi * x);
        const double error = current[index] - exact;
        squared_error += error * error;
        file << x << ',' << current[index] << ',' << exact << '\n';
    }
    const double rmse = std::sqrt(squared_error / (options.cells + 1));
    std::cout << "cells=" << options.cells << " steps=" << options.steps
              << " time=" << time << " rmse=" << rmse << '\n';
    std::cout << "Saved profile to " << options.output << '\n';
}
