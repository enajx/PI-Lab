import { DEFAULT_AGENT_ID } from "@pi-lab/shared"

/**
 * Test seam (md/engineering/testing-and-build.md): the "Open agent" action launches a real external
 * CLI agent, which needs credentials and is non-deterministic. So the E2E points
 * the project view at the deterministic test agent (`test-echo`, present only in
 * test mode) via `?agentId=test-echo`, and asserts its known marker. In normal
 * use no param is present and the default agent is used.
 */
export function readAgentIdOverride(): string {
  if (typeof window === "undefined") return DEFAULT_AGENT_ID
  const params = new URLSearchParams(window.location.search)
  const agentId = params.get("agentId")?.trim()
  return agentId && agentId.length > 0 ? agentId : DEFAULT_AGENT_ID
}
