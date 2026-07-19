import type { ScreenClassification } from "./types"

// biome-ignore lint/suspicious/noControlCharactersInRegex: rendered-screen input can still contain ANSI ESC/BEL sequences.
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g

const PERMISSION_PATTERNS = [
  /\b(?:allow|approve|permission|permissions)\b.{0,100}\?/i,
  /\bdo you want to (?:proceed|continue|allow|approve)\b/i,
  /\bwould you like to (?:run|execute|apply|proceed|continue)\b/i,
  /\b(?:yes,\s*)?(?:allow|proceed)\b.{0,80}\b(?:no|deny|reject)\b/i,
  /\b(?:run|execute|apply|make)\b.{0,100}\b(?:requires|need(?:s)?)\b.{0,40}\bpermission\b/i,
]

const QUESTION_PATTERNS = [
  /\b(?:answer|question|clarif(?:y|ication)|choose|select)\b.{0,100}\?/i,
  /\bhow (?:should|would|do|can)\b.{0,120}\?/i,
  /\bwhat (?:should|would|do|is|are|can)\b.{0,120}\?/i,
  /\bwhich\b.{0,120}\?/i,
  /\b(?:yes|no)\s*(?:\/|\bor\b)\s*(?:yes|no)\b/i,
]

const FATAL_PATTERNS = [
  /\bfatal(?:\s+error)?\s*:/i,
  /\bpanic(?:ked)?\s*(?:at|:)/i,
  /\buncaught (?:exception|error)\b/i,
  /\bprocess (?:terminated|exited) unexpectedly\b/i,
  /\bfailed to (?:start|launch|initialize)\b/i,
]

const NORMAL_PROMPT_PATTERNS = [
  /^\s*❯\s*(?:(?:ask|describe|enter|implement|message|try|type|write)\b.*)?$/i,
  /^\s*›\s*(?:(?:ask|describe|enter|implement|message|try|type|write)\b.*)?$/i,
  /^\s*>\s*$/,
  /^\s*(?:claude|codex)\s*>\s*$/i,
]

const TRANSIENT_ONLY_PATTERNS = [
  /^(?:\s|[─━═│┃┄┅┈┉⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])+$/,
  /^(?:thinking|working|loading|esc to interrupt|ctrl-c to cancel)[.….\s]*$/i,
]

function normalizeRenderedScreen(screen: string): string {
  return screen
    .replace(ANSI_ESCAPE, "")
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .trim()
}

function fingerprint(screen: string): string {
  return normalizeRenderedScreen(screen).replace(/\s+/g, " ")
}

function matchesAny(screen: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(screen))
}

function hasCurrentNormalPrompt(screen: string): boolean {
  const tail = screen
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-4)
  return tail.some((line) => matchesAny(line, NORMAL_PROMPT_PATTERNS))
}

/**
 * Classify a fully rendered terminal screen, not raw PTY chunks. The patterns
 * deliberately favor false negatives over false positives: unknown UI chrome
 * remains unknown and cannot independently trigger the idle fallback.
 */
export function classifyRenderedAgentScreen(screen: string): ScreenClassification {
  const rendered = normalizeRenderedScreen(screen)
  const screenFingerprint = fingerprint(rendered)

  const fatalPattern = FATAL_PATTERNS.find((pattern) => pattern.test(rendered))
  if (fatalPattern) {
    const line = rendered
      .split("\n")
      .find((candidate) => fatalPattern.test(candidate))
      ?.trim()
    return {
      kind: "fatal",
      fingerprint: screenFingerprint,
      message: line || "Agent terminated with a fatal error",
    }
  }

  if (hasCurrentNormalPrompt(rendered)) {
    return { kind: "normal-prompt", fingerprint: screenFingerprint }
  }

  if (matchesAny(rendered, PERMISSION_PATTERNS)) {
    return { kind: "permission", fingerprint: screenFingerprint }
  }

  if (matchesAny(rendered, QUESTION_PATTERNS)) {
    return { kind: "question", fingerprint: screenFingerprint }
  }

  if (rendered.length > 0 && !TRANSIENT_ONLY_PATTERNS.some((pattern) => pattern.test(rendered))) {
    return { kind: "agent-output", fingerprint: screenFingerprint }
  }

  return { kind: "unknown", fingerprint: screenFingerprint }
}
