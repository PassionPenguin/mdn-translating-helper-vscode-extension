# MDN Translating Helper (VS Code extension)

## Setup notes

You should open a folder that has the structure like this:

- ROOT FOLDER (vscode opened here)

    - translated-content (https://github.com/mdn/translated-content)
    - content (https://github.com/mdn/content)

Then, activate the plugin in the window by using command palatte, and open any file under `translated-content/files/*/**`, e.g. `translated-content/files/zh-cn/web/index.md`, and a tab will be opened to the right side and will be scrolling-synced.

## Installation

### VSCode Marketplace

Search `MDN Translating Helper` extension ([Hoarfroster.mdn-translating-helper](https://marketplace.visualstudio.com/items?itemName=Hoarfroster.mdn-translating-helper)), and install the extension.

Then, in the root folder, run “MDN Translating Helper: Activate”, then focus a file under `translated-content/files/...` or `content/files/en-us/...` to sync.

### Build and Run locally

1. Clone and open this folder in VS Code.
2. Install dependency via `npm install`.
3. Compile the extension via `npm run compile`.
4. Run extension host by using VS Code *Debug and Run* functionality in sidebar, or by pressing `F5` to launch an Extension Development Host.
5. In that host, run “MDN Translating Helper: Activate”, then focus a file under `translated-content/files/...` or `content/files/en-us/...` to sync.

## Commands

You can find and run these commands in the command palettes:

 - **MDN Translating Helper: Update source hash** (`mdnHelper.updateSourceHash`)

## Settings

You can set the following parameters in the settings.

- `mdnSync.defaultLocale` (default: `zh-cn`)
- `mdnSync.throttleMs` (default: `60`)

## Disclaimers

This project is not affiliated with the MDN project.
 - When a counterpart is opened, the helper tries to show its latest git commit hash in a side info pane. Use “Update source hash” to write that hash into the front matter `sourceCommit` of the active file (in translated-content).
