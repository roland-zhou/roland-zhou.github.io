# Settings UI Preview

## New API Settings Modal Structure

```
┌─────────────────────────────────────────────────┐
│  API Settings                               ✕   │
├─────────────────────────────────────────────────┤
│                                                 │
│  LLM Provider                                   │
│  ─────────────────────────────────────────────  │
│                                                 │
│  ┌───────────────────────────────────────────┐ │
│  │ ⦿ Google Gemini                          │ │
│  │   ┌─────────────────────────────────────┐│ │
│  │   │ API Key: ••••••••••••••••••••••••••││ │
│  │   └─────────────────────────────────────┘│ │
│  │   ┌─────────────────────────────────────┐│ │
│  │   │ Model: gemini-2.5-flash-latest ▼   ││ │
│  │   └─────────────────────────────────────┘│ │
│  └───────────────────────────────────────────┘ │
│                                                 │
│  ┌───────────────────────────────────────────┐ │
│  │ ○ OpenAI                                 │ │
│  └───────────────────────────────────────────┘ │
│                                                 │
│  ┌───────────────────────────────────────────┐ │
│  │ ○ Anthropic                              │ │
│  └───────────────────────────────────────────┘ │
│                                                 │
│  TTS Provider                                   │
│  ─────────────────────────────────────────────  │
│                                                 │
│  ┌───────────────────────────────────────────┐ │
│  │ ⦿ OpenAI                                 │ │
│  │   ┌─────────────────────────────────────┐│ │
│  │   │ API Key: ••••••••••••••••••••••••••││ │
│  │   └─────────────────────────────────────┘│ │
│  │   ┌─────────────────────────────────────┐│ │
│  │   │ Model: tts-1-hd ▼                  ││ │
│  │   └─────────────────────────────────────┘│ │
│  │   ┌─────────────────────────────────────┐│ │
│  │   │ Voice: alloy ▼                     ││ │
│  │   └─────────────────────────────────────┘│ │
│  └───────────────────────────────────────────┘ │
│                                                 │
│  ┌───────────────────────────────────────────┐ │
│  │ ○ ElevenLabs                             │ │
│  └───────────────────────────────────────────┘ │
│                                                 │
│  All API keys are stored locally in your        │
│  browser.                                       │
│                                                 │
├─────────────────────────────────────────────────┤
│                        [ Cancel ]  [ Save ]     │
└─────────────────────────────────────────────────┘
```

## Key Features

### 1. **Collapsible Provider Sections**
- Only the selected provider's config is visible
- Click radio button to expand/collapse
- Prevents clutter and confusion

### 2. **LLM Providers** (3 options)
- **Google Gemini** (default)
  - 5 newest models available
- **OpenAI**
  - 4 most popular models
- **Anthropic**
  - 3 Claude models

### 3. **TTS Providers** (2 options)
- **OpenAI** (default)
  - 2 quality levels
  - 6 voice options
- **ElevenLabs**
  - 3 model options
  - Auto-selects first available voice

### 4. **Auto-Migration**
Old single-field settings automatically convert to new format

### 5. **Smart Defaults**
- Gemini: gemini-2.5-flash-latest (fastest)
- OpenAI LLM: gpt-4o (best quality)
- Anthropic: claude-3-5-sonnet (balanced)
- OpenAI TTS: tts-1-hd + alloy voice
- ElevenLabs: eleven_turbo_v2_5 (fastest)

## Usage

1. Click Settings ⚙️ button
2. Select your preferred LLM provider (radio button)
3. Enter API key for selected provider
4. Choose model from dropdown
5. Select your preferred TTS provider (radio button)
6. Enter API key and choose model/voice
7. Click Save

Only the selected providers need API keys configured.
