// Metro for the Expo check client. It bundles desktop client files
// (apps/desktop/src/renderer/...), so the desktop source folder is watched,
// and a package import from those files resolves as if made from this app, so
// there is one copy of @trpc/client and react (the versions pinned here).
const path = require("node:path")
const { getDefaultConfig } = require("expo/metro-config")

const desktopSource = path.resolve(__dirname, "../../apps/desktop/src")
const config = getDefaultConfig(__dirname)
config.watchFolders = [desktopSource]
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const fromDesktop = context.originModulePath.startsWith(desktopSource + path.sep)
  const isPackage = !moduleName.startsWith(".") && !path.isAbsolute(moduleName)
  const origin =
    fromDesktop && isPackage ? path.join(__dirname, "App.tsx") : context.originModulePath
  return context.resolveRequest({ ...context, originModulePath: origin }, moduleName, platform)
}

module.exports = config
