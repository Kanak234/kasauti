# KASAUTI — install and first run

## Install the extension (one step)

**In VS Code:** Extensions view → `…` menu (top right) → **Install from VSIX…** → pick `kasauti-0.1.0.vsix`.

**Or from a terminal:**
```bash
code --install-extension kasauti-0.1.0.vsix
```

Then reload VS Code. Nothing else is needed — no Python, no Node, no account, no internet.

## First run

1. Open any project folder.
2. Click the **KASAUTI** icon in the Activity Bar (the stepped pyramid).
3. Press **Scan workspace**. The pyramid builds itself, one block per file.
4. Click a block to see its functions and findings. Double-click to open the file.
5. Edit some code. The block recolours and the score moves **while you type**.

## If something looks wrong

Run **KASAUTI: Show Log** from the Command Palette. It records grammars that failed to load, files that could not be read, and scan timings.

Useful settings (`Ctrl+,` → search "kasauti"):

- `kasauti.liveAnalysis` — turn off to analyze on save instead of while typing
- `kasauti.diagnostics.scope` — `openFiles` (default), `workspace`, or `off`
- `kasauti.exclude` — extra folders to skip
- `kasauti.colorBlindPalette` — Okabe–Ito colours

## Working on the source

The full source is in this package. See `docs/DEVELOPMENT.md` to build it, and `docs/SPEC.md` for the PRD, TRD, UI/UX brief, every decision, and the verification record.

```bash
npm install
npm test           # 58 tests
npm run package    # rebuilds the .vsix
```
