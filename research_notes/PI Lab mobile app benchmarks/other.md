# Other benchmark mobile apps

## OpenChamber

### Takeaway
One dedicated mobile web interface is packaged as a Capacitor app for both platforms.

### Cited Findings

- The native shells bundle the mobile entry point from the web build. The same navigation presents a drawer and bottom sheets on small screens, and a resizable sidebar and anchored popovers on wider tablets. A long press selects terminal text and dragging scrolls. The PTY stays on the host. [Mobile package and its README](https://github.com/openchamber/openchamber/tree/main/packages/mobile)

### Inferences

- This is a precedent for sharing web rendering while still designing separate phone and tablet interactions.

### Gaps

- No device testing or comparative assessment of visual or input quality.

## Paradev

### Takeaway
One Expo app shares its chat and network packages and spends native implementation effort on writing messages. It uses web rendering for the terminal.

### Cited Findings

- The mobile app depends on shared chat, cloud-client, and tRPC packages. Apple has a Swift composer and Android has Kotlin helpers for dictation, clipboard attachments, and thumbnails. [App manifest](https://github.com/ParadevAI/Paradev/blob/63b5e28fe6a8cf4a7f124f9f8bf746fd20aec488/apps/mobile/package.json), [native modules](https://github.com/ParadevAI/Paradev/tree/63b5e28fe6a8cf4a7f124f9f8bf746fd20aec488/apps/mobile/modules).
- The terminal hosts xterm.js in a WebView. The view connects to the PTY via WebSocket so each chunk of output does not have to cross into React Native. [Terminal implementation](https://github.com/ParadevAI/Paradev/blob/63b5e28fe6a8cf4a7f124f9f8bf746fd20aec488/apps/mobile/screens/%28authenticated%29/workspace/%5Bid%5D/components/TerminalWebView/TerminalWebView.tsx)
- The exact upstream named in the benchmark has a root MIT license with Superset Inc. as copyright holder and no separate license under apps/mobile in the inspected tree. The older benchmark recorded Elastic 2.0. [MIT license at the inspected revision](https://github.com/ParadevAI/Paradev/blob/63b5e28fe6a8cf4a7f124f9f8bf746fd20aec488/LICENSE.md).

### Inferences

- The mobile framework choice can be independent of the choice for input or terminal display.

### Gaps

- Build targets in the manifest do not establish public Android distribution.

## Agent Orchestrator

### Takeaway
One Expo/React Native app uses xterm.js inside a WebView for the session terminal, with native extensions for parts of message entry and selection.

### Cited Findings

- The same Expo project has iOS and Android targets. Its terminal screen mounts XtermJsWebView and sizes it to the remote grid. The app has Objective-C and Java image-paste implementations and an Android module for selecting response text. [App manifest](https://github.com/OrchestratorInc/agent-orchestrator/blob/cc9ba9bebb1ee4fd34f8a9ebaabb53728013c122/packages/mobile/package.json), [terminal screen](https://github.com/OrchestratorInc/agent-orchestrator/blob/cc9ba9bebb1ee4fd34f8a9ebaabb53728013c122/packages/mobile/lib/session/TerminalSessionScreen.tsx), [native modules](https://github.com/OrchestratorInc/agent-orchestrator/tree/cc9ba9bebb1ee4fd34f8a9ebaabb53728013c122/packages/mobile/native).

### Inferences

- The OS extensions are small enough in scope that client features can share the rest of the implementation.

### Gaps

- Browser access is another category. The local benchmark notes describe Jean, Juggler, Kandev, and Xum as examples of browser access. No other standalone mobile clients are recorded across the 21 benchmark app notes beyond the apps assigned across this research.
