# Typeless

Voice-to-text + AI desktop automation agent.
Electron app · Node.js 20 LTS · Windows-first · MIT License

Hold a hotkey → speak → release → Typeless types at your cursor or executes an AI-generated action plan.

---

## Hotkeys

| Hotkey | Action |
|---|---|
| `Ctrl+Space` | Dictate — hold, speak, release → types transcript at cursor |
| `Ctrl+Shift+Space` | Plan — hold, speak, release → AI generates action plan → review → run |
| `Alt+Shift+Escape` | Abort — cancels any in-progress operation |
| `Alt+Z` | Undo — 10-second window after an action completes |

---

## Prerequisites

Install these before running `npm install`.

### 1. SoX (required — microphone capture)

Typeless uses `node-record-lpcm16` which spawns SoX as a subprocess to capture your microphone.

| Platform | Command |
|---|---|
| **Windows** | `winget install -e --id ChrisBagwell.SoX` |
| **macOS** | `brew install sox` |
| **Linux (Ubuntu/Debian)** | `sudo apt install sox libsox-fmt-all` |
| **Linux (Fedora)** | `sudo dnf install sox` |
| **Linux (Arch)** | `sudo pacman -S sox` |

Verify: `sox --version`

### 2. Visual C++ Build Tools (Windows — required for native modules)

Required by `@nut-tree-fork/nut-js`, `keytar`, and `screenshot-desktop`.

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools
winget install Python.Python.3
```

---

## Setup

```bash
# 1. Install dependencies
cd src
npm install

# 2. Configure API keys
cd ..
cp .env.example .env
# Edit .env — add at least one provider key (GEMINI_API_KEY recommended)
```

---

## API Keys (.env)

At minimum, set one voice transcription provider:

| Key | Provider | Notes |
|---|---|---|
| `GEMINI_API_KEY` | Google Gemini | **Default** — free tier available |
| `OPENAI_API_KEY` | OpenAI Whisper | Paid |
| `GROK_API_KEY` | xAI Grok | OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | Claude | 2-phase: raw STT + Claude cleanup pass |

Change the active provider in `src/config/app.config.json`:
```json
{ "voice": { "provider": "gemini" } }
```
Supported values: `gemini` | `openai` | `grok` | `claude` | `local`

---

## Run

```bash
cd src
npm start          # production
npm run dev        # with DevTools inspector
```

---

## Privacy

- Transcribed text is stored **locally only** in `config/runtime.store.json` (last 20 entries)
- API keys are read from `.env` — never committed, never sent except to the configured provider
- User credentials (vault) are stored in the **OS keychain** via keytar — never in `.env` or any file
- `runtime.store.json` is unencrypted — it relies on OS filesystem permissions
- Analytics are opt-in (`telemetry.enabled: false` by default)

---

## Architecture

```
main.js
  ├─ Alt+Space (dictate)
  │    capture _targetHwnd → HUD → record → transcribe → classify
  │    → SetForegroundWindow + sleep(50ms) → keyboard.type(text)
  │
  └─ Alt+Shift+Space (plan)
       capture screenshot + windowList → HUD → record → transcribe
       → planner → validator → HUD preview → executor
```

See `CLAUDE.md` for full architecture documentation.

---

## Voice Providers

### Claude provider — 2-phase approach

Claude's API does not support raw audio input. When `voice.provider = "claude"`:
1. **Phase 1** — raw STT via Gemini → OpenAI → Grok (first available key)
2. **Phase 2** — transcript sent to Claude Messages API for cleanup (punctuation, homophones, formatting)

Requires `ANTHROPIC_API_KEY` + at least one of `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `GROK_API_KEY`.

---

## Known Limitations

- **Elevated processes**: `keyboard.type()` is blocked by Windows UIPI against Task Manager, UAC prompts, and some games with anti-cheat. Run Typeless as administrator to type into elevated windows.
- **Hotkey conflicts**: If `Alt+Space` is taken by another app (e.g. some IMEs), remap in Settings → Hotkeys.
- **SoX required**: App will show an error and quit on startup if SoX is not on PATH.
