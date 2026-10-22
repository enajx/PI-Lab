using Test

include(joinpath(@__DIR__, "..", "simulate.jl"))
using .LogisticStudy

@testset "Logistic growth" begin
    rate = 1.2
    capacity = 10.0
    initial = 0.5
    coarse = LogisticStudy.solve(rate, capacity, initial, 0.1, 30)
    fine = LogisticStudy.solve(rate, capacity, initial, 0.05, 60)
    expected = LogisticStudy.exact(rate, capacity, initial, 3.0)
    @test abs(fine[end].population - expected) < abs(coarse[end].population - expected)
    @test abs(fine[end].population - expected) < 1e-5
    @test fine[1].population == initial
    @test_throws ArgumentError LogisticStudy.solve(rate, capacity, initial, -0.1, 30)
end
