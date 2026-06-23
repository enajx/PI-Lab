import { createFileRoute } from "@tanstack/react-router"
import { ScienceLibrary } from "./components/ScienceLibrary"

/**
 * Library science tab route (AGENTS.md §1 / §7, P8d) — the fourth and final v1
 * science tab: connect a Zotero library and look up papers on Semantic Scholar.
 * The nav registry (`scienceNavItems`) marks it ready so the sidebar links here.
 */
export const Route = createFileRoute("/_shell/science/library")({
  component: ScienceLibrary,
})
