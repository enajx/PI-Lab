// @ts-check
// Load the compiled termios addon. Built by apps/desktop/scripts/setup-native.cjs.
// Windows has no termios and no build: the package exports null there.
module.exports = process.platform === "win32" ? null : require("./build/Release/pty_termios.node")
