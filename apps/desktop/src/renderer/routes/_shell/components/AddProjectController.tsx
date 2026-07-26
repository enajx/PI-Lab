import type { Project } from "@pi-lab/local-db"
import { createContext, type ReactNode, useContext, useState } from "react"
import { AddProjectMenu } from "./AddProjectMenu"

export interface AddProjectRequest {
  onAdded: (project: Project) => void
}

interface AddProjectController {
  openAddProject: (request: AddProjectRequest) => void
}

const AddProjectControllerContext = createContext<AddProjectController | null>(null)

/**
 * App-global dispatch seam for the shared three-way Add Project chooser.
 * Callers decide what happens after success without owning or duplicating any
 * folder, clone, template, loading, cancellation, or error behavior.
 */
export function AddProjectControllerProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<AddProjectRequest | null>(null)

  return (
    <AddProjectControllerContext.Provider value={{ openAddProject: setRequest }}>
      {children}
      <AddProjectMenu
        variant="global"
        open={request !== null}
        onOpenChange={(open) => {
          if (!open) setRequest(null)
        }}
        onAdded={(project) => request?.onAdded(project)}
      />
    </AddProjectControllerContext.Provider>
  )
}

export function useAddProjectController(): AddProjectController {
  const controller = useContext(AddProjectControllerContext)
  if (!controller) {
    throw new Error("useAddProjectController must be used within AddProjectControllerProvider")
  }
  return controller
}
