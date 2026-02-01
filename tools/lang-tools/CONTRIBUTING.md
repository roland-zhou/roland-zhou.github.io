# Development & Contributing Guide

## Release Process

When making ANY changes to the code (HTML, JS, CSS, or Prompts), you **MUST** follow this checklist:

1. **Test Changes**: Run the tests or verify manually.
2. **Bump Version**: Update the version number in `index.html`.
   - Look for: `<div class="version">v0.1.XX</div>`
   - Increment the patch version (e.g., v0.1.28 -> v0.1.29).
3. **Update ALL Cache-Busting Query Params**: Update the version in ALL script tags.
   - Find: `<script src="prompts.js?v=0.1.XX"></script>`
   - Find: `<script src="api.js?v=0.1.XX"></script>`
   - Find: `<script src="script.js?v=0.1.XX"></script>`
   - Update ALL three to match the new version.
   - **CRITICAL**: Browser cache issues happen if you miss even ONE file!
4. **Commit**: git commit with a descriptive message.

## Code Style
- Prompts are in `prompts.js`.
- Core logic is in `script.js`.
