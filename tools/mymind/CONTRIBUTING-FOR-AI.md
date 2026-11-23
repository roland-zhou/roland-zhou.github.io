# MyMind Development & Release Guide

## Release Versioning & Update Toast

MyMind tracks client versions via `RELEASES` at the top of `tools/mymind/app.js` and persists the last seen version in `localStorage` under `mymind.version`.

Whenever you make a user-facing change to MyMind (new feature, UX improvement, or bug fix):

1. **Prepend a new release entry** to `RELEASES` in `tools/mymind/app.js`:
   ```js
   const RELEASES = [
       { version: '1.1.1', note: '用简短的一句话描述本次更新内容' },
       { version: '1.1.0', note: '支持单选与多选节点的复制、剪切与粘贴为子节点' },
       ...
   ];
   ```
   - `APP_VERSION` is derived automatically from `RELEASES[0].version`.
   - Use semantic versioning: bump patch (`x.y.Z`) for fixes/small tweaks, minor (`x.Y.0`) for new features, major (`X.0.0`) for breaking changes.
   - Keep `note` to a single short Chinese sentence — it is shown directly in the startup update toast (`已更新至 vX.Y.Z：<note>`).

2. **How the client upgrade toast works**:
   - First-time visitors (no existing `mymind.v1` data and no `mymind.version`) silently record `APP_VERSION` without showing an update toast.
   - Returning users whose stored `mymind.version` is older than `APP_VERSION` (or who have existing `mymind.v1` data from before versioning was added) see a brief toast on startup and then update `mymind.version`.

3. **Service Worker assets**:
   - `tools/mymind/sw.js` uses `networkFirst` with `cache: 'no-cache'` for existing assets, so editing existing files does not require bumping `CACHE_NAME`.
   - If you add a new static asset file used by MyMind, add it to `ASSET_PATHS` in `tools/mymind/sw.js`.
