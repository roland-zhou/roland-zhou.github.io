# Development & Contributing Guide

## Dev steps

### 1. Make Your Changes
Edit the relevant files as needed.

### 2. Bump Version in index.html
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

No need for now.

### 5. Commit with Descriptive Message
```bash
git add tools/lang-tools/
git commit -m "lang-tools v0.1.29: [brief description]"
```

Example commit messages:
- `lang-tools v0.1.29: Fix spacing in Korean prompts`
- `lang-tools v0.1.30: Add new vocabulary set for travel`
- `lang-tools v0.1.31: Improve spaced repetition timing`

### 6. Push it to origin
