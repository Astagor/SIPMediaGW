// The languages of the pairing and control pages, and the choice between them. Loaded after
// brand.js and before the page's own texts and script; plain globals, as brand.js.
//
// The page starts in the language the visitor chose in the menu, else in the first of the
// browser's languages that it has, else in BRAND.lang, else in English. BRAND.langSwitch false
// keeps it in BRAND.lang and hides the menu.

const LANGUAGES = [
  { code: 'cs', name: 'Čeština', tags: ['cs'] },
  { code: 'da', name: 'Dansk', tags: ['da'] },
  { code: 'de', name: 'Deutsch', tags: ['de'] },
  { code: 'en', name: 'English', tags: ['en'] },
  { code: 'es', name: 'Español', tags: ['es'] },
  { code: 'fr', name: 'Français', tags: ['fr'] },
  { code: 'hr', name: 'Hrvatski', tags: ['hr'] },
  { code: 'it', name: 'Italiano', tags: ['it'] },
  { code: 'hu', name: 'Magyar', tags: ['hu'] },
  { code: 'nb', name: 'Norsk bokmål', tags: ['nb', 'no', 'nn'] },
  { code: 'pl', name: 'Polski', tags: ['pl'] },
  { code: 'pt', name: 'Português', tags: ['pt'] },
  { code: 'ro', name: 'Română', tags: ['ro'] },
  { code: 'tr', name: 'Türkçe', tags: ['tr'] },
  { code: 'el', name: 'Ελληνικά', tags: ['el'] },
  { code: 'ru', name: 'Русский', tags: ['ru'] },
  { code: 'uk', name: 'Українська', tags: ['uk'] },
];

function storedValue(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

// The exact tag first, then the language with each of its subtags, then the language alone,
// as the eduMEET client matches its locales: pt-BR and nb-NO still find their language.
function languageForTag(tag, offered) {
  const [language, ...subtags] = String(tag || '').toLowerCase().replace(/_/g, '-').split('-');
  const candidates = [[language, ...subtags].join('-'), ...subtags.map((s) => `${language}-${s}`), language];
  for (const candidate of candidates) {
    const found = offered.find((l) => l.tags.includes(candidate));
    if (found) return found.code;
  }
  return '';
}

function pageLanguage(texts) {
  const brand = typeof BRAND !== 'undefined' ? BRAND : {};
  const offered = LANGUAGES.filter((l) => texts[l.code]);
  const has = (code) => !!code && offered.some((l) => l.code === code);
  if (brand.langSwitch === false && has(brand.lang)) return brand.lang;
  // The portal writes 'lang' too, from the browser, for French or English only: a stored
  // language counts as a choice only when the menu set it.
  const chosen = storedValue('langChosen') === '1' ? storedValue('lang') : '';
  if (has(chosen)) return chosen;
  const preferred = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const tag of preferred) {
    const code = languageForTag(tag, offered);
    if (code) return code;
  }
  return has(brand.lang) ? brand.lang : 'en';
}

function rememberLanguage(code) {
  try {
    localStorage.setItem('lang', code);
    localStorage.setItem('langChosen', '1');
  } catch (e) {}
}

// The menu: a native select over the short code of the current language, so the header keeps
// its size and a phone opens its own picker. onChange gets the new language.
function setUpLanguageMenu(texts, current, onChange) {
  const pick = document.getElementById('lang-pick');
  const select = document.getElementById('lang-select');
  if (!pick || !select) return;
  if (typeof BRAND !== 'undefined' && BRAND.langSwitch === false && texts[BRAND.lang]) {
    pick.hidden = true;
    return;
  }
  for (const l of LANGUAGES.filter((x) => texts[x.code])) {
    const option = document.createElement('option');
    option.value = l.code;
    option.textContent = l.name;
    option.lang = l.code;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    rememberLanguage(select.value);
    onChange(select.value);
  });
  showLanguage(current, texts);
}

function showLanguage(code, texts) {
  const select = document.getElementById('lang-select');
  const shown = document.getElementById('lang-code');
  if (!select || !shown) return;
  select.value = code;
  shown.textContent = code.toUpperCase();
  if (texts && texts[code] && texts[code].language) select.setAttribute('aria-label', texts[code].language);
}
