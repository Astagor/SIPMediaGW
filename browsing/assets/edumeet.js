// eduMEET clients mark their controls with data-edumeet-* attributes (AUTOMATION.md in the
// edumeet repository). Clients older than these attributes are driven by their English or
// French labels instead, as before.
const LEGACY_LEAVE = ['LEAVE', 'QUITTER'];
const LEGACY_KEYS = {
    '1': ['audio'],
    '2': ['video', 'vidéo'],
    '3': ['chat'],
    'c': ['chat'],
    '4': ['hand', 'main'],
    '5': ['participants'],
    's': ['sharing', 'partage'],
    'q': ['sharing', 'partage'],
};
const CONTROL_KEYS = {
    '1': 'mic',
    '2': 'webcam',
    '3': 'chat',
    'c': 'chat',
    '4': 'raisehand',
    '5': 'participants',
    's': 'screenshare',
    'q': 'screenshare',
};
// Reaction names of the control page, mapped to the reactions of eduMEET.
const REACTIONS = {
    'thumbs-up': 'thumbup',
    'clapping-hands': 'clap',
    'party-popper': 'party',
    'face-with-tears-of-joy': 'laugh',
};
// A locked room keeps the gateway in its lobby until a moderator admits it.
const LOBBY_TIMEOUT = 15 * 60 * 1000;

const sleep = ms => new Promise(res => setTimeout(res, ms));

class EduMeet extends UIHelper {
    constructor(domain, roomName, displayName, lang, prompts, token, audioOnly, dualScreenOn) {
        super();
        this.domain = domain;
        this.roomName = roomName;
        this.displayName = displayName;
        this.lang = lang;
        this.token = token;
        this.audioOnly = audioOnly;
        this.joined = false;
    }

    _control(name) {
        return document.querySelector(`[data-edumeet-control="${name}"]`);
    }

    // True or false from data-edumeet-on, null on a client without it.
    _isOn(name) {
        const el = this._control(name);
        if (!el || !el.hasAttribute('data-edumeet-on')) return null;
        return el.getAttribute('data-edumeet-on') === 'true';
    }

    _setToggle(name, on) {
        const state = this._isOn(name);
        if (state === null) {
            console.warn('[!] No state for: ' + name);
            return false;
        }
        if (state !== on) this._control(name).click();
        return true;
    }

    _pageState() {
        return document.documentElement.getAttribute('data-edumeet-state');
    }

    _inMeeting() {
        const state = this._pageState();
        if (state !== null) return state === 'joined';
        return !!this._findAriaButton(LEGACY_LEAVE);
    }

    _setValue(input, value) {
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    async _waitEnabled(el, timeout) {
        const deadline = Date.now() + timeout;
        while (el.disabled && Date.now() < deadline) await sleep(50);
        return !el.disabled;
    }

    async join() {
        try {
            console.log('[INFO] Waiting for display name input...');
            let nameInput;
            try {
                nameInput = await this.waitForElement(
                    "[data-edumeet-control='name'], input[type='text']", { visible: true });
            } catch (e) {
                console.error('[✗] Name field not found:', e);
                return;
            }
            nameInput = this._control('name') || nameInput;
            this._setValue(nameInput, this.displayName);
            console.log('[✓] Name field filled');
            if (this.audioOnly) this._setToggle('webcam', false);
            console.log('[INFO] Clicking JOIN...');
            if (!await this._clickJoinUntilInMeeting(120000)) {
                console.error('[✗] Not in the meeting after JOIN retries');
                return;
            }
            this.blockerFocus();
            this.joined = true;
            console.log('[✓] Joined the meeting');
        } catch (error) {
            console.error('[✗] Prejoin process failed:', error);
        }
    }

    // Click JOIN and keep retrying while the app is still on the pre-join screen.
    // The first click can be swallowed if edumeet has not finished initializing;
    // the JOIN button disappearing is the reliable signal the click was accepted,
    // so we only re-click while the JOIN button is still present. A page that
    // reports its state is followed instead: no click while it waits in the
    // lobby, and no retry once it has stopped (data-edumeet-reason).
    async _clickJoinUntilInMeeting(timeout) {
        let deadline = Date.now() + timeout;
        const lobbyDeadline = Date.now() + LOBBY_TIMEOUT;
        while (Date.now() < deadline) {
            if (this._inMeeting()) return true;
            const reason = document.documentElement.getAttribute('data-edumeet-reason');
            if (reason) {
                console.error('[✗] The page stopped: ' + reason);
                return false;
            }
            if (this._pageState() === 'lobby') {
                deadline = lobbyDeadline;
                await sleep(2000);
                continue;
            }
            const joinButton = this._control('join') || [...document.querySelectorAll('button')]
                .find(b => (b.innerText || b.textContent || '').trim().toUpperCase().includes('JOIN'));
            if (joinButton) {
                joinButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                console.log('[~] JOIN clicked, waiting for the meeting...');
            }
            await sleep(2000);
        }
        return this._inMeeting();
    }

    async slideShot() {
        try {
            // Detection in two levels:
            // 1. NAME: every tile (video or avatar) shows the participant
            //    name in a stable MUI chip (.MuiChip-label, same family as
            //    .MuiBadge-badge). When someone shares with the camera on,
            //    the name appears on two tiles (share tile + camera tile).
            // 2. SIZE FALLBACK: if the name appears only once — the sharer's
            //    avatar tile is not rendered while they share with the camera
            //    off — capture when the largest video's long
            //    edge is >= 500px
            // A client that marks its videos (data-edumeet-video) needs neither.
            const nameMatches = (a, b) => {
                if (!a || !b) return false;
                if (a === b) return true;
                for (const t of [a, b]) {
                    if (t.endsWith('…') || t.endsWith('...')) {
                        const base = t.replace(/[.…]+$/, '').trim();
                        const other = (t === a) ? b : a;
                        if (base.length >= 4 && other.startsWith(base)) return true;
                    }
                }
                return false;
            };

            const tileName = (video) => {
                let el = video.parentElement;
                for (let k = 0; k < 6 && el; k++) {
                    const chip = el.querySelector('.MuiChip-label');
                    if (chip) return chip.textContent.trim();
                    el = el.parentElement;
                }
                return null;
            };

            const largest = (videos) => [...videos]
                .filter(v => v.videoWidth > 0)
                .sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight))[0];

            const findShareVideo = () => {
                if (document.querySelector('video[data-edumeet-video]')) {
                    return largest(document.querySelectorAll('video[data-edumeet-video="screen"]')) || null;
                }
                const candidate = largest(document.querySelectorAll('video'));
                if (!candidate) return null;
                const name = tileName(candidate);
                if (name) {
                    const count = [...document.querySelectorAll('.MuiChip-label')]
                        .filter(c => nameMatches(name, c.textContent.trim())).length;
                    if (count >= 2) return candidate;
                }
                if (Math.max(candidate.videoWidth, candidate.videoHeight) >= 500) return candidate;
                return null;
            };

            let video = findShareVideo();
            const maxWait = 2000;
            const step = 100;
            let waited = 0;
            while (!video && waited < maxWait) {
                await sleep(step);
                waited += step;
                video = findShareVideo();
            }
            if (!video) {
                return null;
            }
            // await the video to have valid dimensions
            if (!video.videoWidth || !video.videoHeight) {
                await new Promise(resolve => {
                    const onLoaded = () => {
                        video.removeEventListener('loadeddata', onLoaded);
                        resolve();
                    };
                    // fallback timeout if the event doesn't arrive
                    setTimeout(() => {
                        video.removeEventListener('loadeddata', onLoaded);
                        resolve();
                    }, 1000);
                    video.addEventListener('loadeddata', onLoaded);
                });
            }
            const width = video.videoWidth || video.clientWidth || 640;
            const height = video.videoHeight || video.clientHeight || Math.round(width * 9 / 16);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');

            ctx.drawImage(video, 0, 0, width, height);

            const dataURL = canvas.toDataURL('image/png');
            if (!dataURL) {
                return null;
            }
            // return the base64 part (without "data:image/png;base64,")
            return dataURL.split(',')[1];
        } catch (e) {
            console.error("slideShot failed:", e);
            return null;
        }
    }

    // Match a button by its aria-label against a list of localized labels
    // (EN/FR), case-insensitively. Returns the button or null.
    _findAriaButton(labels) {
        return [...document.querySelectorAll('button')].find(b =>
            labels.includes((b.getAttribute('aria-label') || '').trim().toUpperCase()));
    }

    _clickAria(labels) {
        for (const label of labels) {
            const btn = [...document.querySelectorAll('button')]
                .find(b => (b.getAttribute('aria-label') || '').toUpperCase().includes(label.toUpperCase()));
            if (btn) {
                btn.click();
                console.log('[✓] Toggled: ' + label);
                return true;
            }
        }
        console.warn('[!] No matching button for: ' + labels.join(' / '));
        return false;
    }

    interact(key) {
        if (!(key in CONTROL_KEYS)) {
            console.warn('[!] Unknown DTMF key: ' + key);
            return;
        }
        // An open leave dialog would hold every other control behind it.
        const cancel = this._control('leave-cancel');
        if (cancel) cancel.click();
        const control = this._control(CONTROL_KEYS[key]);
        if (control) {
            control.click();
            console.log('[✓] Toggled: ' + CONTROL_KEYS[key]);
            return;
        }
        this._clickAria(LEGACY_KEYS[key]);
    }

    mediaState() {
        const microphone = this._isOn('mic');
        const camera = this._isOn('webcam');
        if (microphone === null || camera === null) return null;
        return {
            microphone,
            camera,
            canPublishMicrophone: null,
            canPublishCamera: null
        };
    }

    microphone(param) {
        return this._setToggle('mic', param === 'on');
    }

    camera(param) {
        return this._setToggle('webcam', param === 'on');
    }

    panelState() {
        if (this._isOn('mic') === null) return null;
        return {
            chat: this._isOn('chat') === true,
            participants: this._isOn('participants') === true,
            handRaised: this._isOn('raisehand') === true
        };
    }

    screenShareState() {
        return document.querySelector('video[data-edumeet-video="screen"]') !== null;
    }

    // Null on a client without data-edumeet-* attributes: the control page then
    // offers its plain keys, as for a connector that reports no state.
    uiState() {
        const media = this.mediaState();
        if (!media) return null;
        return {
            media,
            panels: this.panelState(),
            screenShare: this.screenShareState(),
            dualScreen: false
        };
    }

    async reaction(name) {
        const id = REACTIONS[name] || (Object.values(REACTIONS).includes(name) ? name : null);
        if (!id) {
            console.error('[✗] Unknown reaction: ' + name);
            return false;
        }
        const toggle = this._control('reactions');
        if (!toggle) {
            console.error('[✗] Reactions button not found');
            return false;
        }
        toggle.click();
        try {
            const item = await this.waitForElement(
                `[data-edumeet-reaction="${id}"]`, { clickable: true }, 2000);
            item.click();
            return true;
        } catch (e) {
            console.error('[✗] Reaction not reachable: ' + id);
            const backdrop = document.querySelector('.MuiMenu-root .MuiBackdrop-root');
            if (backdrop) backdrop.click();
            return false;
        }
    }

    getParticipantNum() {
        const button = this._control('participants');
        if (button && button.hasAttribute('data-edumeet-count')) {
            const n = parseInt(button.getAttribute('data-edumeet-count'), 10);
            return Number.isNaN(n) ? null : n;
        }
        const btn = this._findAriaButton(['SHOW PARTICIPANTS', 'HIDE PARTICIPANTS',
                                          'AFFICHER LES PARTICIPANTS', 'MASQUER LES PARTICIPANTS']);
        if (!btn) return null;
        const badge = btn.querySelector('.MuiBadge-badge');
        if (!badge) return null;
        const n = parseInt(badge.textContent, 10);
        return Number.isNaN(n) ? null : n;
    }

    hasLeft() {
        if (!this.joined) return false;
        const html = document.documentElement;
        if (html.hasAttribute('data-edumeet-state')) {
            return this._pageState() === 'left' || html.hasAttribute('data-edumeet-reason');
        }
        return !this._findAriaButton(LEGACY_LEAVE);
    }

    async leave() {
        try {
            const deadline = Date.now() + 20000;
            while (Date.now() < deadline) {
                if (!this._inMeeting()) {
                    console.log('[✓] Left the meeting');
                    return;
                }
                // The confirm dialog is the one that holds a YES/OUI button.
                // Other dialogs (e.g. settings) may be open at the same time,
                // so scan all of them instead of taking the first match in the DOM.
                const yes = this._control('leave-confirm') ||
                    [...document.querySelectorAll('.MuiDialog-root, [role="dialog"]')]
                        .flatMap(d => [...d.querySelectorAll('button')])
                        .find(b => ['YES', 'OUI'].includes((b.innerText || '').trim().toUpperCase()));
                if (yes) {
                    yes.click();
                    console.log('[✓] Leave confirmed');
                    return;
                }
                // No confirm dialog yet: (re)click Leave. The click can be
                // swallowed like the JOIN one, so retry while the button is
                // still present.
                const leaveBtn = this._control('leave') || this._findAriaButton(LEGACY_LEAVE);
                if (leaveBtn) {
                    leaveBtn.click();
                    console.log('[~] Leave clicked, waiting for the confirm dialog...');
                }
                await sleep(1500);
            }
            console.warn('[✗] Leave failed: confirm dialog did not appear in time');
        } catch (e) {
            console.error('[✗] Leave failed:', e);
        }
    }

    async sendChat(message) {
        try {
            if (this._control('chat-input') || this._control('chat')) {
                let input = this._control('chat-input');
                if (!input) {
                    this._control('chat').click();
                    input = await this.waitForElement('[data-edumeet-control="chat-input"]', { visible: true }, 5000);
                }
                this._setValue(input, message);
                const send = this._control('chat-send');
                if (!send || !await this._waitEnabled(send, 2000)) {
                    console.warn('[!] Chat send button not available');
                    return false;
                }
                send.click();
                return true;
            }
            const chatInputVisible = [...document.querySelectorAll("input[type='text']")]
                .some(e => e.offsetParent !== null);
            if (!chatInputVisible) {
                const chatBtn = this._findAriaButton(['SHOW CHAT', 'HIDE CHAT',
                                                      'AFFICHER LE CHAT', 'MASQUER LE CHAT']);
                if (!chatBtn) {
                    console.warn('[!] Chat button not found');
                    return false;
                }
                chatBtn.click();
            }
            const input = await this.waitForElement("input[type='text']", { visible: true }, 5000);
            this._setValue(input, message);
            const sendBtn = this._findAriaButton(['ENTER CHAT MESSAGE...', 'ENTRER UN MESSAGE']);
            if (!sendBtn) {
                console.warn('[!] Chat send button not found');
                return false;
            }
            sendBtn.click();
            return true;
        } catch (e) {
            console.warn('[!] sendChat failed:', e);
            return false;
        }
    }
}

window.EduMeet = EduMeet;
window.Browsing = EduMeet;
