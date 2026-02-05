# Development & Contributing Guide

## Project Structure

```
tools/lang-tools/
├── index.html         - Main HTML file with version metadata (line ~154)
├── prompts.js         - Flashcard prompts and content
├── api.js             - API integrations (translation, TTS, etc.)
├── script.js          - Core application logic, spaced repetition algorithm
├── style.css          - Styling and responsive design
└── CONTRIBUTING.md    - This file
```

## Critical: Version Bumping Workflow

**⚠️ When editing ANY file (HTML, JS, CSS, or Prompts), follow this workflow:**

### 1. Make Your Changes
Edit the relevant files as needed.

### 2. Bump Version in index.html (line ~154)
```html
<!-- Change this: -->
<div class="version">v0.1.28</div>

<!-- To this: -->
<div class="version">v0.1.29</div>
```

Increment the patch version (last number).

### 3. Update ALL Script Cache-Busting Parameters (lines ~155-157)
```html
<!-- Change ALL three: -->
<script src="prompts.js?v=0.1.28"></script>
<script src="api.js?v=0.1.28"></script>
<script src="script.js?v=0.1.28"></script>

<!-- To: -->
<script src="prompts.js?v=0.1.29"></script>
<script src="api.js?v=0.1.29"></script>
<script src="script.js?v=0.1.29"></script>
```

**🚨 CRITICAL**: Missing even ONE causes browser cache issues! Users will see stale code.

### 4. Test Your Changes
Before committing:
- Open `index.html` in a browser (or deploy and test)
- Verify the version displays correctly in the footer
- Test the functionality you changed
- Check browser console (F12) for JavaScript errors
- Test on mobile if relevant

### 5. Commit with Descriptive Message
```bash
git add tools/lang-tools/
git commit -m "lang-tools v0.1.29: [brief description]"
```

Example commit messages:
- `lang-tools v0.1.29: Fix spacing in Korean prompts`
- `lang-tools v0.1.30: Add new vocabulary set for travel`
- `lang-tools v0.1.31: Improve spaced repetition timing`

## Quick Reference Commands

**Find current version:**
```bash
grep "version" tools/lang-tools/index.html | head -4
```

**Check what needs updating:**
```bash
grep -n "v0.1." tools/lang-tools/index.html
```

Expected output should show 4 matches (1 display version + 3 cache busters).

## Code Organization

### prompts.js
- Flashcard content and language learning prompts
- Vocabulary sets organized by topic/level
- Question templates and answer formats

### script.js
- Core application logic
- Spaced repetition (SRS) algorithm implementation
- UI interactions and event handlers
- Local storage management
- Card rendering and state management

### api.js
- External API integrations
- Translation APIs
- Text-to-speech (TTS) services
- Error handling for API calls

### style.css
- UI styling and layout
- Responsive design for mobile/desktop
- Animation and transition effects
- Theme variables and color schemes

### index.html
- Main HTML structure
- **Version metadata** (line ~154)
- **Script imports with cache-busting** (lines ~155-157)
- Initial DOM structure

## Common Development Tasks

### Adding New Flashcard Content
1. Edit `prompts.js`
2. Add new vocabulary/prompts following existing format
3. Follow version bump workflow above
4. Test that new cards appear correctly

### Modifying Spaced Repetition Logic
1. Edit `script.js`
2. Update the SRS algorithm or timing logic
3. Follow version bump workflow above
4. Test with different card states (new, learning, review)

### Changing UI or Styling
1. Edit `style.css` or `index.html`
2. Follow version bump workflow above
3. Test responsiveness on different screen sizes
4. Check dark mode if applicable

### Integrating New APIs
1. Edit `api.js`
2. Add API key handling (use environment variables or config)
3. Follow version bump workflow above
4. Test API calls and error handling

### Debugging Issues
1. Open browser DevTools (F12)
2. Check Console tab for JavaScript errors
3. Check Network tab for failed API requests
4. Check Application > Local Storage for state data
5. Verify correct version is loaded (check footer display)

## Deployment Notes

When deploying to GitHub Pages:
- Changes go live automatically after pushing to main branch
- Wait ~1 minute for GitHub Pages to rebuild
- Test with hard refresh (Ctrl+F5 / Cmd+Shift+R) to bypass cache
- If users report stale content, verify cache-busting versions were updated

## Remember

**Every change = version bump (4 locations in index.html)**

1. Display version: `<div class="version">v0.1.XX</div>`
2. Cache buster: `prompts.js?v=0.1.XX`
3. Cache buster: `api.js?v=0.1.XX`
4. Cache buster: `script.js?v=0.1.XX`

No exceptions. This is mandatory to prevent browser caching issues.
