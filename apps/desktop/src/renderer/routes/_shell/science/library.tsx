import { createFileRoute } from "@tanstack/react-router"
import { ScienceLibrary } from "./components/ScienceLibrary"

/**
 * Library science tab route — the fourth and final v1
 * science tab: connect a Zotero library and browse its collections and items.
 * The nav registry (`scienceNavItems`) marks it ready so the sidebar links here.
 */
export const Route = createFileRoute("/_shell/science/library")({
  component: ScienceLibrary,
})
