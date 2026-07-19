import { createFileRoute } from "@tanstack/react-router"
import { ScienceTasks } from "./components/ScienceTasks"

export const Route = createFileRoute("/_shell/science/tasks")({
  component: ScienceTasks,
})
