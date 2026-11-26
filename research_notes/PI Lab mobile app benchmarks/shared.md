# Orca, Paseo and T3 Code

## How does Orca build its mobile screens?

### Takeaway
Orca uses React Native and Expo for the companion app and embeds web pages in several central screens.

### Cited Findings
- The desktop hosts the WebSocket RPC server. The Expo mobile app pairs to it and has builds for both platforms. [Mobile README](https://github.com/stablyai/orca/blob/44b0d8c91cc907be89eaa3448f03d0c0732329f6/mobile/README.md)
- The host landing screen, workspace session, and file explorer use a mobile web shell. That shell has Swift and Kotlin implementations. The repo also contains a mobile xterm WebView component with specific handling for returning to the foreground on iOS. [Host route](https://github.com/stablyai/orca/blob/44b0d8c91cc907be89eaa3448f03d0c0732329f6/mobile/app/h/%5BhostId%5D/index.tsx) [Session route](https://github.com/stablyai/orca/blob/44b0d8c91cc907be89eaa3448f03d0c0732329f6/mobile/app/h/%5BhostId%5D/session/%5BworktreeId%5D.tsx) [Native shell](https://github.com/stablyai/orca/tree/44b0d8c91cc907be89eaa3448f03d0c0732329f6/mobile/modules/orca-mobile-web-shell) [Terminal component](https://github.com/stablyai/orca/blob/44b0d8c91cc907be89eaa3448f03d0c0732329f6/mobile/src/terminal/webview/TerminalWebView.tsx)

### Inferences
- React Native in the manifest alone says little about how Orca's session screen will feel.

### Gaps
- No device tests or comparative measurements.

## How does Paseo build the terminal?

### Takeaway
Paseo builds iOS, Android and web from one Expo app, with a separately implemented terminal view for each mobile OS.

### Cited Findings
- One app package defines all three builds, with common client and protocol packages. [App manifest](https://github.com/getpaseo/paseo/blob/ac633eb096534013798826361b0b0450b1617623/packages/app/package.json)
- At the inspected revision, the native terminal entry point selects the native grid for supported hosts. React Native prepares a terminal frame for the shared view API. The Expo module supplies a Swift view and a Kotlin view. The project also supplies its own hardware keyboard module for both. [Mobile entry point](https://github.com/getpaseo/paseo/blob/ac633eb096534013798826361b0b0450b1617623/packages/app/src/components/terminal-emulator.native.tsx) [Grid](https://github.com/getpaseo/paseo/blob/ac633eb096534013798826361b0b0450b1617623/packages/app/src/terminal/native-renderer/terminal-grid-view.native.tsx) [Terminal module](https://github.com/getpaseo/paseo/tree/ac633eb096534013798826361b0b0450b1617623/packages/app/modules/paseo-terminal) [Keyboard module](https://github.com/getpaseo/paseo/tree/ac633eb096534013798826361b0b0450b1617623/packages/app/modules/paseo-hardware-keyboard)

### Inferences
- Sharing much of the app can coexist with native drawing and hardware keyboard handling.

### Gaps
- No evidence collected for a quantified difference in responsiveness.

## Which part does T3 Code implement separately?

### Takeaway
The mobile screen and connection code are shared. Each OS implements its own terminal surface behind a small common interface.

### Cited Findings
- The package builds both platforms with Expo and consumes the client runtime and contracts. [Mobile package](https://github.com/pingdotgg/t3code/blob/8cf97b5f06f30a872ce30ab8a888f2ff012365a2/apps/mobile/package.json)
- iOS embeds a GhosttyKit surface. On Android, libghostty-vt handles terminal state and an Android Canvas draws it. Both exchange user input, size changes and remote output with the same React Native screen and RPC stream. [Terminal architecture](https://github.com/pingdotgg/t3code/blob/8cf97b5f06f30a872ce30ab8a888f2ff012365a2/apps/mobile/modules/t3-terminal/README.md)

### Inferences
- T3's small interface is a concrete reference for keeping the option of distinct native terminal implementations open.

### Gaps
- Source identifies the architecture. No device comparison conducted.
