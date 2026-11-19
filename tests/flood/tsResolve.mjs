// Resolve hook for the flood harness: lets plain Node (which strips TypeScript
// types itself) import the app's .ts client files, whose relative imports have
// no file extension. Import this module before importing them. A specifier
// "desktop:<package>" resolves <package> from apps/desktop, so the harness
// gets the same module instances as the app files it imports.
import { existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath } from "node:url"

const DESKTOP_PACKAGE = new URL("../../apps/desktop/package.json", import.meta.url).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("desktop:")) {
      return nextResolve(specifier.slice("desktop:".length), { ...context, parentURL: DESKTOP_PACKAGE })
    }
    const fromTs = context.parentURL?.endsWith(".ts") || context.parentURL?.endsWith(".tsx")
    if (fromTs && (specifier.startsWith("./") || specifier.startsWith("../"))) {
      const base = new URL(specifier, context.parentURL).href
      if (!/\.[cm]?[jt]sx?$/.test(base)) {
        for (const suffix of [".ts", ".tsx", "/index.ts"]) {
          if (existsSync(fileURLToPath(base + suffix))) return nextResolve(base + suffix, context)
        }
      }
    }
    return nextResolve(specifier, context)
  },
})
