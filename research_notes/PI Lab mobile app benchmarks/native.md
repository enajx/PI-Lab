# Apple native apps and Herdr

## How does cmux implement its terminal?

### Takeaway

cmux has a Swift iOS client that hosts Ghostty in a UIKit view. SwiftUI overlays and its keyboard input proxy interact with that view. [Terminal view](https://github.com/manaflow-ai/cmux/blob/main/Packages/iOS/CmuxMobileTerminal/Sources/CmuxMobileTerminal/GhosttySurfaceView.swift)

### Cited Findings

- The mobile shell, terminal and workspace are iOS packages. Authentication, client configuration and Iroh transport are shared Swift packages. [iOS package manifest](https://github.com/manaflow-ai/cmux/blob/main/ios/cmuxPackage/Package.swift)
- The repo’s default license is GPL-3.0-or-later. Specified server directories have separate licenses. [License](https://github.com/manaflow-ai/cmux/blob/main/LICENSE)

### Inferences

- This illustrates the option of specializing the terminal, down to keyboard focus and scroll behavior.

### Gaps

- No Android client appeared in the checked repository tree. Device feel was not tested.

## How does Kanban Code build its board?

### Takeaway

The iOS board is a SwiftUI screen with its own navigation state, search, and card actions. [Board screen](https://github.com/langwatch/kanban-code/blob/main/Apps/iOS/KanbanCodeMobile/Views/BoardScreen.swift)

### Cited Findings

- The app and host share the Swift package KanbanCodeRemoteKit for remote API message types and owner-key cryptography. [Package manifest](https://github.com/langwatch/kanban-code/blob/main/Package.swift)
- The project publishes its sources under Apache 2.0. [License](https://github.com/langwatch/kanban-code/blob/main/LICENSE)

### Inferences

- A platform-specific UI can still share the definition of every command with the host.

### Gaps

- No Android client was identified in this project. No cross-platform experience or engineering cost was measured.

## What can we verify about Herdr?

### Takeaway

The product page covers iPhone, iPad and Android. It shows a direct SSH connection to herdr-core, a terminal with extra keys, and a separate composer for longer replies. [Mobile product page](https://herdr.dev/mobile/)

### Cited Findings

- iPad and unfolded Android devices show a sidebar and terminal side by side. The phone has a swipeable agent inbox and a built-in demo. [Mobile product page](https://herdr.dev/mobile/)
- The org lists five public repositories. The public desktop app, TUI, and core repository trees examined did not reveal the mobile client. [Organization](https://github.com/herdrdev)

### Inferences

- Herdr is a design reference for large-screen layouts and mobile input.

### Gaps

- The mobile implementation language, UI framework, license of the specific client and degree of code sharing could not be verified. The October benchmark's “Mobile app: not found” is stale.
