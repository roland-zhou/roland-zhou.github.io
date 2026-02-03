# Changelog

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
