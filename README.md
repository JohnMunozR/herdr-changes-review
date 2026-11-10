# herdr-changes-review

Enhanced review and diff viewer mod for the [Herdr](https://herdr.dev) desktop app.

Allows you to review code changes made by AI agents or developers directly inside Herdr, leave line-by-line inline review notes, and send structured feedback to the active agent in one click.

---

## Features

- **Minimalist, Native UI**: Integrates directly into Herdr's existing Changes panel without disrupting the native layout or adding unnecessary panes.
- **Inline Review Notes**: Click any changed line in the diff viewer to compose or edit an inline review note right underneath that line.
- **Multi-Line Note Editing**: Auto-wrapping textarea with cursor support, full keyboard shortcuts, and neat multi-line inline display.
- **Review List & Navigation**: Bottom **Review** tab shows a scrollable list of all your review comments. Clicking any item jumps directly to the file and line.
- **Thin Scrollbar**: Refined, unobtrusive vertical scrollbar that stays visible when needed and keeps delete actions easily accessible.
- **Send to Agent**: One-click button (`Send to agent`) formats all your review notes and delivers them straight to the active AI agent via Herdr Core (`hc terminal write`).
- **Dynamic Theme Colors**: Full support for any Herdr theme (light, dark, custom). Additions and deletions automatically inherit the theme's colors (`ansi2` for additions, `ansi1` for deletions) across line numbers, text, backgrounds, and hover highlights.
- **Expandable Diff Context**: Click any hunk header (e.g. `@@ -1,12 +1,18 @@`) to toggle and expand the full surrounding file context directly in the diff viewer.
- **Integrated Commit Box**: Toggle between **Review** and **Commit** anytime to commit your changes with git when you're done.

---

## Installation

### One-line Install (Recommended)

Run directly in your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/JohnMunozR/herdr-changes-review/main/install.sh | bash
```

### Manual Install

Clone the repository and run:

```bash
git clone https://github.com/JohnMunozR/herdr-changes-review.git
cd herdr-changes-review
./install.sh
```

### What the installer does:

1. Copies the mod to `~/.config/herdr-app/mods/changes-review`.
2. Validates the mod code using `herdr-app check`.
3. Clones `main` to `main-copy` (Herdr's recommended personal layout pattern) if not already cloned.
4. Configures the `changes` panel to use `changes-review`.
5. Switches to the layout live in your running Herdr window.

---

## Uninstallation

To revert back to Herdr's default `changes` mod:

```bash
./install.sh --uninstall
```

---

## Project Structure

```
herdr-changes-review/
├── install.sh
├── README.md
├── .gitignore
└── herdr-app/
    └── mods/
        └── changes-review/
            ├── changes.svg
            ├── gpui-kit.d.ts
            ├── jsconfig.json
            ├── main.js
            ├── mod.json
            └── icons/
                ├── bot.svg
                ├── comment.svg
                ├── git-commit.svg
                ├── send.svg
                └── trash.svg
```

---

## License

Apache-2.0 License. See [LICENSE](LICENSE) for details.
