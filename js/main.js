/* =============================================================
   ЛОГИКА ЭКРАНА ЗАГРУЗКИ — GMod / Helix StarWarsRP
   -------------------------------------------------------------
   • Чистый ES2017, без внешних библиотек (совместимо со старым
     Chromium в GMod: без optional chaining, top-level await).
   • Документация движка: wiki.facepunch.com/gmod/Loading_URL
   ============================================================= */
(function () {
  'use strict';

  /* =====================================================
     1. ВНУТРЕННЕЕ СОСТОЯНИЕ
     Хуки GMod могут сработать до готовности DOM, поэтому
     все данные сначала кладём сюда, а перерисовку делаем позже.
     ===================================================== */
  var state = {
    steamidFromUrl: null,     // точный SteamID64 из ?steamid=%s (строка!)
    steamidFromDetails: null,// SteamID64 из GameDetails (может быть числом)
    urlMap: null,            // карта из ?map=%m
    serverName: null,
    map: null,
    gamemode: null,
    maxPlayers: null,
    musicVolume: null,        // snd_musicvolume игрока (0..1)
    filesTotal: null,         // всего файлов (SetFilesTotal)
    filesNeeded: null,        // осталось файлов (SetFilesNeeded)
    statusText: null,         // статус движка (SetStatusChanged)
    currentFile: null,        // текущий файл (DownloadingFile)
    cssProgressSeen: false,   // приходила ли внешняя --loading-progress
    lastCssProgress: 0,        // последнее валидное значение из --loading-progress
    domReady: false
  };

  /* Кэш DOM-элементов */
  var dom = {};

  var audio = null;           // объект Audio (создаётся в initMusic)
  var audioStarted = false;  // реально ли началось воспроизведение

  /* Иконки плеера (инлайн-SVG, без библиотек) */
  var ICONS = {
    sound: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    muted: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
  };

  /* =====================================================
     2. УТИЛИТЫ
     ===================================================== */
  function $(id) { return document.getElementById(id); }

  function setText(id, value) {
    var el = $(id);
    if (el && typeof value === 'string' && value !== '') el.textContent = value;
  }

  function toInt(value) {
    var n = parseInt(value, 10);
    return isNaN(n) ? null : n;
  }

  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

  function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

  /* Красивое имя карты: rp_ender_generator -> Rp ender generator */
  function prettyMap(name) {
    if (!isNonEmptyString(name)) return '';
    var n = String(name).replace(/\.bsp$/i, '').replace(/[_\-]+/g, ' ').trim();
    return n.charAt(0).toUpperCase() + n.slice(1);
  }

  /* Последний сегмент пути файла + защита от переполнения */
  function shortFileName(path) {
    if (!isNonEmptyString(path)) return '';
    var parts = String(path).split('/');
    var last = parts[parts.length - 1];
    return last.length > 42 ? last.slice(0, 39) + '…' : last;
  }

  /* Параметр из URL (?name=value) */
  function getUrlParam(name) {
    try {
      var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  /* =====================================================
     3. ХУКИ GARRY'S MOD
     Регистрируем их СРАЗУ (до init), чтобы не потерять данные,
     если движок вызовет их раньше готовности DOM.
     ===================================================== */

  /* GameDetails — вызывается движком, когда страница загрузилась.
     Официальный формат — ПОЗИЦИОННЫЕ аргументы:
       (servername, serverurl, mapname, maxplayers, steamid, gamemode, volume, language)
     Для надёжности дополнительно поддерживаем JSON-строку и объект
     (их иногда передают кастомные сборки). */
  window.GameDetails = function () {
    var d = {};
    var first = arguments[0];

    if (arguments.length === 1 && first !== null && typeof first !== 'function') {
      if (typeof first === 'object') {
        d = first;
      } else if (typeof first === 'string') {
        try {
          var parsed = JSON.parse(first);
          if (parsed && typeof parsed === 'object') d = parsed;
        } catch (e) { /* не JSON — пойдём в позиционный вариант */ }
      }
    }

    /* Официальный позиционный формат (wiki.facepunch.com/gmod/Loading_URL) */
    if (!d || Object.keys(d).length === 0) {
      d = {
        serverName: arguments[0],
        map: arguments[2],
        maxPlayers: arguments[3],
        steamid: arguments[4],
        gamemode: arguments[5],
        volume: arguments[6]
      };
    }

    /* Применяем только валидные значения — ошибочный JSON не должен
       затирать уже показанные правильные данные. */
    if (isNonEmptyString(d.serverName)) state.serverName = d.serverName;
    if (isNonEmptyString(d.map)) state.map = d.map;
    if (isNonEmptyString(d.gamemode)) state.gamemode = d.gamemode;
    var mp = toInt(d.maxPlayers);
    if (mp !== null) state.maxPlayers = mp;

    /* SteamID64 храним ТОЛЬКО строкой: 17 цифр не влезают в double
       без потери точности. Приоритет — точное значение из URL. */
    if (d.steamid !== null && d.steamid !== undefined) {
      state.steamidFromDetails = String(d.steamid);
    }

    var vol = parseFloat(d.volume);
    if (!isNaN(vol)) state.musicVolume = clamp(vol, 0, 1);

    applyServerInfo();
    applyEngineMusicVolume();
    loadSteamProfile();
  };

  /* Счётчики файлов — источник реального прогресса */
  window.SetFilesTotal = function (total) {
    state.filesTotal = toInt(total);
    renderProgress();
  };

  window.SetFilesNeeded = function (needed) {
    state.filesNeeded = toInt(needed);
    renderProgress();
  };

  window.DownloadingFile = function (fileName) {
    if (isNonEmptyString(fileName)) state.currentFile = fileName;
    renderStatus();
  };

  window.SetStatusChanged = function (status) {
    if (isNonEmptyString(status)) state.statusText = status;
    renderStatus();
  };

  /* =====================================================
     4. ПРОГРЕСС ЗАГРУЗКИ
     Приоритет источников:
       1) SetFilesTotal/SetFilesNeeded (реальные данные движка);
       2) внешняя CSS-переменная --loading-progress (только читаем!);
       3) ничего — режим ожидания: бегущий луч, без фейковых процентов.
     ===================================================== */

  /* Читаем --loading-progress с <html>. Формат допускает:
     "42%", "42" или "0.42" (доля). Сами в переменную не пишем,
     чтобы не принять собственную анимацию за данные движка. */
  function readCssProgress() {
    var raw = '';
    try {
      raw = getComputedStyle(document.documentElement).getPropertyValue('--loading-progress');
    } catch (e) { return null; }
    raw = String(raw).trim();
    if (raw === '') return null;

    var isPercent = raw.indexOf('%') !== -1;
    var v = parseFloat(raw);
    if (isNaN(v)) return null;
    if (isPercent || v > 1) return clamp(v, 0, 100);
    return clamp(v * 100, 0, 100); /* доля 0..1 */
  }

  function renderProgress() {
    if (!state.domReady) return;
    var percent = null;

    /* Источник 1: счётчики файлов */
    if (state.filesTotal !== null && state.filesNeeded !== null && state.filesTotal > 0) {
      var done = state.filesTotal - state.filesNeeded;
      if (done >= 0) percent = clamp((done / state.filesTotal) * 100, 0, 100);
    }

    /* Источник 2: внешняя CSS-переменная */
    if (percent === null) {
      var css = readCssProgress();
      if (css !== null) {
        state.cssProgressSeen = true;
        state.lastCssProgress = css;
        percent = css;
      } else if (state.cssProgressSeen) {
        /* Переменная перестала обновляться — держим последнее значение,
           не «откатываемся» назад и не симулируем рост. */
        percent = state.lastCssProgress;
      }
    }

    if (percent !== null) {
      dom.saber.classList.remove('is-indeterminate');
      dom.saberFill.style.width = percent + '%';
      dom.progressPercent.textContent = Math.round(percent) + '%';
    } else {
      /* Данных нет — режим ожидания. Не выдумываем проценты. */
      dom.saber.classList.add('is-indeterminate');
      dom.saberFill.style.width = '0%';
      dom.progressPercent.textContent = 'Ожидание данных…';
    }

    if (state.filesTotal !== null && state.filesNeeded !== null && state.filesTotal > 0) {
      var left = state.filesNeeded;
      if (left === null || left < 0) left = 0;
      dom.progressFiles.textContent = 'Файлы: ' + (state.filesTotal - left) + ' / ' + state.filesTotal;
    } else {
      dom.progressFiles.textContent = '';
    }
  }

  /* Внешняя --loading-progress может обновляться без вызова наших
     хуков — опрашиваем её раз в 500 мс. */
  function startProgressPolling() {
    setInterval(renderProgress, 500);
  }

  /* =====================================================
     5. СТАТУС ЗАГРУЗКИ
     Приоритет: SetStatusChanged > DownloadingFile > ротация
     статусов из CONFIG.
     ===================================================== */
  function renderStatus() {
    if (!state.domReady) return;
    if (isNonEmptyString(state.statusText)) {
      dom.statusText.textContent = state.statusText;
    } else if (isNonEmptyString(state.currentFile)) {
      dom.statusText.textContent = 'Загрузка: ' + shortFileName(state.currentFile);
    }
  }

  function startStatusRotation() {
    var msgs = CONFIG.statusMessages || [];
    if (!msgs.length) return;

    /* Случайная фраза, без повторения предыдущей */
    var last = -1;
    function randomIndex() {
      if (msgs.length === 1) return 0;
      var idx = Math.floor(Math.random() * msgs.length);
      if (idx === last) idx = (idx + 1) % msgs.length;
      return idx;
    }

    setInterval(function () {
      /* Двигатель уже сообщает статус — ротацию не трогаем */
      if (state.statusText || state.currentFile) return;
      last = randomIndex();
      dom.statusText.textContent = msgs[last];
    }, CONFIG.statusIntervalMs || 3500);
  }

  /* =====================================================
     6. ИНФОРМАЦИЯ О СЕРВЕРЕ
     ===================================================== */
  function applyServerInfo() {
    if (!state.domReady) return;

    setText('serverName', state.serverName || CONFIG.server.name);
    setText('infoMap', prettyMap(state.map || state.urlMap || CONFIG.fallbacks.map));
    setText('infoGamemode', state.gamemode || CONFIG.fallbacks.gamemode);

    /* GMod не передаёт текущий онлайн — показываем «— / максимум».
       Хотите живой онлайн — добавьте свой API (см. чеклист). */
    if (state.maxPlayers !== null) {
      setText('infoPlayers', '— / ' + state.maxPlayers);
    } else {
      setText('infoPlayers', CONFIG.texts.playersUnknown);
    }
  }

  /* =====================================================
     7. STEAM-ПРОФИЛЬ ИГРОКА
     Публичный XML-профиль: https://steamcommunity.com/profiles/{id}?xml=1
     Может не ответить (CORS в обычном браузере, приватный профиль,
     сеть) — тогда остаётся заглушка. Экран в любом случае работает.
     ===================================================== */
  function getSteamId() {
    /* Точный SteamID64 из URL приоритетнее: число из GameDetails
       (17 цифр) может терять точность в double. */
    if (state.steamidFromUrl && /^\d{17}$/.test(state.steamidFromUrl)) {
      return state.steamidFromUrl;
    }
    if (state.steamidFromDetails && /^\d{17}$/.test(state.steamidFromDetails)) {
      return state.steamidFromDetails;
    }
    return null;
  }

  function loadSteamProfile() {
    if (!state.domReady) return;

    var id = getSteamId();
    if (!id) { applySteamFallback(); return; }

    fetch('https://steamcommunity.com/profiles/' + id + '?xml=1', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (xmlText) {
        var doc = new DOMParser().parseFromString(xmlText, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('Некорректный XML');

        var nameEl = doc.querySelector('steamID');
        var avatarEl = doc.querySelector('avatarFull');

        if (nameEl && isNonEmptyString(nameEl.textContent)) {
          dom.playerName.textContent = nameEl.textContent;
        }
        if (avatarEl && isNonEmptyString(avatarEl.textContent)) {
          /* Даже валидный URL может не открыться — на месте подставим заглушку */
          dom.playerAvatar.onerror = function () {
            dom.playerAvatar.onerror = null;
            dom.playerAvatar.src = CONFIG.fallbacks.avatar;
          };
          dom.playerAvatar.src = avatarEl.textContent;
        }
      })
      .catch(function () {
        /* Сеть/CORS/приватный профиль — показываем заглушку */
        applySteamFallback();
      });
  }

  function applySteamFallback() {
    if (!state.domReady) return;
    dom.playerName.textContent = CONFIG.texts.defaultNickname;
    dom.playerAvatar.src = CONFIG.fallbacks.avatar;
  }

  /* =====================================================
     8. СЛАЙД-ШОУ ФОНА
     Незагрузившиеся слайды пропускаются; если не загрузился ни
     один — остаёмся на текущем (последнем рабочем).
     ===================================================== */
  function initSlideshow() {
    var list = CONFIG.backgrounds || [];
    var container = dom.bg;
    if (!container || !list.length) return;

    var slides = [];
    var i;

    for (i = 0; i < list.length; i++) {
      (function (src) {
        var img = document.createElement('img');
        img.className = 'bg__slide';
        img.alt = '';
        img.onload = function () { img.setAttribute('data-loaded', '1'); };
        container.appendChild(img);
        img.src = src;
        slides.push(img);
      })(list[i]);
    }

    var active = -1;

    function next() {
      if (!slides.length) return;
      var tries = 0;
      var idx = active;

      /* Ищем следующий слайд, который реально загрузился */
      while (tries < slides.length) {
        idx = (idx + 1) % slides.length;
        if (slides[idx].getAttribute('data-loaded') === '1') break;
        tries++;
      }
      if (slides[idx].getAttribute('data-loaded') !== '1') return;
      if (idx === active) return;

      if (active >= 0) slides[active].classList.remove('is-active');
      slides[idx].classList.add('is-active');
      active = idx;
    }

    next();
    setInterval(next, CONFIG.slideshowIntervalMs || 12000);
  }

  /* =====================================================
     9. РОТАЦИЯ ПРАВИЛ
     ===================================================== */
  function initRules() {
    var rules = CONFIG.rules || [];
    if (!rules.length) return;

    setText('rulesTitle', CONFIG.rulesTitle);

    var index = 0;

    function show(i) {
      dom.rulesList.innerHTML = '';
      var li = document.createElement('li');
      li.className = 'rules__item';
      li.textContent = rules[i];               /* textContent — защита от XSS */
      dom.rulesList.appendChild(li);
      dom.rulesCounter.textContent = (i + 1) + ' / ' + rules.length;
    }

    function rotate() {
      dom.rulesList.classList.add('is-fading');
      setTimeout(function () {
        index = (index + 1) % rules.length;
        show(index);
        dom.rulesList.classList.remove('is-fading');
      }, 350);
    }

    show(0);
    setInterval(rotate, CONFIG.rulesIntervalMs || 9000);
  }

  /* =====================================================
     10. СОЦСЕТИ
     ===================================================== */
  /* QR-коды: карточка «QR + подпись». Ссылка сохранена
     (в игре не кликабельно, но работает при открытии в браузере). */
  function initSocials() {
    var list = CONFIG.socials || [];
    var nav = dom.socials;
    if (!nav) return;

    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || !isNonEmptyString(s.url)) continue;

      var a = document.createElement('a');
      a.className = 'socials__qr';
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';

      var img = document.createElement('img');
      img.className = 'socials__qr-img';
      img.alt = s.label || s.url;
      img.src = s.qr || CONFIG.fallbacks.avatar; /* если QR не задан — заглушка */
      a.appendChild(img);

      var span = document.createElement('span');
      span.className = 'socials__qr-label';
      span.textContent = s.label || s.url;
      a.appendChild(span);

      nav.appendChild(a);
    }
  }

  /* =====================================================
     11. МУЗЫКА
     Автовоспроизведение запрещено браузером — старт по первому
     клику в любом месте страницы. UI отражает фактический
     результат audio.play(), а не сам факт клика.
     ===================================================== */
  function applyEngineMusicVolume() {
    /* GMod передаёт snd_musicvolume игрока — уважаем его настройку */
    if (audio && !audioStarted && state.musicVolume !== null) {
      audio.volume = clamp(state.musicVolume, 0, 1);
      if (dom.volumeSlider) {
        dom.volumeSlider.value = Math.round(audio.volume * 100);
      }
    }
  }

  function initMusic() {
    var player = dom.musicPlayer;

    if (!CONFIG.music || !CONFIG.music.enabled || !isNonEmptyString(CONFIG.music.src)) {
      if (player) player.style.display = 'none';
      return;
    }

    audio = new Audio();
    audio.preload = 'auto';
    audio.loop = true;
    audio.src = CONFIG.music.src;

    var initial = (typeof CONFIG.music.volume === 'number')
      ? clamp(CONFIG.music.volume, 0, 1) : 0.5;
    if (state.musicVolume !== null) initial = state.musicVolume;
    audio.volume = initial;
    dom.volumeSlider.value = Math.round(initial * 100);

    /* Файл не загрузился — скрываем плеер, экран продолжает работать */
    audio.addEventListener('error', function () {
      player.style.display = 'none';
      audio = null;
    });

    /* Попытка запуска (используется и автостартом, и первым кликом, и кнопкой) */
    function tryPlay() {
      if (!audio || audioStarted) return;
      var attempt = audio.play();
      if (attempt && typeof attempt.then === 'function') {
        attempt.then(function () {
          audioStarted = true;
          renderMuteButton();
        }).catch(function () {
          /* Автозапуск не удался — кнопка плеера всё ещё работает */
        });
      }
    }

    /* GMod: экран загрузки НЕ получает клики мыши, поэтому пробуем
       включить музыку СРАЗУ. В CEF GMod автовоспроизведение разрешено.
       В обычном браузере автозапуск может быть заблокирован политикой —
       тогда музыка стартует по первому клику (слушатель ниже). */
    tryPlay();
    audio.addEventListener('loadeddata', function () { tryPlay(); });

    /* Первый клик где угодно на странице — запасной вариант для браузера */
    document.addEventListener('click', function () { tryPlay(); });

    /* Кнопка mute/unmute */
    dom.muteBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!audio) return;
      if (audioStarted) {
        audio.muted = !audio.muted;
      } else {
        tryPlay();
      }
      renderMuteButton();
    });

    /* Регулировка громкости */
    dom.volumeSlider.addEventListener('input', function () {
      if (!audio) return;
      audio.volume = clamp((parseInt(this.value, 10) || 0) / 100, 0, 1);
      if (audio.volume > 0 && audio.muted) audio.muted = false;
      renderMuteButton();
    });

    setText('musicTitle', CONFIG.music.title);
    renderMuteButton();
  }

  function renderMuteButton() {
    if (!dom.muteBtn) return;
    var playing = !!audio && audioStarted && !audio.muted && audio.volume > 0;
    dom.muteBtn.innerHTML = playing ? ICONS.sound : ICONS.muted;
    dom.muteBtn.classList.toggle('is-muted', !playing);
    dom.muteBtn.setAttribute('aria-label', playing ? 'Выключить звук' : 'Включить звук');
  }

  /* =====================================================
     12. ИНИЦИАЛИЗАЦИЯ
     ===================================================== */
  function init() {
    /* Кэшируем элементы */
    dom.bg = $('bg');
    dom.logo = $('logo');
    dom.saber = $('saber');
    dom.saberFill = $('saberFill');
    dom.statusText = $('statusText');
    dom.progressPercent = $('progressPercent');
    dom.progressFiles = $('progressFiles');
    dom.playerAvatar = $('playerAvatar');
    dom.playerName = $('playerName');
    dom.rulesList = $('rulesList');
    dom.rulesCounter = $('rulesCounter');
    dom.socials = $('socials');
    dom.musicPlayer = $('musicPlayer');
    dom.muteBtn = $('muteBtn');
    dom.volumeSlider = $('volumeSlider');

    state.domReady = true;

    /* --- Параметры URL (?steamid=%s&map=%m) --- */
    state.steamidFromUrl = getUrlParam('steamid');
    state.urlMap = getUrlParam('map');

    /* Страницу открыли вне GMod — литеральные %s/%m не считаем данными */
    if (state.steamidFromUrl === '%s') state.steamidFromUrl = null;
    if (state.urlMap === '%m') state.urlMap = null;

    /* --- Тема из CONFIG -> CSS-переменные --- */
    var theme = CONFIG.theme || {};
    var cssVarMap = {
      accent: '--c-accent', accentSoft: '--c-accent-soft', gold: '--c-gold',
      bg: '--c-bg', panel: '--c-panel', border: '--c-border',
      text: '--c-text', muted: '--c-muted'
    };
    var root = document.documentElement;
    for (var key in cssVarMap) {
      if (Object.prototype.hasOwnProperty.call(cssVarMap, key) && theme[key]) {
        root.style.setProperty(cssVarMap[key], theme[key]);
      }
    }

    /* --- Логотип (при ошибке — просто прячем) --- */
    if (CONFIG.server && CONFIG.server.logo) {
      dom.logo.src = CONFIG.server.logo;
      dom.logo.onerror = function () { dom.logo.style.display = 'none'; };
    }

    setText('serverTagline', CONFIG.server.tagline);
    setText('playerGreeting', CONFIG.texts.greeting);
    setText('playerName', CONFIG.texts.defaultNickname);
    dom.playerAvatar.src = CONFIG.fallbacks.avatar;
    /* Если заглушки нет — тоже не ломаемся */
    dom.playerAvatar.onerror = function () { dom.playerAvatar.onerror = null; };

    /* --- Запуск модулей --- */
    applyServerInfo();
    initSlideshow();
    initRules();
    initSocials();
    initMusic();
    startStatusRotation();
    startProgressPolling();

    renderStatus();
    renderProgress();
    loadSteamProfile();
  }

  /* Скрипты подключены в конце <body> — DOM уже готов */
  init();
})();
