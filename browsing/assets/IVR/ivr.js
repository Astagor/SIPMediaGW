import { Room } from './room.js';

const messages = {
    fr: {
        valid: code => `Code validé : ${code}`,
        invalid: error => `Le code n'est pas valide ('${error}')`,
        incomplete: (count, expected) => `Le code est trop court (${count}/${expected})`,
        error: reason => `Erreur : ${reason}`,
        chosenDomain: (id, name) => `Plateforme sélectionnée (${id}) : ${name}`,
        confirmContinue: "— appuyez sur '#' pour continuer",
        endsIn: time => `L'appel se termine dans ${time} si aucune réunion n'est choisie`,
        allPlatforms: 'Toutes les plateformes',
        keypadEnter: 'Clavier : le numéro de la conférence, puis #',
        keypad: (enter, all) => `${enter} · * corrige${all ? ` · 0 # ${all}` : ''}`,
        pages: (page, count) => `Page ${page} sur ${count} · # page suivante · * page précédente`
    },
    en: {
        valid: code => `Code validated: ${code}`,
        invalid: error => `The code is not valid ('${error}')`,
        incomplete: (count, expected) => `The code is too short (${count}/${expected})`,
        error: reason => `Error: ${reason}`,
        chosenDomain: (id, name) => `Platform selected (${id}): ${name}`,
        confirmContinue: "— press '#' to continue",
        endsIn: time => `The call ends in ${time} if no meeting is chosen`,
        allPlatforms: 'All platforms',
        keypadEnter: 'Keypad: the conference number, then #',
        keypad: (enter, all) => `${enter} · * corrects${all ? ` · 0 # ${all}` : ''}`,
        pages: (page, count) => `Page ${page} of ${count} · # next page · * previous page`
    }
};

document.getElementById("digits").addEventListener("beforeinput", e => e.preventDefault());

fetch("../config.json")
    .then(res => res.json())
    .then(config => initIVR(config))
    .catch(err => console.error("Failed to load config.json", err));

function initIVR(config) {
    const messageEl = document.getElementById("message");
    const digitsEl = document.getElementById("digits");
    const statusEl = document.getElementById("status");
    const domainsEl = document.getElementById("domains");

    // The branding (window.ivrBrand) may replace prompts and messages of a language, key by key.
    const brand = window.ivrBrand || {};
    for (const [l, m] of Object.entries(brand.messages || {})) {
        if (messages[l]) Object.assign(messages[l], m);
    }
    const prompts = Object.fromEntries(Object.entries(config['ivr_prompts'])
        .map(([l, p]) => [l, { ...p, ...((brand.prompts || {})[l] || {}) }]));
    const lang = config['lang'] || 'en';
    document.documentElement.lang = lang;
    const expectedLength = parseInt(config['min_ivr_digit_length'], 10) || 0;
    const urlMixedId = new URLSearchParams(window.location.search).get("mixedId");
    // The SIP address may name a group of platforms by a code: "code", or "code.room"
    // (the room may contain dots), in any case. A platform is in the group of its own
    // key and in the groups of its "groups" field. Only the group is shown and numbered.
    // An address that starts with a digit keeps its meaning: the platform number.
    // A platform with "listed": false is left out of the full list: only its key and
    // its groups reach it.
    let group = groupFromSipAddress(config['webrtc_domains'], urlMixedId);
    const listed = Object.fromEntries(Object.entries(config['webrtc_domains'])
        .filter(([, obj]) => obj.listed !== false));
    let domains = parseDomains(group ? group.platforms : listed);
    // The launcher gives the phone the same platforms, in the same order.
    window.shownDomainKeys = Object.values(domains).map(d => d.key);
    // 0 # leads to the full list: from a group that does not hold all of it, and from
    // the room step back to the choice of the platform. The branding may rename it.
    const allName = brand.allPlatforms || messages[lang].allPlatforms;
    const keypadEnter = (brand.keypad || {})[lang] || messages[lang].keypadEnter;
    // A list longer than a page of the room screen is shown page by page; the numbers stay
    // the same on every page. The style sheet sets the page size with its columns.
    let page = 0;

    let inputDigits = [];
    let stage = "domain"; // 'domain' -> 'room'
    let selectedDomain = null;
    let pendingRoomId = null;
    let currentAudio = null;
    let waitingConfirm = null; // { proceed: Function, roomId: string } when mapping failed

    function parseDomains(raw) {
        const dict = {};
        let index = 1;
        for (const [key, obj] of Object.entries(raw)) {
            dict[index] = { id: index, key, name: obj.name, domain: obj.domain, browsing: obj.browsing || key };
            index++;
        }
        return dict;
    }

    function groupFromSipAddress(raw, mixedId) {
        if (!mixedId || /^[0-9]/.test(mixedId)) return null;
        const members = code => Object.fromEntries(Object.entries(raw).filter(([key, obj]) =>
            [key, ...(obj.groups || [])].some(name => String(name).toLowerCase() === code.toLowerCase())));
        let platforms = members(mixedId);
        if (Object.keys(platforms).length) return { platforms, room: null };
        const sep = mixedId.search(/[#.]/);
        if (sep > 0) {
            platforms = members(mixedId.slice(0, sep));
            if (Object.keys(platforms).length) return { platforms, room: mixedId.slice(sep + 1) };
        }
        return null;
    }

    function updateDisplay() {
        const filled = inputDigits.join(' ');
        let empty = "";
        if (stage === "domain") empty = inputDigits.length === 0 ? "_" : "";
        else if (stage === "room") empty = Array(Math.max(0, expectedLength - inputDigits.length)).fill('_').join(' ');
        digitsEl.textContent = [filled, empty].filter(Boolean).join(' ');
    }

    function showStatus(msg) {
        statusEl.textContent = msg;
    }

    function showDomainStatus(msg) {
        document.getElementById("domain-status").textContent = msg;
    }

    function formatError(err) {
        if (err === null || err === undefined) return String(err);
        if (typeof err === 'string') return err;
        if (typeof err === 'object') {
            if (typeof err.error === 'string') return err.error;
            if (typeof err.message === 'string') return err.message;
            if (err.conference) return String(err.conference);
            try { return JSON.stringify(err); } catch (e) { return String(err); }
        }
        return String(err);
    }

    function playPromptAudio(type, lang) {
        if (!config.ivr_tts) return;

        if (currentAudio) {
            currentAudio.pause();
            currentAudio.currentTime = 0;
        }
        currentAudio = new Audio(`./${type}_${lang}.mp3`);
        currentAudio.play();
        currentAudio.onended = () => {
            currentAudio = null;
        };
    }

    function domainItem(id, name, browsing, extraClass) {
        const iconSrc = `./images/domain-icons/${encodeURIComponent(browsing)}.png`;
        return `<div class="domain-item${extraClass}" style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:6px;margin:6px 0;background:#fff;border:1px solid #e2e2e2;">
                    <div style="display:flex;align-items:center;gap:8px;min-width:0;">
                      <div style="width:34px;height:34px;display:flex;align-items:center;justify-content:center;border:1px solid #ccc;border-radius:6px;font-weight:700;background:#fafafa;flex:0 0 34px;">${id}</div>
                      <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;">${name}</div>
                    </div>
                    ${browsing ? `<img src="${iconSrc}" alt="" style="width:28px;height:28px;object-fit:contain;margin-left:12px;flex:0 0 28px;" onerror="this.style.display='none'">` : ''}
                </div>`;
    }

    // The group of the SIP address does not show every listed platform.
    function groupHidesSome() {
        return !!group && Object.keys(listed).some(key => !(key in group.platforms));
    }

    function canGoToFullList() {
        return groupHidesSome() || Object.keys(listed).length > 1;
    }

    // A platform number has as many digits as the highest platform id. One more key
    // starts a new number instead of adding to the previous one.
    function platformDigits() {
        return String(Object.keys(domains).length).length;
    }

    function pageSize() {
        return parseInt(getComputedStyle(domainsEl).getPropertyValue('--page-size'), 10) || 20;
    }

    function pageCount() {
        return Math.ceil(Object.keys(domains).length / pageSize());
    }

    function pageLine() {
        let el = document.getElementById("pages");
        if (!el) {
            el = document.createElement("div");
            el.id = "pages";
            domainsEl.insertAdjacentElement("afterend", el);
        }
        return el;
    }

    function keypadLine() {
        let el = document.getElementById("keypad-help");
        if (!el) {
            el = document.createElement("div");
            el.id = "keypad-help";
            digitsEl.insertAdjacentElement("afterend", el);
        }
        return el;
    }

    function showPages(visible) {
        const pages = document.getElementById("pages");
        if (pages) pages.hidden = !visible;
    }

    function hideDomainList() {
        showPages(false);
        domainsEl.innerHTML = '';
        domainsEl.classList.add("hidden");
        // The list kept the height of its first page: release it, otherwise the
        // room prompt is separated from the input by an empty area.
        domainsEl.style.minHeight = '';
        domainsEl.style.display = "none";
    }

    function renderDomains() {
        const size = pageSize();
        const all = Object.values(domains);
        const shown = pageCount() > 1 ? all.slice(page * size, (page + 1) * size) : all;
        domainsEl.innerHTML = shown.map(d => domainItem(d.id, d.name, d.browsing, '')).join('') +
            (groupHidesSome() ? domainItem(0, allName, '', ' domain-all') : '');
        const pages = pageLine();
        pages.textContent = pageCount() > 1 ? messages[lang].pages(page + 1, pageCount()) : '';
        showPages(pageCount() > 1);
        // Every page keeps the height of the first one: the screen does not jump.
        domainsEl.style.minHeight = '';
        if (pageCount() > 1 && page === 0) domainsEl.dataset.pageHeight = domainsEl.offsetHeight;
        if (pageCount() > 1) domainsEl.style.minHeight = `${domainsEl.dataset.pageHeight}px`;
    }

    function showPrompt() {
        if (stage === "domain" && (Object.keys(domains).length > 1 || groupHidesSome())) {
            messageEl.innerHTML = prompts[lang].domain;
            // 0 # comes back to the list after the room step has hidden it.
            domainsEl.style.display = '';
            domainsEl.classList.remove("hidden");
            keypadLine().hidden = true;
            renderDomains();
            playPromptAudio("platform", lang);
        } else {
            hideDomainList();
            if (messageEl.innerHTML === prompts[lang].room) return;
            messageEl.innerHTML = prompts[lang].room;
            const keypad = keypadLine();
            keypad.textContent = messages[lang].keypad(keypadEnter, canGoToFullList() ? allName : '');
            keypad.hidden = false;
            playPromptAudio("conference", lang);
        }
    }

    // The full list of the platforms, from a group or from the room step.
    function showFullList() {
        group = null;
        domains = parseDomains(listed);
        window.shownDomainKeys = Object.values(domains).map(d => d.key);
        window.browsing = null;
        window.inputRoomName = null;
        window.inputRoomLanguage = null;
        selectedDomain = null;
        pendingRoomId = null;
        waitingConfirm = null;
        inputDigits = [];
        page = 0;
        stage = "domain";
        digitsEl.classList.remove("room-mode");
        digitsEl.style.visibility = "visible";
        document.getElementById("domain-status").style.display = "none";
        showStatus('');
        showPrompt();
        updateDisplay();
    }

    let firstDigitEntered = false;

    function activateDigitsHalo() {
        if (!firstDigitEntered) {
            digitsEl.classList.add("active");
            firstDigitEntered = true;
        }
    }

    function handleInput(char) {
        activateDigitsHalo()
        if (/^[a-zA-Z0-9-_/-_.]$/.test(char)) {
            if (stage === "domain") {
                inputDigits = inputDigits.length >= platformDigits() ? [char] : [...inputDigits, char];
            } else {
                inputDigits.push(char);
            }
        } else if (char === '*') {
            // With nothing typed, * on a list of several pages shows the page before.
            if (stage === "domain" && !inputDigits.length && pageCount() > 1) {
                page = (page - 1 + pageCount()) % pageCount();
                renderDomains();
            }
            inputDigits.pop();
        } else if (char === '#') {
            // With nothing typed, # on a list of several pages shows the next page.
            if (stage === "domain" && !inputDigits.length && pageCount() > 1) {
                page = (page + 1) % pageCount();
                renderDomains();
                return;
            }
            if (stage === "domain" && inputDigits.join('') === '0' && groupHidesSome()) {
                showFullList();
                return;
            }
            if (stage === "room" && (window.inputRoomName || inputDigits.join('')) === '0' && canGoToFullList()) {
                showFullList();
                return;
            }
            if (stage === "domain") {
                const domainId = parseInt(inputDigits.join(''), 10);
                if (!isNaN(domainId) && domains[domainId]) {
                    selectedDomain = domains[domainId];
                    showDomainStatus(messages[lang].chosenDomain(domainId, selectedDomain.name));
                    document.getElementById("domain-status").style.display = "block";
                    window.browsing = selectedDomain.key;
                    inputDigits = [];
                    stage = "room";
                    hideDomainList();
                    updateDisplay();
                    if (stage === "room") digitsEl.classList.add("room-mode");
                    if (pendingRoomId) {
                        digitsEl.style.visibility = "hidden";
                        (pendingRoomId + '#').split('').forEach(handleInput);
                        pendingRoomId = null;
                    } else {
                        showPrompt();
                    }
                } else {
                    showStatus(messages[lang].invalid(inputDigits.join('')));
                    // With more than nine platforms the digits add up: start again.
                    if (Object.keys(domains).length > 9) {
                        inputDigits = [];
                        updateDisplay();
                    }
                }
            } else if (stage === "room") {
                if(window.inputRoomName){
                    inputDigits = Array.from(window.inputRoomName);
                }
                // If we are waiting for user confirmation to proceed despite mapping failure
                if (waitingConfirm && inputDigits.join('') === (waitingConfirm.roomId || '')) {
                    // call proceed() to resolve the room.getConferenceName() promise
                    try {
                        waitingConfirm.proceed();
                    } catch (e) {
                        console.error("Failed to proceed despite mapping error", e);
                    }
                    waitingConfirm = null;
                    // keep UI; the initRoom's success callback will handle hiding UI
                    return;
                }
                const roomId = inputDigits.join('');
                if (expectedLength === 0 || inputDigits.length >= expectedLength) {
                    const room = new Room({ ...config, webrtc_domain: selectedDomain.domain });
                    room.initRoom(
                        roomId,
                        () => {
                            console.log("Room retrieved successfully:", room.roomName);
                            window.room = room;
                            digitsEl.style.display = "none";
                            messageEl.style.display = "none";
                            statusEl.style.display = "none";
                            domainsEl.style.display = "none";
                            document.removeEventListener('keydown', keyEvent);
                        },
                        (errorReason) => {
                            // If the room mapping failed but the room.js provided a proceed() callback,
                            // store it and ask the user to press '#' to continue anyway.
                            if (errorReason && typeof errorReason.proceed === 'function') {
                                waitingConfirm = { proceed: errorReason.proceed, roomId };
                                console.error("Mapping failed; waiting user confirmation:", errorReason.error);
                                const errMsg = formatError(errorReason.error);
                                showStatus(messages[lang].invalid(errMsg) + " " + messages[lang].confirmContinue);
                                digitsEl.style.visibility = "visible";
                                // do not call showPrompt() to keep the state waiting for '#'
                            } else {
                                console.error("Error entering room:", errorReason.error);
                                const errMsg = formatError(errorReason && errorReason.error ? errorReason.error : errorReason);
                                showStatus(messages[lang].invalid(errMsg));
                                digitsEl.style.visibility = "visible";
                                showPrompt();
                            }
                        }
                    );
                } else {
                    showStatus(messages[lang].incomplete(inputDigits.length, expectedLength));
                    digitsEl.style.visibility = "visible";
                    showPrompt();
                }
            }
            return;
        }
        updateDisplay();
        showStatus("");
    }

    function keyEvent(e) {
        handleInput(e.key);
    }
    document.addEventListener('keydown', keyEvent);

    // Auto-enter from URL
    const urlParams = new URLSearchParams(window.location.search);
    const urlDomainId = urlParams.get("domainId");
    const urlDomainKey = urlParams.get("domainKey");
    const urlRoomId = urlParams.get("roomId");

    if (urlRoomId && urlRoomId !== '0') pendingRoomId = urlRoomId;

    if (urlMixedId) {
        let d = null, r = null;
        if (group) {
            // Only the group is shown; a group of one platform is selected below.
            r = group.room;
        } else if (/^[1-9]$/.test(urlMixedId)) {
            d = urlMixedId;
        } else {
            // Split on '#' or '.'
            const parts = urlMixedId.split(/[#.]/);
            if (parts.length === 2) {
                [d, r] = parts;
            } else {
                r = urlMixedId;
            }
        }
        if (r && !/^[0-9]$/.test(r)) pendingRoomId = r;
        if (d && /^[1-9][0-9]*$/.test(d)) {
            if (domains[d]) {
                selectedDomain = domains[d];
                (selectedDomain.id + '#').split('').forEach(handleInput);
                console.log(`Auto-selected domain (from mixedId): ${selectedDomain.name}`);
                showDomainStatus(messages[lang].chosenDomain(d, selectedDomain.name));
            }
        }
    }

    if (urlDomainKey) {
        const found = Object.values(domains).find(d => d.key === urlDomainKey);
        if (found) {
            selectedDomain = found;
            (selectedDomain.id + '#').split('').forEach(handleInput);
            showDomainStatus(messages[lang].chosenDomain(found.id, found.name));
        }
    } else if (urlDomainId && domains[urlDomainId]) {
        selectedDomain = domains[urlDomainId];
        (selectedDomain.id + '#').split('').forEach(handleInput);
        console.log(`Auto-selected domain (by id): ${selectedDomain.name}`);
        showDomainStatus(messages[lang].chosenDomain(urlDomainId, selectedDomain.name));
    }

    if (!selectedDomain && Object.keys(domains).length === 1) {
        selectedDomain = Object.values(domains)[0];
        (selectedDomain.id + '#').split('').forEach(handleInput);
        console.log(`Single domain mode: auto-selected ${selectedDomain.name}`);
    }

    if (!selectedDomain) {
        showPrompt();
        updateDisplay();
    }

    // ivr.py sets window.ivrDeadline (milliseconds) when IVR_TIMEOUT is set: the call
    // ends then, unless a meeting is chosen. The page may have no element for it.
    let countdownEl = document.getElementById("countdown");
    if (!countdownEl) {
        countdownEl = document.createElement("div");
        countdownEl.id = "countdown";
        statusEl.insertAdjacentElement("afterend", countdownEl);
    }
    function showCountdown() {
        if (!window.ivrDeadline || window.room) {
            countdownEl.textContent = "";
            countdownEl.style.display = "none";
            return;
        }
        const left = Math.max(0, Math.ceil((window.ivrDeadline - Date.now()) / 1000));
        const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        countdownEl.textContent = messages[lang].endsIn(time);
        countdownEl.classList.toggle("ending", left <= 60);
        countdownEl.style.display = "block";
    }
    showCountdown();
    setInterval(showCountdown, 1000);
}
