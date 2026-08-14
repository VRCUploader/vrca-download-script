// ==UserScript==
// @name         VRChat Avatar Downloader
// @namespace    https://vrchat.com/
// @version      1.0
// @description  Adds a download button + platform/version picker to your uploaded avatars on "My Avatars" and individual avatar pages. Downloads the chosen .vrca bundle for PC, Android, or iOS. Only works for avatars you uploaded yourself - VRChat does not return a file URL for anyone else's avatar.
// @author       VRCUploader Team
// @match        https://vrchat.com/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/VRCUploader/vrca-download-script/main/vrcaDownloader.user.js
// @downloadURL  https://raw.githubusercontent.com/VRCUploader/vrca-download-script/main/vrcaDownloader.user.js
// ==/UserScript==

(function () {
    'use strict';

    const AVATAR_LINK = 'a[href*="/home/avatar/avtr_"]';
    const AVATAR_ID_RE = /(avtr_[0-9a-fA-F-]{36})/;
    const USER_ID_RE = /\/home\/user\/(usr_[0-9a-fA-F-]{36})/;
    const FILE_ID_RE = /\/file\/(file_[0-9a-fA-F-]+)\//;
    const VERSION_RE = /\/file\/(file_[0-9a-fA-F-]+)\/(\d+)\//;

    // Section title that marks avatars belonging to the logged-in user.
    const OWN_SECTION = 'my avatars';

    // /avatars/{id} only fills in assetUrl when the caller is the author, so a
    // response without one means the avatar belongs to someone else.
    const NOT_YOURS = 'No file URL - only your own uploads have one';

    const PLATFORMS = [
        { id: 'standalonewindows', label: 'PC' },
        { id: 'android', label: 'Android' },
        { id: 'ios', label: 'iOS' },
    ];

    // Generated bundles that either can't be fetched or aren't the avatar itself.
    const EXCLUDED_VARIANTS = new Set(['security', 'impostor']);

    const style = document.createElement('style');
    style.textContent = `
        /* Wrapping keeps the pickers from squeezing the button's label out of
           its own box in a narrow sidebar. */
        .vrca-row {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            align-items: stretch;
            margin: 12px;
        }
        .vrca-row.vrca-detail { margin: 12px 0; }
        .vrca-overlay {
            position: absolute;
            top: 6px;
            right: 6px;
            margin: 0;
            z-index: 20;
        }
        .vrca-dl-btn {
            flex: 1 1 auto;
            min-width: max-content;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            padding: 10px 12px;
            box-sizing: border-box;
            font: 600 14px/1 system-ui, sans-serif;
            color: #fff;
            background: rgba(50, 120, 220, 0.9);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            cursor: pointer;
            user-select: none;
            white-space: nowrap;
            transition: background .15s ease;
        }
        .vrca-dl-btn:hover { background: rgba(60, 140, 240, 1); }
        .vrca-dl-btn[disabled] { opacity: .7; cursor: default; }
        .vrca-dl-btn.err { background: rgba(190, 40, 40, 0.95); }
        .vrca-dl-btn.ok  { background: rgba(40, 150, 70, 0.95); }

        /* Keeps both pickers on the same line as each other when the row wraps. */
        .vrca-pickers { display: flex; flex: 0 0 auto; gap: 8px; }
        .vrca-compact .vrca-pickers { gap: 6px; }

        .vrca-ver { position: relative; flex: 0 0 auto; }
        .vrca-ver-trigger {
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 10px 12px;
            font: 600 14px/1 system-ui, sans-serif;
            color: #fff;
            background: rgba(60, 60, 70, 0.9);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            cursor: pointer;
            white-space: nowrap;
        }
        .vrca-ver-trigger:hover { background: rgba(80, 80, 95, 1); }

        .vrca-compact .vrca-dl-btn,
        .vrca-compact .vrca-ver-trigger {
            flex: 0 0 auto;
            padding: 6px 9px;
            font-size: 12px;
        }
        .vrca-row.vrca-compact:not(.vrca-overlay) { margin: 6px 0; gap: 6px; }

        /* Lives in <body> so a card's overflow:hidden can't clip it. */
        .vrca-ver-menu {
            position: fixed;
            min-width: 130px;
            max-height: 240px;
            overflow-y: auto;
            background: #1c1c22;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            z-index: 99999;
            box-shadow: 0 6px 20px rgba(0,0,0,.5);
        }
        .vrca-ver-item {
            display: block;
            width: 100%;
            text-align: left;
            padding: 8px 12px;
            background: none;
            border: 0;
            color: #fff;
            font: 500 13px/1 system-ui, sans-serif;
            cursor: pointer;
            white-space: nowrap;
        }
        .vrca-ver-item:hover { background: rgba(50, 120, 220, 0.9); }
        .vrca-ver-item.active { background: rgba(50, 120, 220, 0.55); }
        .vrca-ver-item.missing { color: #888; }
        .vrca-ver-item.missing:hover { background: rgba(80, 80, 95, 0.9); }
        .vrca-ver-msg {
            padding: 8px 12px;
            color: #ddd;
            font: 500 13px/1.35 system-ui, sans-serif;
            white-space: normal;
            max-width: 240px;
        }
        .vrca-ver-msg.err { color: #ff8080; cursor: pointer; }
        .vrca-ver-note {
            padding: 8px 12px;
            color: #c8b06a;
            font: 500 12px/1.35 system-ui, sans-serif;
            border-bottom: 1px solid rgba(255,255,255,0.12);
            white-space: normal;
            max-width: 220px;
        }
    `;
    document.head.appendChild(style);

    // ------------------------------------------------------------------
    // API
    // ------------------------------------------------------------------

    // One fetch per avatar / file, shared between the button and the dropdowns.
    const avatarCache = new Map();
    const fileMetaCache = new Map();

    // Who we are. Needed before anything is drawn, because a download button on
    // someone else's avatar could never work - the API withholds the file URL.
    let myUserId = null;
    let userReady = false;

    async function fetchCurrentUserId() {
        const response = await fetch('https://vrchat.com/api/1/auth/user', {
            credentials: 'include',
        });
        if (!response.ok) return null; // 401 when logged out
        const user = await response.json();
        return user?.id || null;
    }

    // Unlike worlds there is no /avatars/{id}/files endpoint - the avatar object
    // is the only place unityPackages (and with them assetUrl) come from.
    async function fetchAvatar(avatarId) {
        const response = await fetch(`https://vrchat.com/api/1/avatars/${avatarId}`, {
            credentials: 'include',
        });
        if (response.status === 401) throw new Error('Not logged in to vrchat.com');
        if (!response.ok) throw new Error(`Avatar lookup failed (HTTP ${response.status})`);
        return response.json();
    }

    function platformLabel(platformId) {
        return PLATFORMS.find(platform => platform.id === platformId)?.label || platformId;
    }

    // Only rewrite the version number after the file id, not the 1 in /api/1/.
    function versionUrl(template, version) {
        return template.replace(
            /\/file\/(file_[0-9a-fA-F-]+)\/\d+(\/|$)/,
            `/file/$1/${version}$2`
        );
    }

    // Versions of a file that actually have downloadable data. A version entry
    // can still exist after its data is gone (deleted flag, missing file blob,
    // or a size of 0 bytes).
    async function getAvailableVersions(fileId) {
        if (!fileMetaCache.has(fileId)) {
            const promise = (async () => {
                const response = await fetch(`https://vrchat.com/api/1/file/${fileId}`, {
                    credentials: 'include',
                });
                if (!response.ok) throw new Error('Could not check file versions');
                const data = await response.json();
                const available = new Set();
                for (const entry of data.versions || []) {
                    if (!entry || entry.version < 1) continue;
                    if (entry.deleted) continue;
                    const file = entry.file;
                    if (entry.status === 'complete'
                        && file?.status === 'complete'
                        && (file.sizeInBytes || 0) > 0) {
                        available.add(entry.version);
                    }
                }
                return available;
            })();
            promise.catch(() => fileMetaCache.delete(fileId));
            fileMetaCache.set(fileId, promise);
        }
        return fileMetaCache.get(fileId);
    }

    // Security and impostor bundles live alongside the real one but aren't the
    // avatar you uploaded, so they never belong in the version list.
    function isDownloadableAsset(pkg, platform) {
        return Boolean(pkg && pkg.platform === platform
            && pkg.assetUrl
            && !pkg.assetUrl.includes('/variant/')
            && !EXCLUDED_VARIANTS.has(pkg.variant));
    }

    // File ids currently used by a platform.
    function fileIdsForPlatform(packages, platform) {
        const ids = new Set();
        for (const pkg of packages) {
            if (!isDownloadableAsset(pkg, platform)) continue;
            const match = pkg.assetUrl.match(FILE_ID_RE);
            if (match) ids.add(match[1]);
        }
        return ids;
    }

    // Platforms that currently share a file id with the given one. The API only
    // lists each platform's latest upload, so older versions of a shared file
    // can't be attributed reliably - warn instead of guessing.
    function platformsSharingFile(packages, platform) {
        const ours = fileIdsForPlatform(packages, platform);
        if (!ours.size) return [];
        return PLATFORMS
            .filter(option => option.id !== platform)
            .filter(option => {
                const theirs = fileIdsForPlatform(packages, option.id);
                return [...theirs].some(fileId => ours.has(fileId));
            })
            .map(option => option.label);
    }

    // Every version from latest down to 1. Entries present in unityPackages are verified.
    async function toVersionList(packages, platform) {
        const verified = new Map(); // version -> url
        let latest = 0;
        let template = null;

        for (const pkg of packages) {
            if (!isDownloadableAsset(pkg, platform)) continue;
            const asset = pkg.assetUrl;
            const match = asset.match(VERSION_RE);
            const version = match ? parseInt(match[2], 10) : (pkg.assetVersion || 0);
            if (!version) continue;
            const url = asset.replace('api.vrchat.cloud', 'vrchat.com');
            verified.set(version, url);
            if (version > latest) {
                latest = version;
                template = url;
            }
        }

        if (!latest || !template) return [];

        // unityPackages can cite more than one file id for the same platform, so
        // check availability per file instead of assuming they all share the latest.
        const urls = new Map(); // version -> url
        for (let version = latest; version >= 1; version--) {
            urls.set(version, verified.get(version) || versionUrl(template, version));
        }
        const fileIds = new Set(
            [...urls.values()].map(url => url.match(FILE_ID_RE)?.[1]).filter(Boolean));
        const availability = new Map(); // fileId -> Set(version) | null
        await Promise.all([...fileIds].map(async fileId => {
            try {
                availability.set(fileId, await getAvailableVersions(fileId));
            } catch (error) {
                console.warn('[VRCA] file meta lookup failed', fileId, error);
                availability.set(fileId, null);
            }
        }));

        const versions = [];
        for (let version = latest; version >= 1; version--) {
            const url = urls.get(version);
            const fileId = url.match(FILE_ID_RE)?.[1];
            const availableVersions = fileId ? availability.get(fileId) : null;
            versions.push({
                version,
                url,
                verified: verified.has(version),
                // null = unknown (metadata lookup failed)
                available: availableVersions ? availableVersions.has(version) : null,
            });
        }
        return versions;
    }

    function getAvatar(avatarId) {
        if (!avatarCache.has(avatarId)) {
            const promise = fetchAvatar(avatarId);
            promise.catch(() => avatarCache.delete(avatarId)); // let a failed lookup retry
            avatarCache.set(avatarId, promise);
        }
        return avatarCache.get(avatarId);
    }

    async function getPackages(avatarId) {
        const avatar = await getAvatar(avatarId);
        const packages = Array.isArray(avatar.unityPackages) ? avatar.unityPackages : [];
        if (!packages.some(pkg => pkg.assetUrl)) throw new Error(NOT_YOURS);
        return packages;
    }

    async function getVersions(avatarId, platform) {
        const packages = await getPackages(avatarId);
        const list = await toVersionList(packages, platform);
        if (!list.length) {
            throw new Error(`No ${platformLabel(platform)} bundle found`);
        }
        return list;
    }

    // Errors that retrying can't fix, so the UI shouldn't invite a second click.
    function isPermanent(message) {
        return message === NOT_YOURS
            || /No .+ bundle found/.test(message)
            || /is not available/.test(message);
    }

    function download(url) {
        const link = document.createElement('a');
        link.href = url;
        link.download = '';
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    function stopEvent(event) {
        event.preventDefault();
        event.stopPropagation();
    }

    // ------------------------------------------------------------------
    // Controls
    // ------------------------------------------------------------------

    function makeControls(avatarId, { compact = false } = {}) {
        const row = document.createElement('div');
        row.className = compact ? 'vrca-row vrca-compact' : 'vrca-row';

        let selectedVersion = 'latest';
        let platform = 'standalonewindows';
        let cachedVersions = null;
        let sharedWith = [];
        let onPlatformChange = null;
        let versionTrigger = null;

        const pickers = document.createElement('div');
        pickers.className = 'vrca-pickers';
        pickers.append(makePlatformPicker(), makeVersionPicker());
        row.append(makeButton(), pickers);
        return row;

        function makeButton() {
            const idle = compact ? '⬇ VRCA' : '⬇ Download VRCA';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'vrca-dl-btn';
            button.title = `Download ${platformLabel(platform)} (.vrca) bundle`;
            button.innerHTML = `<span class="vrca-lbl">${idle}</span>`;
            const label = button.querySelector('.vrca-lbl');

            const reset = () => {
                label.textContent = idle;
                button.disabled = false;
                delete button.dataset.busy;
            };
            const flash = (state, text, holdMs) => {
                button.classList.add(state);
                label.textContent = text;
                setTimeout(() => { button.classList.remove(state); reset(); }, holdMs);
            };

            button.addEventListener('mousedown', stopEvent);
            button.addEventListener('click', async event => {
                stopEvent(event);
                if (button.dataset.busy) return;
                button.dataset.busy = '1';
                button.disabled = true;
                button.classList.remove('err', 'ok');

                try {
                    label.textContent = compact ? '…' : 'Fetching…';
                    const list = await getVersions(avatarId, platform);
                    const entry = selectedVersion === 'latest'
                        ? list[0]
                        : list.find(item => String(item.version) === selectedVersion) || list[0];
                    if (entry.available === false) {
                        throw new Error(`v${entry.version} is not available`);
                    }
                    download(entry.url);
                    flash('ok', compact ? `v${entry.version} ✓` : `Downloading v${entry.version} ✓`, 2500);
                } catch (error) {
                    console.error('[VRCA]', error);
                    const message = String(error.message || error);
                    button.title = message;
                    flash('err', compact
                        ? (isPermanent(message) ? '✕ none' : '✕ retry')
                        : (message || 'Error - tap to retry'), 3000);
                }
            });

            onPlatformChange = () => {
                button.title = `Download ${platformLabel(platform)} (.vrca) bundle`;
            };
            return button;
        }

        function makeDropdown({ triggerText, buildItems }) {
            const picker = document.createElement('div');
            picker.className = 'vrca-ver';

            const trigger = document.createElement('button');
            trigger.type = 'button';
            trigger.className = 'vrca-ver-trigger';
            trigger.textContent = triggerText;
            picker.appendChild(trigger);

            let menu = null;

            const closeOnOutsideClick = event => {
                if (menu && !menu.contains(event.target) && !trigger.contains(event.target)) close();
            };

            // Close on page/carousel scroll, but not when scrolling inside the menu.
            const closeOnOutsideScroll = event => {
                if (menu && !menu.contains(event.target)) close();
            };

            function open() {
                menu = document.createElement('div');
                menu.className = 'vrca-ver-menu';
                document.body.appendChild(menu);
                document.addEventListener('click', closeOnOutsideClick, true);
                window.addEventListener('scroll', closeOnOutsideScroll, true);
                window.addEventListener('resize', close);
                buildItems(menu, { showMessage, reposition, close, trigger });
            }

            function close() {
                if (!menu) return;
                menu.remove();
                menu = null;
                document.removeEventListener('click', closeOnOutsideClick, true);
                window.removeEventListener('scroll', closeOnOutsideScroll, true);
                window.removeEventListener('resize', close);
            }

            // Pin under the trigger with right edges aligned (menu lives in <body>).
            function reposition() {
                const rect = trigger.getBoundingClientRect();
                menu.style.top = `${rect.bottom + 4}px`;
                menu.style.right = `${window.innerWidth - rect.right}px`;
            }

            function showMessage(text, isError = false) {
                menu.className = 'vrca-ver-menu vrca-ver-msg' + (isError ? ' err' : '');
                menu.textContent = text;
                reposition();
            }

            trigger.addEventListener('mousedown', event => event.stopPropagation());
            trigger.addEventListener('click', event => {
                stopEvent(event);
                if (menu) close();
                else open();
            });

            return { picker, trigger, close };
        }

        function makePlatformPicker() {
            const { picker, trigger } = makeDropdown({
                triggerText: platformLabel(platform) + ' ▾',
                buildItems(menu, { reposition, close, trigger }) {
                    menu.className = 'vrca-ver-menu';
                    menu.textContent = '';

                    for (const option of PLATFORMS) {
                        const item = document.createElement('button');
                        item.type = 'button';
                        item.className = 'vrca-ver-item' + (option.id === platform ? ' active' : '');
                        item.textContent = option.label;
                        item.addEventListener('click', event => {
                            stopEvent(event);
                            if (option.id !== platform) {
                                platform = option.id;
                                selectedVersion = 'latest';
                                cachedVersions = null;
                                sharedWith = [];
                                trigger.textContent = option.label + ' ▾';
                                versionTrigger.textContent = 'Latest ▾';
                                onPlatformChange?.();
                            }
                            close();
                        });
                        menu.appendChild(item);
                    }
                    reposition();
                },
            });
            return picker;
        }

        function makeVersionPicker() {
            const { picker, trigger } = makeDropdown({
                triggerText: 'Latest ▾',
                buildItems(menu, { showMessage, reposition, close, trigger }) {
                    if (cachedVersions) {
                        render(cachedVersions, menu, { reposition, close, trigger });
                    } else {
                        showMessage('Loading…');
                        load(menu, { showMessage, reposition, close, trigger });
                    }
                },
            });
            versionTrigger = trigger;
            return picker;

            function render(list, menu, { reposition, close, trigger }) {
                menu.className = 'vrca-ver-menu';
                menu.textContent = '';

                if (sharedWith.length) {
                    const note = document.createElement('div');
                    note.className = 'vrca-ver-note';
                    note.textContent = `Shares file with ${sharedWith.join(', ')} - `
                        + 'older versions may belong to another platform';
                    menu.appendChild(note);
                }

                const latest = list[0];
                const options = [{
                    value: 'latest',
                    text: `Latest (v${latest.version})${latest.verified ? ' ✓' : ''}`,
                    triggerText: 'Latest',
                    missing: latest.available === false,
                }].concat(list.map(entry => {
                    const missing = entry.available === false;
                    const mark = missing ? ' ✕' : (entry.verified ? ' ✓' : '');
                    return {
                        value: String(entry.version),
                        text: `v${entry.version}${mark}`,
                        triggerText: `v${entry.version}${mark}`,
                        missing,
                    };
                }));

                for (const option of options) {
                    const item = document.createElement('button');
                    item.type = 'button';
                    item.className = 'vrca-ver-item'
                        + (option.value === selectedVersion ? ' active' : '')
                        + (option.missing ? ' missing' : '');
                    item.textContent = option.text;
                    item.addEventListener('click', event => {
                        stopEvent(event);
                        selectedVersion = option.value;
                        trigger.textContent = option.triggerText + ' ▾';
                        close();
                    });
                    menu.appendChild(item);
                }
                reposition();
            }

            async function load(menu, { showMessage, reposition, close, trigger }) {
                try {
                    // getVersions reuses the cached avatar fetch, so this is one request.
                    const packages = await getPackages(avatarId);
                    sharedWith = platformsSharingFile(packages, platform);
                    cachedVersions = await getVersions(avatarId, platform);
                    if (menu.isConnected) render(cachedVersions, menu, { reposition, close, trigger });
                } catch (error) {
                    console.error('[VRCA]', error);
                    if (!menu.isConnected) return;
                    const message = String(error.message || '');
                    if (isPermanent(message)) {
                        showMessage(message);
                        return;
                    }
                    showMessage('Error - tap to retry', true);
                    menu.onclick = event => {
                        event.stopPropagation();
                        close();
                        trigger.click();
                    };
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Placement
    // ------------------------------------------------------------------

    function currentAvatarId() {
        const match = location.pathname.match(AVATAR_ID_RE);
        return match ? match[1] : null;
    }

    // Nearest enclosing section title, e.g. "my avatars" or "featured avatars".
    function sectionHeading(element) {
        for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
            const heading = node.querySelector(':scope > h1, :scope > h2, :scope > h3');
            if (heading) return heading.textContent.trim().toLowerCase();
        }
        return null;
    }

    // Whether a card's avatar is ours, decided without an extra request per card.
    // An author link inside the card settles it; otherwise only the "My Avatars"
    // section counts. Anything we can't prove is treated as somebody else's.
    function ownsCard(card) {
        const authorLink = card.querySelector('a[href*="/home/user/usr_"]');
        if (authorLink) {
            const authorId = (authorLink.getAttribute('href') || '').match(USER_ID_RE)?.[1];
            return Boolean(myUserId) && authorId === myUserId;
        }
        return sectionHeading(card) === OWN_SECTION;
    }

    // A single avatar page is worth one authoritative lookup - and it warms the
    // cache the download button reads from.
    async function ownsAvatarId(avatarId) {
        try {
            const avatar = await getAvatar(avatarId);
            return Boolean(myUserId) && avatar.authorId === myUserId;
        } catch (error) {
            console.warn('[VRCA] ownership check failed', avatarId, error);
            return false;
        }
    }

    function countAvatars(element) {
        const ids = new Set();
        element.querySelectorAll(AVATAR_LINK).forEach(anchor => {
            const match = (anchor.getAttribute('href') || '').match(AVATAR_ID_RE);
            if (match) ids.add(match[1]);
        });
        return ids.size;
    }

    function isFramed(element) {
        const styles = getComputedStyle(element);
        const border = parseFloat(styles.borderTopWidth) || 0;
        const outline = parseFloat(styles.outlineWidth) || 0;
        return (border > 0 && styles.borderTopStyle !== 'none') ||
               (outline > 0 && styles.outlineStyle !== 'none');
    }

    // Fallback for layouts this script doesn't know by name: the outermost
    // bordered ancestor that still wraps a single avatar.
    function findCard(anchor) {
        let card = anchor;
        let framed = null;
        while (card.parentElement && card.parentElement !== document.body) {
            if (countAvatars(card.parentElement) > 1) break;
            card = card.parentElement;
            if (isFramed(card)) framed = card;
        }
        return { card, framed };
    }

    function overlayTile(anchor) {
        let element = anchor.parentElement;
        while (element && element !== document.body && countAvatars(element) <= 1) {
            if (isFramed(element)) return element;
            element = element.parentElement;
        }
        return anchor.parentElement;
    }

    function placeOverlay(tile, controls) {
        if (getComputedStyle(tile).position === 'static') tile.style.position = 'relative';
        controls.classList.add('vrca-overlay');
        tile.appendChild(controls);
    }

    // Sit the controls right after the title row: tiles have a fixed height that
    // would clip a child appended at the bottom.
    function placeAfterTitle(card, controls) {
        const title = card.querySelector('a[aria-label="Open Avatar Page"]')
            || [...card.querySelectorAll(AVATAR_LINK)].find(link => !link.querySelector('img'));
        if (title && title.parentElement && card.contains(title.parentElement)) {
            title.parentElement.insertAdjacentElement('afterend', controls);
        } else {
            card.appendChild(controls);
        }
    }

    function addToCards(root) {
        root.querySelectorAll(AVATAR_LINK).forEach(anchor => {
            const avatarId = (anchor.getAttribute('href') || '').match(AVATAR_ID_RE)?.[1];
            if (!avatarId || avatarId === currentAvatarId()) return; // detail page handles its own avatar

            // "My Avatars" and search results: a wide row whose right-hand column
            // holds the name, privacy badge and description.
            const listRow = anchor.closest('.search-container');
            if (listRow) {
                if (listRow.querySelector('.vrca-dl-btn') || !ownsCard(listRow)) return;
                const column = listRow.querySelector('.col-md-5') || listRow;
                column.appendChild(makeControls(avatarId, { compact: true }));
                return;
            }

            // "Current Avatar" and other square tiles.
            const tile = anchor.closest('[aria-label="Avatar Card"]');
            if (tile) {
                if (tile.querySelector('.vrca-dl-btn') || !ownsCard(tile)) return;
                placeAfterTitle(tile, makeControls(avatarId, { compact: true }));
                return;
            }

            // Unknown layout: a full-card overlay link sits on top of a CSS
            // background thumbnail, everything else wraps an <img> in page flow.
            if (getComputedStyle(anchor).position === 'absolute') {
                const overlay = overlayTile(anchor);
                if (overlay.querySelector('.vrca-overlay') || !ownsCard(overlay)) return;
                placeOverlay(overlay, makeControls(avatarId, { compact: true }));
                return;
            }
            const { card, framed } = findCard(anchor);
            if (!card.querySelector('.vrca-dl-btn') && card.querySelector('img') && ownsCard(card)) {
                (framed || card).appendChild(makeControls(avatarId, { compact: true }));
            }
        });
    }

    function headingWithText(text) {
        for (const heading of document.querySelectorAll('h1, h2, h3, h4, h5')) {
            if (heading.textContent.trim().toLowerCase() === text) return heading;
        }
        return null;
    }

    // The avatar page's class names are generated, so anchor on the panel
    // headings instead. "Manage Avatar" only renders on your own avatars, which
    // is where the button is actually usable; "Avatar Info" is always there.
    function detailPanel() {
        const heading = headingWithText('manage avatar') || headingWithText('avatar info');
        if (!heading) return null;
        let panel = heading.parentElement;
        // Some headings sit alone in a wrapper div - climb past it to the panel.
        if (panel && panel.children.length === 1) panel = panel.parentElement;
        return panel;
    }

    // Avatar whose ownership lookup has already been started, so the mutation
    // observer can't fire a second one while the first is in flight.
    let detailChecked = null;

    async function addToAvatarPage() {
        const avatarId = currentAvatarId();
        const existing = document.querySelector('.vrca-detail');

        if (!avatarId) {
            detailChecked = null;
            existing?.remove();
            return;
        }
        if (existing) {
            if (existing.dataset.avatarId === avatarId) return;
            existing.remove(); // navigated to a different avatar
        }

        if (!detailPanel()) return; // still rendering
        if (detailChecked === avatarId) return;
        detailChecked = avatarId;

        if (!(await ownsAvatarId(avatarId))) return;

        // The page can navigate away while the lookup is in flight.
        const panel = detailPanel();
        if (!panel || currentAvatarId() !== avatarId) return;
        if (document.querySelector('.vrca-detail')) return;

        const controls = makeControls(avatarId);
        controls.classList.add('vrca-detail');
        controls.dataset.avatarId = avatarId;
        panel.appendChild(controls);
    }

    function refresh() {
        if (!userReady) return;
        addToCards(document);
        addToAvatarPage();
    }

    fetchCurrentUserId()
        .then(id => { myUserId = id; })
        .catch(error => console.warn('[VRCA] could not identify the logged-in user', error))
        .finally(() => { userReady = true; refresh(); });

    // VRChat is a SPA, so re-scan as cards and pages render in.
    let queued = false;
    new MutationObserver(() => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; refresh(); });
    }).observe(document.body, { childList: true, subtree: true });
})();
