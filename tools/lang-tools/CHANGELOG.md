# Changelog

## v0.2.34 - Add Card Endpoint

### Changes
- **Add** and **Add All** now POST cards to a single configurable HTTP endpoint instead of the per-platform Anki paths (Anki-Connect / AnkiMobile URL / `.apkg` download)
- New **Add Card Endpoint** settings section: configure the endpoint URL plus optional Cloudflare Access headers `CF-Access-Client-Id` and `CF-Access-Client-Secret`
- Request body is `{ "notes": [{ "front", "back" }] }`; the CF headers are sent only when set
- Removed all Anki-specific code and the local APKG libraries (`sql-wasm`, `genanki`, `jszip`, `FileSaver`) now that adds go through the endpoint

---

## v0.2.33 - Learning Cards

### New Features
- **Generate Learning Cards**: Replaced the single "Create Anki Card" button with a "Generate Learning Cards" flow
- Uses the LLM to break the original text and its translation into 1–5 knowledge-point flashcards, focused on the hard Chinese → English production direction
- Each card BACK now includes two example sentences, with the translation, usage note, and examples separated by line breaks for readability
- Each generated card is shown as editable Front/Back text boxes so you can tweak before saving
- Per-card **Add** and **Delete** buttons, plus **Add All** / **Delete All** buttons to push every card to Anki or clear them at once
- Desktop adds are batched via Anki-Connect (`addNotes`); Android bundles all cards into one `.apkg`

### Technical Details
- New `constructCardsPrompt(original, translation)` in `prompts.js`
- New `pushNotesToAnki(notes)` helper in `script.js` consolidates the Android / iOS / desktop add paths

---

## v0.2.1 - DeepSeek Provider

### New Features
- **DeepSeek LLM Support**: Added DeepSeek as an LLM provider via its OpenAI-compatible API (`https://api.deepseek.com`)
- Models: deepseek-chat (default), deepseek-reasoner, deepseek-v4-flash
- Added `callDeepSeekAPI()` and wired it into the `callLLM()` router; temperature omitted for the reasoner model

---

## v0.2.0 - Multi-Provider Support

### New Features
- **Multi-Provider LLM Support**: Choose between Google Gemini, OpenAI, and Anthropic
- **Multi-Provider TTS Support**: Choose between OpenAI and ElevenLabs
- **Provider Selection**: Radio buttons to select active provider for LLM and TTS
- **Model Selection**: Dropdown menus for each provider with latest models
- **Settings Migration**: Automatic migration from old single-provider settings

### UI Changes
- Reorganized Settings Modal into two sections: LLM and TTS
- Added radio button selection for providers
- Each provider has its own config section with API key and model selection
- Cleaner, more organized settings interface

### API Changes
- Added `callLLM()` router function for multi-provider LLM support
- Added `callTTS()` router function for multi-provider TTS support
- New API functions:
  - `callOpenAILLM()` - OpenAI Chat Completions
  - `callAnthropicAPI()` - Anthropic Messages API
  - `callElevenLabsTTS()` - ElevenLabs Text-to-Speech
- Updated `callGeminiAPI()` to support model parameter
- Updated `callOpenAITTS()` to support model and voice parameters

### Supported Models

#### LLM Providers
**Google Gemini:**
- gemini-2.5-flash-latest (default)
- gemini-2.5-pro-latest
- gemini-2.0-flash
- gemini-1.5-pro-latest
- gemini-1.5-flash-latest

**OpenAI:**
- gpt-4o (default)
- gpt-4o-mini
- gpt-4-turbo
- gpt-3.5-turbo

**Anthropic:**
- claude-3-5-sonnet (default)
- claude-3-5-haiku
- claude-3-opus

#### TTS Providers
**OpenAI:**
- Models: tts-1-hd (default), tts-1
- Voices: alloy (default), echo, fable, onyx, nova, shimmer

**ElevenLabs:**
- eleven_turbo_v2_5 (default)
- eleven_multilingual_v2
- eleven_monolingual_v1

### Technical Details
- Settings stored in `localStorage` as JSON under key `lang_tools_settings`
- Old settings (`gemini_api_key`, `openai_api_key`) automatically migrated
- Provider configs show/hide based on radio button selection
- All API keys stored locally in browser

### Migration
Existing users' API keys will be automatically migrated to the new format on first load.

---

## v0.1.52 and earlier
See git history for previous changes.
