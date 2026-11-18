// @ts-check
// Load the compiled termios addon. Built by apps/desktop/scripts/setup-native.cjs.
// Not built on Windows (no termios): callers must not require it there.
module.exports = require("./build/Release/pty_termios.node")
