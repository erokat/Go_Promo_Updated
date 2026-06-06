import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/**
 * Основной скрипт сайта: логика регистрации, отрисовка победителей и админ-панель.
 * Полностью мигрирован с Google Sheets + Google Apps Script на Supabase JS SDK.
 */

document.addEventListener("DOMContentLoaded", async () => {
  const bootStartTime = performance.now();
  // ---- СОСТОЯНИЕ И КОНФИГУРАЦИЯ ----
  let config = {};
  let participants = []; // Локальная база для демо-режима и кэш для админки
  let winners = []; // Локальные победители для демо-режима и кэш для отображения
  let winnersLoaded = false; // Отложенная загрузка участников (оптимизация FCP/LCP)
  let localPrizes = []; // Редактируемые призы во вкладке настроек
  let isAdmin = false;
  let adminToken = null; // Токен авторизации (JWT)
  let adminUserEmail = "admin";
  let currentWinnersCount = 0;
  
  let adminCurrentPage = 1;
  const adminPageSize = 50;
  let adminSearchQuery = "";
  let adminTotalParticipants = 0;
  let displayedParticipants = 0;
  let checkDatePicker = null;
  const PAGE_SIZE = 20;

  // Инициализация Supabase клиента
  let supabase = null;

  // DOM-элементы (Секции)
  const mainView = document.getElementById("mainView");
  const adminView = document.getElementById("adminView");
  const loginModal = document.getElementById("loginModal");
  const setupModal = document.getElementById("setupModal");

  // ДОМ-элементы (Кнопки)
  const adminLoginBtn = document.getElementById("adminLoginBtn");
  const adminLogoutBtn = document.getElementById("adminLogoutBtn");
  const closeModalBtn = document.getElementById("closeModalBtn");
  const closeSetupBtn = document.getElementById("closeSetupBtn");
  const loadMoreBtn = document.getElementById("loadMoreBtn");

  // Формы
  const promoForm = document.getElementById("promoForm");
  const loginForm = document.getElementById("loginForm");

  let useMock = false;

  // Вспомогательная функция загрузки динамических настроек
  async function loadSettings() {
    if (useMock || !supabase) {
      const saved = localStorage.getItem("lottery_settings");
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          if (parsed.startDate) config.startDate = parsed.startDate;
          if (parsed.endDate) config.endDate = parsed.endDate;
          if (parsed.drawDate) config.drawDate = parsed.drawDate;
          if (parsed.registrationEnabled !== undefined) {
            config.registrationEnabled =
              parsed.registrationEnabled === "true" ||
              parsed.registrationEnabled === true;
          }
          if (parsed.winnersPublished !== undefined) {
            config.winnersPublished =
              parsed.winnersPublished === "true" ||
              parsed.winnersPublished === true;
          }
          if (parsed.minPurchaseAmount) config.minPurchaseAmount = parseFloat(parsed.minPurchaseAmount);
          if (parsed.heroTitle) config.heroTitle = parsed.heroTitle;
          if (parsed.heroSubtitle) config.heroSubtitle = parsed.heroSubtitle;
          if (parsed.configHash) config.configHash = parsed.configHash;
        } catch (e) {
          console.error("Ошибка при чтении локальных настроек:", e);
        }
      }
    } else {
      try {
        const { data, error } = await supabase.from("settings").select("key, value");
        if (error) throw error;
        if (data && data.length > 0) {
          const settingsMap = {};
          data.forEach((item) => {
            settingsMap[item.key] = item.value;
          });
          config.startDate = settingsMap.startDate;
          config.endDate = settingsMap.endDate;
          config.drawDate = settingsMap.drawDate;
          config.registrationEnabled = settingsMap.registrationEnabled === "true";
          config.winnersPublished = settingsMap.winnersPublished === "true";
          config.minPurchaseAmount = parseFloat(settingsMap.minPurchaseAmount || "1500");
          config.heroTitle = settingsMap.heroTitle;
          config.heroSubtitle = settingsMap.heroSubtitle;
          config.configHash = settingsMap.configHash || "";
        }
      } catch (err) {
        console.warn("Ошибка при получении настроек из Supabase:", err);
      }
    }

    // Наполняем DOM значениями из конфигурации
    if (config.heroTitle) {
      const titleNode = document.getElementById("hero-title");
      if (titleNode) titleNode.textContent = config.heroTitle;
    }
    if (config.heroSubtitle) {
      const subtitleNode = document.getElementById("hero-prize-text");
      if (subtitleNode) subtitleNode.textContent = config.heroSubtitle;
    }
    if (config.minPurchaseAmount) {
      const m1 = document.getElementById("promoMinAmountText1");
      if (m1) m1.textContent = config.minPurchaseAmount;
      const m2 = document.getElementById("promoMinAmountText2");
      if (m2) m2.textContent = config.minPurchaseAmount;
      const amountInput = document.getElementById("amount");
      if (amountInput) {
        amountInput.setAttribute("min", config.minPurchaseAmount);
        amountInput.setAttribute("placeholder", "Минимум " + config.minPurchaseAmount + " рублей");
      }
    }
  }

  // Загрузка динамического списка призов из базы Supabase
  async function loadPrizes() {
    if (useMock || !supabase) {
      const savedPrizes = localStorage.getItem("lottery_prizes");
      if (savedPrizes) {
        try {
          const parsed = JSON.parse(savedPrizes);
          if (parsed && parsed.length > 0) {
            config.prizes = parsed;
            updateFrontEndPrizesUI(parsed);
            return;
          }
        } catch (e) {
          console.error("Ошибка при чтении локальных призов:", e);
        }
      }
      if (config.prizes && config.prizes.length > 0) {
        updateFrontEndPrizesUI(config.prizes);
      }
    } else {
      try {
        const { data, error } = await supabase
          .from("prizes")
          .select("id, name, link")
          .order("id", { ascending: true });
        
        if (error) throw error;
        if (data && data.length > 0) {
          config.prizes = data;
          updateFrontEndPrizesUI(data);
        } else if (config.prizes && config.prizes.length > 0) {
          updateFrontEndPrizesUI(config.prizes);
        }
      } catch (err) {
        console.warn("Ошибка при получении списка призов:", err);
        if (config.prizes && config.prizes.length > 0) updateFrontEndPrizesUI(config.prizes);
      }
    }
  }



  // ---- КЛИЕНТСКОЕ КЭШИРОВАНИЕ ДЛЯ МГНОВЕННОГО ОТКРЫТИЯ ----
  const CACHE_KEY = "go_promo_site_cache_v1.0.0";
  const CACHE_VERSION = "1.0.0";

  function applyCache() {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (!cached) return false;

      const cache = JSON.parse(cached);
      if (!cache || cache.cache_version !== CACHE_VERSION || !cache.config || !cache.prizes) {
        console.warn("Обнаружен старый/некорректный кэш, сбрасываем...");
        localStorage.removeItem(CACHE_KEY);
        return false;
      }

      // Применяем кэшированный конфиг к глобальной переменной config
      config = { ...config, ...cache.config, prizes: cache.prizes };

      // Мгновенное наполнение DOM из кэша (First Screen)
      if (config.heroTitle) {
        const titleNode = document.getElementById("hero-title");
        if (titleNode) titleNode.textContent = config.heroTitle;
      }
      if (config.heroSubtitle) {
        const subtitleNode = document.getElementById("hero-prize-text");
        if (subtitleNode) subtitleNode.textContent = config.heroSubtitle;
      }
      if (config.minPurchaseAmount) {
        const m1 = document.getElementById("promoMinAmountText1");
        if (m1) m1.textContent = config.minPurchaseAmount;
        const m2 = document.getElementById("promoMinAmountText2");
        if (m2) m2.textContent = config.minPurchaseAmount;
        const amountInput = document.getElementById("amount");
        if (amountInput) {
          amountInput.setAttribute("min", config.minPurchaseAmount);
          amountInput.setAttribute("placeholder", "Минимум " + config.minPurchaseAmount + " рублей");
        }
      }

      // Мгновенно рендерим призы
      updateFrontEndPrizesUI(config.prizes);

      // Обновляем даты, календарь и таймер обратного отсчета
      updateDynamicDateTexts();
      initDatePicker();
      checkRegistrationPeriod();
      updateCountdown();

      console.log("Первый экран полностью и мгновенно восстановлен из локального кэша!");
      return true;
    } catch (err) {
      console.warn("Ошибка восстановления кэша из localStorage:", err);
      try {
        localStorage.removeItem(CACHE_KEY);
      } catch (_) {}
      return false;
    }
  }

  // Быстрое синхронное хэширование строки (алгоритм FNV-1a HEX)
  function generateDataHash(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  // Расчет хэша конфигурации первого экрана
  function calculateConfigHash(drawDate, heroTitle, heroSubtitle, minAmount, prizes) {
    const cleanPrizes = (prizes || []).slice().sort((a, b) => (a.id || 0) - (b.id || 0)).map(p => ({
      id: p.id || 0,
      name: p.name || "",
      link: p.link || ""
    }));
    
    const rawString = JSON.stringify({
      drawDate: drawDate || "",
      heroTitle: heroTitle || "",
      heroSubtitle: heroSubtitle || "",
      minAmount: String(minAmount || "1500"),
      prizes: cleanPrizes
    });

    return generateDataHash(rawString);
  }

  function saveToCache(customHash = null) {
    try {
      const activeHash = customHash || calculateConfigHash(
        config.drawDate,
        config.heroTitle,
        config.heroSubtitle,
        config.minPurchaseAmount,
        config.prizes
      );

      config.configHash = activeHash;

      const cacheData = {
        cache_version: CACHE_VERSION,
        lastUpdated: Date.now(),
        config: {
          startDate: config.startDate,
          endDate: config.endDate,
          drawDate: config.drawDate,
          registrationEnabled: config.registrationEnabled !== false,
          winnersPublished: config.winnersPublished === true,
          minPurchaseAmount: config.minPurchaseAmount || 1500,
          heroTitle: config.heroTitle || "",
          heroSubtitle: config.heroSubtitle || "",
          configHash: activeHash
        },
        prizes: config.prizes || []
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(cacheData));
      console.log(`%c[Cache System] Локальный кэш успешно обновлен. Хэш: ${activeHash}`, "color: #00bcd4; font-weight: bold;");
    } catch (err) {
      console.warn("Ошибка записи кэша в localStorage:", err);
    }
  }

  // Флаг, предотвращающий повторные или преждевременные скрытия прелоадера
  let isPreloaderHidden = false;
  let isHidePending = false;

  // Считываем локальный кэш заранее для оценки версии
  let hasLocalCache = false;
  let localHash = "";

  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const cache = JSON.parse(cached);
      if (cache && cache.cache_version === CACHE_VERSION && cache.config && cache.prizes) {
        localHash = cache.config.configHash || "";
        hasLocalCache = true;
      }
    }
  } catch (e) {
    console.warn("Ошибка предварительного разбора локального кэша:", e);
  }

  // Скрываем прелоадер
  function hidePreloader(source = "normal") {
    if (isPreloaderHidden || isHidePending) return;

    const elapsed = performance.now() - bootStartTime;
    if (elapsed < 1000) {
      isHidePending = true;
      setTimeout(() => {
        isHidePending = false;
        hidePreloader(source);
      }, 1000 - elapsed);
      return;
    }

    isPreloaderHidden = true;

    const duration = (performance.now() - bootStartTime).toFixed(1);
    const preloader = document.getElementById("preloader");
    if (preloader) {
      console.log(`%c[Preloader Diagnostics]
- Источник скрытия: ${source}
- Время до полного скрытия preloader: ${duration}мс`, "color: #06a658; font-weight: bold;");
      preloader.classList.add("fade-out");
      setTimeout(() => {
        preloader.classList.add("hidden");
      }, 500);
    }
  }

  // ---- ЗАЩИТА И ЛОГИКА ЗАПУСКА ----
  let connectionAttempts = 0;
  let isInitializing = false;
  let statusUpdateTimer1 = null;
  let statusUpdateTimer2 = null;
  let retryTimer = null;
  let initAbortController = null;
  const RETRY_INTERVALS = [0, 2000, 5000, 10000, 20000, 30000];

  async function initializeApp() {
    if (isInitializing) return;
    
    // Очистка предыдущих процессов
    if (initAbortController) initAbortController.abort('New initialization');
    clearTimeout(statusUpdateTimer1);
    clearTimeout(statusUpdateTimer2);
    clearTimeout(retryTimer);
    
    initAbortController = new AbortController();
    isInitializing = true;
    isPreloaderHidden = false;

    // Сбрасываем статус
    const statusMsg = document.getElementById("loadingStatus");
    if (statusMsg) statusMsg.textContent = "";

    // Таймеры для сообщений
    statusUpdateTimer1 = setTimeout(() => {
      if (statusMsg) statusMsg.textContent = "Подключаемся к серверу и проверяем актуальность данных...";
    }, 10000);

    statusUpdateTimer2 = setTimeout(() => {
      if (statusMsg) statusMsg.textContent = "Подключение занимает больше времени, чем обычно. Проверьте подключение к интернету или попробуйте открыть сайт позже.";
    }, 30000);

    try {
      console.log(`[Loader] Попытка подключения №${connectionAttempts + 1}`);

      // 1. Загрузка статического конфига
      const configRes = await fetch("config.json?v=" + Date.now(), { signal: initAbortController.signal });
      if (!configRes.ok) throw new Error(`Ошибка загрузки конфига: ${configRes.status}`);
      
      const serverConfig = await configRes.json();
      config = { ...config, ...serverConfig };
      
      useMock = !config.supabaseUrl || config.supabaseUrl === "https://your-project-id.supabase.co";

      if (!useMock) {
        supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
      }

      // 2. Получение и сравнение хеша
      let serverHash = null;

      if (!useMock && supabase) {
        // Запрос с таймаутом
        const fetchHashPromise = supabase
          .from("settings")
          .select("value")
          .eq("key", "configHash")
          .maybeSingle();

        // Простой таймаут для supabase
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Hash check timeout')), 5000));
        
        const { data, error } = await Promise.race([
          fetchHashPromise.then(res => ({ data: res.data, error: res.error })),
          timeoutPromise
        ]);
        
        if (error) throw error;
        serverHash = data ? data.value : null;
      }

      // Очистка таймеров
      clearTimeout(statusUpdateTimer1);
      clearTimeout(statusUpdateTimer2);

      // 3. Логика запуска
      if (hasLocalCache && serverHash && serverHash === localHash) {
        console.log("%c[Cache System] Хэши совпадают. Быстрый запуск.", "color: #06a658; font-weight: bold;");
        applyCache();
        hidePreloader("cache_hash_match");
        connectionAttempts = 0;
      } 
      else {
        console.log("%c[Cache System] Требуется полная загрузка.", "color: #ff9f43; font-weight: bold;");
        await fullLoad(serverHash);
        connectionAttempts = 0;
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log("[Loader] Инициализация была прервана.");
        return;
      }
      
      clearTimeout(statusUpdateTimer1);
      clearTimeout(statusUpdateTimer2);
      
      connectionAttempts++;
      const delayIndex = Math.min(connectionAttempts, RETRY_INTERVALS.length - 1);
      const nextRetry = RETRY_INTERVALS[delayIndex];
      
      console.warn(`[Loader] Ошибка (попытка ${connectionAttempts}), след. через ${nextRetry}мс:`, err.message);
      
      retryTimer = setTimeout(initializeApp, nextRetry);
    } finally {
      isInitializing = false;
    }
  }

  // События сети
  window.addEventListener("online", () => initializeApp());

  // Вспомогательная функция полной загрузки
  async function fullLoad(forcedHash = null) {
      await loadSettings();
      await loadPrizes();
      
      const newHash = forcedHash || calculateConfigHash(config.drawDate, config.heroTitle, config.heroSubtitle, config.minPurchaseAmount, config.prizes);
      config.configHash = newHash;
      
      updateDynamicDateTexts();
      initDatePicker();
      checkRegistrationPeriod();
      saveToCache(newHash);
      hidePreloader("network_success");
  }

  // Сразу запускаем
  initializeApp();

  // Определение даты розыгрыша (миллисекунды)
  function getTargetDrawTime() {
    let result;
    if (config.drawDate) {
      const d = new Date(config.drawDate);
      if (!isNaN(d.getTime())) {
        result = d.getTime();
        console.log(`getTargetDrawTime() -> Из config.drawDate (${config.drawDate}):`, result, `(${new Date(result).toISOString()})`);
        return result;
      }
    }
    result = new Date("2026-07-02T12:00:00").getTime();
    console.log("getTargetDrawTime() -> Значение по умолчанию (2026-07-02T12:00:00):", result, `(${new Date(result).toISOString()})`);
    return result;
  }

  // Форматтер дат
  function formatDateRu(date, includeYear) {
    const formatted = date.toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      ...(includeYear ? { year: "numeric" } : {})
    });
    if (includeYear) {
      return formatted.replace(/\s*г\.?$/, "") + " года";
    }
    return formatted;
  }

  // Проверка периода регистрации
  function checkRegistrationPeriod() {
    const regAlert = document.getElementById("registrationStatusAlert");
    const submitBtn = document.getElementById("submitBtn");
    const promoForm = document.getElementById("promoForm");
    if (!regAlert || !submitBtn || !promoForm) return false;

    // Сначала смотрим принудительный флаг в настройках
    if (config.registrationEnabled === false) {
      regAlert.style.display = "block";
      regAlert.textContent = "Регистрация временно приостановлена администратором.";
      submitBtn.disabled = true;
      submitBtn.textContent = "РЕГИСТРАЦИЯ ПРИОСТАНОВЛЕНА";
      promoForm.classList.add("registration-disabled");
      return false;
    }

    const now = new Date();
    const start = config.startDate ? new Date(config.startDate) : new Date("2026-06-01T00:00:00");
    const end = config.endDate ? new Date(config.endDate) : new Date("2026-06-30T23:59:00");

    if (now < start) {
      regAlert.style.display = "block";
      const dateStr = formatDateRu(start, true);
      const timeStr = start.toLocaleTimeString("ru-RU", { hour: '2-digit', minute: '2-digit' });
      regAlert.textContent = `Регистрация чеков начнётся ${dateStr} в ${timeStr}.`;
      submitBtn.disabled = true;
      submitBtn.textContent = "РЕГИСТРАЦИЯ ЕЩЁ НЕ НАЧАЛАСЬ";
      promoForm.classList.add("registration-disabled");
      return false;
    }

    if (now > end) {
      regAlert.style.display = "block";
      const dateStr = formatDateRu(end, true);
      regAlert.textContent = `Период регистрации чеков завершен ${dateStr}`;
      submitBtn.disabled = true;
      submitBtn.textContent = "РЕГИСТРАЦИЯ ЗАВЕРШЕНА";
      promoForm.classList.add("registration-disabled");
      return false;
    }

    // Регистрация открыта
    regAlert.style.display = "none";
    submitBtn.disabled = false;
    submitBtn.textContent = "ЗАРЕГИСТРИРОВАТЬ ЧЕК";
    promoForm.classList.remove("registration-disabled");
    return true;
  }

  // Обновление текстов дат на странице
  function updateDynamicDateTexts() {
    const regPeriodText = document.getElementById("registrationPeriodText");
    const drawTimeText = document.getElementById("drawDateText");

    if (regPeriodText) {
      const start = config.startDate ? new Date(config.startDate) : null;
      const end = config.endDate ? new Date(config.endDate) : null;
      
      if (start && !isNaN(start.getTime()) && end && !isNaN(end.getTime())) {
        const startYear = start.getFullYear();
        const endYear = end.getFullYear();
        
        if (startYear === endYear) {
          regPeriodText.textContent = `с ${formatDateRu(start, false)} по ${formatDateRu(end, true)}`;
        } else {
          regPeriodText.textContent = `с ${formatDateRu(start, true)} по ${formatDateRu(end, true)}`;
        }
      } else if (start && !isNaN(start.getTime())) {
        regPeriodText.textContent = `с ${formatDateRu(start, true)}`;
      } else if (end && !isNaN(end.getTime())) {
        regPeriodText.textContent = `до ${formatDateRu(end, true)}`;
      } else {
        regPeriodText.textContent = "—";
      }
    }

    if (drawTimeText && config.drawDate) {
      const d = new Date(config.drawDate);
      if (!isNaN(d.getTime())) {
        drawTimeText.textContent = formatDateRu(d, true);
      }
    }
  }

  // Инициализация календаря flatpickr
  function initDatePicker() {
    const dateInput = document.getElementById("checkDate");
    if (!dateInput) return;

    if (checkDatePicker) {
      checkDatePicker.destroy();
    }

    const start = config.startDate ? new Date(config.startDate) : new Date("2026-06-01T00:00:00");
    const end = config.endDate ? new Date(config.endDate) : new Date("2026-06-30T23:59:00");

    checkDatePicker = flatpickr(dateInput, {
      locale: "ru",
      dateFormat: "Y-m-d",
      minDate: start,
      maxDate: end,
      disableMobile: true,
    });
  }

  // Счётчик обратного отсчёта до розыгрыша
  let countdownTimer = null;
  function updateCountdown() {
    const target = getTargetDrawTime();
    const now = new Date().getTime();
    const diff = target - now;

    console.log(`updateCountdown() -> target: ${target}, now: ${now}, diff: ${diff}`);

    const timerContainer = document.getElementById("countdown");
    const resultSection = document.getElementById("countdownMessage");

    if (diff <= 0) {
      const titleEl = document.getElementById("countdownTitle");
      if (titleEl) titleEl.textContent = "Розыгрыш завершен:";

      const daysEl = document.getElementById("cdDays");
      const hoursEl = document.getElementById("cdHours");
      const minutesEl = document.getElementById("cdMinutes");
      const secondsEl = document.getElementById("cdSeconds");

      if (daysEl) daysEl.textContent = "00";
      if (hoursEl) hoursEl.textContent = "00";
      if (minutesEl) minutesEl.textContent = "00";
      if (secondsEl) secondsEl.textContent = "00";

      if (timerContainer) {
        timerContainer.classList.remove("hidden");
        timerContainer.classList.add("timer-ended");
      }
      if (resultSection) resultSection.classList.remove("hidden");

      if (countdownTimer) clearInterval(countdownTimer);
      return;
    }

    if (timerContainer) timerContainer.classList.remove("hidden");
    if (resultSection) resultSection.classList.add("hidden");

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diff % (1000 * 60)) / 1000);

    const pad = (num) => String(num).padStart(2, "0");

    const daysEl = document.getElementById("cdDays");
    const hoursEl = document.getElementById("cdHours");
    const minutesEl = document.getElementById("cdMinutes");
    const secondsEl = document.getElementById("cdSeconds");

    if (daysEl) daysEl.textContent = pad(days);
    if (hoursEl) hoursEl.textContent = pad(hours);
    if (minutesEl) minutesEl.textContent = pad(minutes);
    if (secondsEl) secondsEl.textContent = pad(seconds);
  }

  updateCountdown();
  countdownTimer = setInterval(updateCountdown, 1000);

  // ---- ОБРАБОТЧИКИ СОБЫТИЙ ----

  // Открытие модальных окон
  adminLoginBtn.addEventListener("click", () =>
    loginModal.classList.remove("hidden"),
  );
  closeModalBtn.addEventListener("click", () =>
    loginModal.classList.add("hidden"),
  );
  closeSetupBtn.addEventListener("click", () =>
    setupModal.classList.add("hidden"),
  );

  // ---- НАСТРОЙКА iOS TIME PICKER ТОЛЬКО ДЛЯ SAFARI (iOS/iPadOS) ----
  {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const checkTimeOnlyInput = document.getElementById("checkTimeOnly");

    if (checkTimeOnlyInput && isIOS) {
      checkTimeOnlyInput.type = "text";
      checkTimeOnlyInput.readOnly = true;
      checkTimeOnlyInput.setAttribute("inputmode", "none");
      checkTimeOnlyInput.placeholder = "ЧЧ:ММ:СС";
      checkTimeOnlyInput.style.cursor = "pointer";

      const handleTrigger = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openIosTimePicker();
      };

      checkTimeOnlyInput.addEventListener("click", handleTrigger);
      checkTimeOnlyInput.addEventListener("focus", handleTrigger);
      checkTimeOnlyInput.addEventListener("touchstart", handleTrigger, { passive: false });
    }

    function openIosTimePicker() {
      const overlay = document.getElementById("iosTimePickerOverlay");
      if (!overlay) return;
      
      overlay.classList.add("active");

      let currentVal = checkTimeOnlyInput ? checkTimeOnlyInput.value.trim() : "";
      let h = "12", m = "00", s = "00";
      if (currentVal) {
        const parts = currentVal.split(":");
        if (parts.length === 3) {
          h = parts[0];
          m = parts[1];
          s = parts[2];
        } else if (parts.length === 2) {
          h = parts[0];
          m = parts[1];
          s = "00";
        }
      } else {
        const now = new Date();
        h = String(now.getHours()).padStart(2, "0");
        m = String(now.getMinutes()).padStart(2, "0");
        s = String(now.getSeconds()).padStart(2, "0");
      }

      const hoursWheel = document.getElementById("iosPickerWheelHours");
      const minutesWheel = document.getElementById("iosPickerWheelMinutes");
      const secondsWheel = document.getElementById("iosPickerWheelSeconds");

      if (hoursWheel && hoursWheel.children.length === 0) {
        const generateItems = (wheel, min, max) => {
          wheel.innerHTML = "";
          for (let i = min; i <= max; i++) {
            const valStr = String(i).padStart(2, "0");
            const item = document.createElement("div");
            item.className = "ios-time-picker-item";
            item.setAttribute("data-value", valStr);
            item.textContent = valStr;

            item.addEventListener("click", () => {
              const index = i - min;
              wheel.scrollTo({
                top: index * 40,
                behavior: "smooth"
              });
            });

            wheel.appendChild(item);
          }
        };

        generateItems(hoursWheel, 0, 23);
        generateItems(minutesWheel, 0, 59);
        generateItems(secondsWheel, 0, 59);

        const attachScrollListener = (wheel) => {
          wheel.addEventListener("scroll", () => {
            const scrollTop = wheel.scrollTop;
            const items = wheel.querySelectorAll(".ios-time-picker-item");
            const index = Math.min(Math.max(Math.round(scrollTop / 40), 0), items.length - 1);

            items.forEach((item, idx) => {
              if (idx === index) {
                item.classList.add("selected");
              } else {
                item.classList.remove("selected");
              }
            });
          });
        };

        attachScrollListener(hoursWheel);
        attachScrollListener(minutesWheel);
        attachScrollListener(secondsWheel);
      }

      const scrollToVal = (wheel, value) => {
        if (!wheel) return;
        const items = Array.from(wheel.querySelectorAll(".ios-time-picker-item"));
        const targetIndex = items.findIndex(item => item.getAttribute("data-value") === String(value).padStart(2, "0"));
        if (targetIndex !== -1) {
          wheel.scrollTop = targetIndex * 40;
          items.forEach((item, idx) => {
            if (idx === targetIndex) {
              item.classList.add("selected");
            } else {
              item.classList.remove("selected");
            }
          });
        }
      };

      setTimeout(() => {
        scrollToVal(hoursWheel, h);
        scrollToVal(minutesWheel, m);
        scrollToVal(secondsWheel, s);
      }, 50);
    }

    const cancelBtn = document.getElementById("iosTimePickerCancel");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        document.getElementById("iosTimePickerOverlay").classList.remove("active");
      });
    }

    const overlayPicker = document.getElementById("iosTimePickerOverlay");
    if (overlayPicker) {
      overlayPicker.addEventListener("click", (e) => {
        if (e.target === overlayPicker) {
          overlayPicker.classList.remove("active");
        }
      });
    }

    const doneBtn = document.getElementById("iosTimePickerDone");
    if (doneBtn) {
      doneBtn.addEventListener("click", () => {
        const hoursWheel = document.getElementById("iosPickerWheelHours");
        const minutesWheel = document.getElementById("iosPickerWheelMinutes");
        const secondsWheel = document.getElementById("iosPickerWheelSeconds");

        const getSelectedVal = (wheel) => {
          if (!wheel) return "00";
          const items = wheel.querySelectorAll(".ios-time-picker-item");
          const index = Math.min(Math.max(Math.round(wheel.scrollTop / 40), 0), items.length - 1);
          return items[index] ? items[index].getAttribute("data-value") : "00";
        };

        const finalH = getSelectedVal(hoursWheel);
        const finalM = getSelectedVal(minutesWheel);
        const finalS = getSelectedVal(secondsWheel);

        const finalTimeStr = `${finalH}:${finalM}:${finalS}`;

        if (checkTimeOnlyInput) {
          checkTimeOnlyInput.value = finalTimeStr;
          checkTimeOnlyInput.dispatchEvent(new Event("input", { bubbles: true }));
          checkTimeOnlyInput.dispatchEvent(new Event("change", { bubbles: true }));
        }

        document.getElementById("iosTimePickerOverlay").classList.remove("active");
      });
    }
  }

  // Авторизация администратора
  const togglePasswordBtn = document.getElementById("togglePasswordBtn");
  const adminPassInput = document.getElementById("adminPass");
  const eyeIconVisible = document.getElementById("eyeIconVisible");
  const eyeIconHidden = document.getElementById("eyeIconHidden");

  if (togglePasswordBtn) {
    togglePasswordBtn.addEventListener("click", () => {
      if (adminPassInput.type === "password") {
        adminPassInput.type = "text";
        eyeIconVisible.style.display = "block";
        eyeIconHidden.style.display = "none";
        togglePasswordBtn.style.color = "var(--text-muted)";
      } else {
        adminPassInput.type = "password";
        eyeIconVisible.style.display = "none";
        eyeIconHidden.style.display = "block";
        togglePasswordBtn.style.color = "var(--primary)";
      }
    });
  }

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const user = document.getElementById("adminUser").value.trim();
    const pass = document.getElementById("adminPass").value.trim();
    const msg = document.getElementById("loginMessage");
    const btn = loginForm.querySelector('button[type="submit"]');

    msg.className = "message";
    btn.disabled = true;
    btn.textContent = "Вход...";

    try {
      if (useMock || !supabase) {
        if (user === "admin" && pass === "admin") {
          proceedLogin();
        } else {
          showLoginError();
        }
      } else {
        // Преобразуем пользовательский Логин в Email форму для бесшовной интеграции с Supabase Auth
        const email = `${user.toLowerCase().replace(/[^a-z0-9_.-]/g, "")}@go-promo.local`;
        
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email,
          password: pass,
        });

        if (error) {
          throw new Error("Неверный логин или пароль");
        } else {
          adminToken = data.session.access_token;
          adminUserEmail = (data.user && data.user.email) || "admin";
          proceedLogin();
        }
      }
    } catch (err) {
      showLoginError(err.message || "Ошибка связи с сервером");
      console.warn("Login info (expected on bad/unregistered credentials):", err);
    } finally {
      btn.disabled = false;
      btn.textContent = "Вход";
    }

    function showLoginError(text = "Неверный логин или пароль") {
      msg.textContent = text;
      msg.className = "message error";
    }
  });

  function proceedLogin(silent = false) {
    isAdmin = true;
    loginModal.classList.add("hidden");
    mainView.classList.add("hidden");
    adminView.classList.remove("hidden");
    adminLoginBtn.classList.add("hidden");
    adminLogoutBtn.classList.remove("hidden");
    loginForm.reset();
    
    const msg = document.getElementById("loginMessage");
    if (msg) msg.className = "message";

    // Загружаем данные админки
    loadAdminData();
  }

  // Выход из админки
  adminLogoutBtn.addEventListener("click", async () => {
    isAdmin = false;
    adminToken = null;
    adminView.classList.add("hidden");
    mainView.classList.remove("hidden");
    adminLogoutBtn.classList.add("hidden");
    adminLoginBtn.classList.remove("hidden");

    if (supabase) {
      await supabase.auth.signOut();
    }

    // Обновляем список победителей на главной
    loadWinners(true);
  });

  // Инициализация и авто-коррекция ввода номера телефона (8 цифр)
  const phoneInput = document.getElementById("phone");
  if (phoneInput) {
    phoneInput.addEventListener("input", () => {
      let value = phoneInput.value;
      let digits = value.replace(/\D/g, "");
      if (digits.startsWith("373")) {
        digits = digits.substring(3);
      }
      if (digits.length > 8) {
        digits = digits.substring(0, 8);
      }
      phoneInput.value = digits;
    });
  }

  function normalizeTime(timeStr) {
    let cleaned = timeStr.trim();
    const strictRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;
    if (!strictRegex.test(cleaned)) {
      return null;
    }
    return cleaned;
  }

  if (promoForm) {
    promoForm.addEventListener("reset", () => {
      if (checkDatePicker) {
        checkDatePicker.clear();
      }
      const timeOnlyInput = document.getElementById("checkTimeOnly");
      if (timeOnlyInput) {
        timeOnlyInput.value = "";
      }
    });
  }

  // Регистрация чека
  promoForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("submitBtn");
    const msg = document.getElementById("formMessage");

    if (!checkRegistrationPeriod()) {
      return;
    }

    const receipt = document.getElementById("receipt").value.trim();
    const name = document.getElementById("name").value.trim();
    const phoneInput = document.getElementById("phone").value.trim();
    const checkDateVal = document.getElementById("checkDate")
      ? document.getElementById("checkDate").value.trim()
      : "";
    const checkTimeOnlyVal = document.getElementById("checkTimeOnly")
      ? document.getElementById("checkTimeOnly").value.trim()
      : "";
    const amountVal = parseFloat(document.getElementById("amount").value);

    // Ограничение длины имени
    if (name.length < 2 || name.length > 100) {
      msg.textContent = "ФИО должно быть длиной от 2 до 100 символов.";
      msg.className = "message error";
      return;
    }

    // Фискальный код: начало 000081 и длина 12 цифр
    if (!receipt.startsWith("000081") || !/^\d{12}$/.test(receipt)) {
      msg.textContent = "Неправильный код чека";
      msg.className = "message error";
      return;
    }

    // Проверка суммы покупки
    const requiredMinAmount = config.minPurchaseAmount || 1500;
    
    if (isNaN(amountVal) || amountVal < requiredMinAmount) {
      msg.textContent =
        `Минимальная сумма покупки для участия в акции — ${requiredMinAmount} рублей.`;
      msg.className = "message error";
      return;
    }

    // Проверка даты чека
    if (!checkDateVal) {
      msg.textContent =
        "Пожалуйста, выберите дату проведения покупки в календаре.";
      msg.className = "message error";
      return;
    }
    if (!checkTimeOnlyVal) {
      msg.textContent = "Пожалуйста, введите время формирования чека вручную.";
      msg.className = "message error";
      return;
    }

    const normalizedTime = normalizeTime(checkTimeOnlyVal);
    if (!normalizedTime) {
      msg.textContent = "Неверное время. Формат должен быть ЧЧ:ММ:СС (включая секунды).";
      msg.className = "message error";
      return;
    }

    const checkTime = `${checkDateVal}T${normalizedTime}`;
    const checkDate = new Date(checkTime);
    
    const minStart = config.startDate ? new Date(config.startDate) : new Date(0);
    const maxEnd = config.endDate ? new Date(config.endDate) : new Date(8640000000000000);
    
    if (
      isNaN(checkDate.getTime()) ||
      checkDate < minStart ||
      checkDate > maxEnd
    ) {
      msg.textContent = "Разрешены только чеки в период акции.";
      msg.className = "message error";
      return;
    }

    let normalizedPhone = phoneInput.replace(/\D/g, "");
    if (normalizedPhone.startsWith("373")) {
      normalizedPhone = normalizedPhone.substring(3);
    }

    if (!/^\d{8}$/.test(normalizedPhone)) {
      msg.textContent =
        "Пожалуйста, введите корректный номер телефона (должен состоять ровно из 8 цифр, например, 77712345).";
      msg.className = "message error";
      return;
    }

    msg.className = "message";
    btn.disabled = true;
    btn.textContent = "Отправка...";

    try {
      if (useMock || !supabase) {
        // ДЕМО-РЕЖИМ
        await new Promise((r) => setTimeout(r, 600));

        // Проверка уникальности чека в Mock базе
        if (participants.find((p) => p.receipt === receipt)) {
          throw new Error("Такой номер чека уже зарегистрирован");
        }

        participants.unshift({
          receipt,
          name,
          phone: normalizedPhone,
          checkTime,
          amount: amountVal,
          date: new Date().toISOString(),
          won: false,
        });

        msg.textContent = "Успех! Чек успешно зарегистрирован (демо-режим).";
        msg.className = "message success";
        promoForm.reset();
      } else {
        // БОЕВОЙ РЕЖИМ (Supabase)
        // Вставка с автоматической серверной валидацией через SQL TRIGGER
        const { error: insertError } = await supabase
          .from("participants")
          .insert({
            receipt,
            name,
            phone: normalizedPhone,
            check_time: checkDate.toISOString(),
            amount: amountVal,
            date: new Date().toISOString(),
            won: false
          });

        if (insertError) {
          // Вытаскиваем читабельное сообщение об ошибке, сгенерированное триггером PostgreSQL
          let friendlyMessage = insertError.message;
          if (insertError.details) friendlyMessage += " " + insertError.details;
          if (friendlyMessage.includes("duplicate key")) {
            friendlyMessage = "Такой номер чека уже зарегистрирован";
          }
          throw new Error(friendlyMessage);
        }

        msg.textContent = "Чек успешно зарегистрирован! Желаем удачи.";
        msg.className = "message success";
        promoForm.reset();
      }
    } catch (err) {
      msg.textContent =
        err.message || "Произошла ошибка регистрации. Попробуйте позже.";
      msg.className = "message error";
    } finally {
      btn.disabled = false;
      btn.textContent = "Зарегистрировать чек";
    }
  });

  // ---- ФУНКЦИИ ФРОНТЕНДА ----

  function checkWinnersVisibility() {
    const timeIsUp = new Date().getTime() > getTargetDrawTime();
    const hasWinners = currentWinnersCount > 0;

    const winnersSection = document.querySelector(".winners-section");
    if (winnersSection) {
      if (timeIsUp || hasWinners) {
        winnersSection.style.display = "block";
      } else {
        winnersSection.style.display = "none";
      }
    }
  }

  function getDynamicPrizes() {
    if (config && config.prizes && config.prizes.length > 0) {
      return config.prizes.map((p, i) => `${i + 1}. ${p.name}`);
    }
    const cards = document.querySelectorAll(".prizes-grid .prize-card");
    if (cards.length > 0) {
      return Array.from(cards).map((card, i) => {
        const textNode = card.querySelector(".prize-text");
        const name = textNode ? textNode.textContent.trim().replace(/\s+/g, " ") : "";
        return `${i + 1}. ${name}`;
      });
    }
    return [
      "1. Смартфон Redmi Note 15 Pro Plus 5G 8/256",
      "2. Матрас туристический Youpin One Night Automatic Inflatable Leisure Bed PS1",
      "3. Видеорегистратор HOCO DV8 with rear camera",
      "4. Наушники Baseus Bluetooth BH1 NC Black",
      "5. Часы Xiaomi Redmi Watch 5 Active",
      "6. Колонка Blackview Bluetooth Aurabass 3 16W",
      "7. Весы Xiaomi Mi Body Composition Scale S400",
      "8. Наушники Xiaomi Bluetooth Redmi Buds 6 Play",
      "9. Ночник Cute Panda",
      "10. Наушники Xiaomi Headphones Basic",
    ];
  }

  function resolvePrizeName(prizeValue, winnerObj) {
    if (!prizeValue) return "";
    
    // Получаем текущие динамические призы из конфигурации
    const prizesList = getDynamicPrizes();
    
    // Пытаемся найти по числовому ID
    const num = parseInt(prizeValue, 10);
    if (!isNaN(num) && num >= 1 && num <= prizesList.length) {
      return prizesList[num - 1]; // Возвращаем актуальное название приза
    }
    
    // Иначе пытаемся найти по названию
    const str = String(prizeValue).trim();
    const matched = prizesList.find(p => p === str || p.replace(/^\d+\.\s+/, "") === str);
    if (matched) return matched;
    
    return str;
  }

  function escapeHTML(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatDate(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d
      .toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
      .replace(",", "");
  }

  const cleanR = (r) => {
    if (r === undefined || r === null) return "";
    return String(r).trim().replace(/^'/, "");
  };

  async function loadWinners(force = false) {
    const list = document.getElementById("winnersList");
    if (!list) return;

    // Избегаем повторной загрузки, если данные уже загружены и принудительный флаг не поднят
    if (winnersLoaded && !force) return;

    // Сразу ставим флаг, чтобы не дублировать параллельные запросы
    winnersLoaded = true;

    // Включаем скелетоны загрузки
    list.classList.add("winners-fade-in");
    list.classList.remove("loaded");
    list.innerHTML = `
      <div class="skeleton-card shimmer">
        <div class="skeleton-header"></div>
        <div class="skeleton-name"></div>
        <div class="skeleton-receipt"></div>
      </div>
      <div class="skeleton-card shimmer">
        <div class="skeleton-header"></div>
        <div class="skeleton-name"></div>
        <div class="skeleton-receipt"></div>
      </div>
      <div class="skeleton-card shimmer">
        <div class="skeleton-header"></div>
        <div class="skeleton-name"></div>
        <div class="skeleton-receipt"></div>
      </div>
    `;

    try {
      let data = [];
      if (useMock || !supabase) {
        // Симулируем небольшую задержку сети в демо-режиме, чтобы показать shimmer
        if (!force) {
          await new Promise(r => setTimeout(r, 600));
        }
        data = winners;
      } else {
        // Запрос победителей из Supabase. 
        // Если победители не опубликованы, RLS заблокирует для публики (но админа авторизует!)
        let selectFields = "receipt, name, prize, prize_name, date";
        if (isAdmin) selectFields += ", phone";

        const { data: selectWinners, error } = await supabase
          .from("winners")
          .select(selectFields)
          .order("prize", { ascending: true });

        if (error) {
          // Если RLS блокирует доступ, это нормальное поведение (список не опубликован)
          console.log("Победители скрыты настройкой публикации или пусты (RLS применил ограничения).", error.message);
          data = [];
        } else {
          data = selectWinners || [];
        }
      }

      winners = data;
      currentWinnersCount = data.length;
      checkWinnersVisibility();

      list.innerHTML = "";
      if (data.length === 0) {
        list.innerHTML =
          '<p style="grid-column: 1/-1; text-align:center; color:#777; font-size: 1.1rem;">Итоги подводятся, ожидайте публикации списков!</p>';
        list.classList.add("loaded");
        return;
      }

      const sortedWinners = [...data].sort((a, b) => {
        const getPrizeNumHelper = (val) => {
          if (val === undefined || val === null) return 999;
          const match = String(val).match(/\d+/);
          return match ? parseInt(match[0], 10) : parseInt(val, 10) || 999;
        };
        const pA = getPrizeNumHelper(a.prize);
        const pB = getPrizeNumHelper(b.prize);
        return pA - pB;
      });

      sortedWinners.forEach((w, idx) => {
        const card = document.createElement("div");
        card.className = "winner-card";
        const receiptFull = String(w.receipt);

        card.innerHTML = `
            <h4 style="margin-bottom: 8px; font-family: var(--font-heading); font-size: 1.25rem;">🎉 Победитель №${w.prize || idx + 1}</h4>
            <div class="winner-name" style="font-size: 1.15rem; font-weight: 600; color: var(--primary, #06a658); margin-bottom: 10px; font-family: var(--font-heading);">${escapeHTML(w.name || "Участник")}</div>
            <div class="receipt" style="font-family: monospace; font-size: 1.1rem; background: #121212; padding: 4px 10px; border-radius: 4px; color: var(--text-color); margin-bottom: 15px; display: inline-block; border: 1px solid var(--border-color);">${escapeHTML(receiptFull)}</div>
            ${w.prize ? `<div class="prize-info" style="color: var(--primary, #06a658); font-weight: bold; margin-top: 5px; font-size: 0.95rem;">${escapeHTML(resolvePrizeName(w.prize, w))}</div>` : ""}
            ${isAdmin ? `<div class="date" style="margin-top: 12px; font-size: 0.8rem; opacity: 0.7;"><small>Дата розыгрыша: ${escapeHTML(formatDate(w.date))}</small></div>` : ""}
        `;
        list.appendChild(card);
      });

      // Плавное анимированное появление
      setTimeout(() => {
        list.classList.add("loaded");
      }, 50);

    } catch (err) {
      console.error("Ошибка отображения победителей:", err);
      list.innerHTML =
        '<p class="error" style="grid-column: 1/-1;">Ошибка загрузки списка победителей.</p>';
      list.classList.add("loaded");
    }
  }

  // ---- ФУНКЦИИ ПАНЕЛИ АДМИНИСТРАТОРА ----

  async function loadAdminData(page = 1, searchQuery = "") {
    adminCurrentPage = page;
    adminSearchQuery = searchQuery;

    const tbody = document.getElementById("participantsBody");
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; padding: 40px; color: var(--text-muted, #888);">
            <div class="loader-spinner" style="display: inline-block; width: 22px; height: 22px; border: 2.5px solid #333; border-top-color: var(--primary, #06a658); border-radius: 50%; animation: spin 1s linear infinite; margin-right: 12px; vertical-align: middle;"></div>
            Загрузка участников...
          </td>
        </tr>
      `;
    }

    if (useMock || !supabase) {
      await loadWinners(true);
      const mockFiltered = participants.filter((p) =>
        String(p.receipt || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(p.name || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(p.phone || "").toLowerCase().includes(searchQuery.toLowerCase())
      );
      adminTotalParticipants = mockFiltered.length;
      
      const startIdx = (page - 1) * adminPageSize;
      const paginatedMock = mockFiltered.slice(startIdx, startIdx + adminPageSize);
      
      renderAdminStats();
      renderParticipants(paginatedMock);
      updatePaginationControls();
      return;
    }

    try {
      // 1. Сначала загружаем победителей
      await loadWinners(true).catch(err => console.error("Ошибка загрузки победителей:", err));

      // 2. Строим запрос для участников
      let query = supabase
        .from("participants")
        .select("receipt, name, phone, check_time, amount, date, won", { count: 'exact' });

      if (searchQuery) {
        // Поиск по ФИО, телефону или чеку с безопасным экранированием для PostgREST
        const sq = searchQuery.replace(/"/g, ''); 
        query = query.or(`name.ilike."%${sq}%",phone.ilike."%${sq}%",receipt.ilike."%${sq}%"`);
      }

      // Пагинация
      const from = (page - 1) * adminPageSize;
      const to = from + adminPageSize - 1;
      
      const { data, count, error } = await query
        .order("won", { ascending: false })
        .order("date", { ascending: false })
        .order("receipt", { ascending: true })
        .range(from, to);

      if (error) throw error;
      
      adminTotalParticipants = count || 0;

      // Маппинг данных
      const mappedParticipants = (data || []).map((p) => ({
        receipt: p.receipt,
        name: p.name,
        phone: p.phone,
        checkTime: p.check_time,
        amount: p.amount,
        date: p.date,
        won: p.won
      }));

      renderAdminStats();
      renderParticipants(mappedParticipants);
      updatePaginationControls();

    } catch (err) {
      console.error("Ошибка при загрузке данных админки:", err);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="7" style="color:var(--error); text-align:center;">Ошибка загрузки</td></tr>`;
      }
    }

    // Рассинхрон исключен в архитектуре с Supabase, так как данные лежат атомарно в одной СУБД
    const errEl = document.getElementById("adminSyncError");
    if (errEl) errEl.style.display = "none";
  }

  function updatePaginationControls() {
    const prevBtn = document.getElementById("prevPageBtn");
    const nextBtn = document.getElementById("nextPageBtn");
    const pageInfo = document.getElementById("pageInfo");

    if (!prevBtn || !nextBtn || !pageInfo) return;

    pageInfo.textContent = `Страница ${adminCurrentPage}`;

    if (adminCurrentPage <= 1) {
      prevBtn.disabled = true;
    } else {
      prevBtn.disabled = false;
    }

    if (adminCurrentPage * adminPageSize >= adminTotalParticipants) {
      nextBtn.disabled = true;
    } else {
      nextBtn.disabled = false;
    }
  }



  function renderAdminStats() {
    const totalPartEl = document.getElementById("statTotalParticipants");
    if (totalPartEl) totalPartEl.textContent = useMock || !supabase ? participants.length : adminTotalParticipants;
    
    const totalWinEl = document.getElementById("statTotalWinners");
    if (totalWinEl) totalWinEl.textContent = winners.length;
    
    renderPrizeStatus(winners);
  }

  function renderPrizeStatus(currentWinners) {
    const list = document.getElementById("prizeStatusList");
    if (!list) return;

    list.innerHTML = "";

    getDynamicPrizes().forEach((prizeName, index) => {
      const prizeId = index + 1;
      const winner = currentWinners.find((w) => {
        const prizeVal = String(w.prize).trim();
        if (!prizeVal) return false;
        if (prizeVal === String(prizeId)) return true;
        const nameWithoutPrefix = prizeName.replace(/^\d+\.\s+/, "");
        if (prizeVal === prizeName || prizeVal === nameWithoutPrefix) return true;
        return false;
      });

      const taken = !!winner;

      const item = document.createElement("div");
      item.style.padding = "15px";
      item.style.borderRadius = "8px";
      item.style.backgroundColor = taken ? "#552222" : "#224422";
      item.style.border = `1px solid ${taken ? "#ff6b6b" : "#51cf66"}`;
      item.style.display = "flex";
      item.style.flexDirection = "column";
      item.style.gap = "8px";

      item.innerHTML = `
            <div style="font-weight: bold; font-size: 0.95rem; color: #fff;">${escapeHTML(prizeName)}</div>
            <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 5px;">
                <div style="font-size: 0.9rem; font-weight: 600; color: ${taken ? "#ff6b6b" : "#51cf66"};">
                    ${taken ? "🔴 Разыгран" : "🟢 В наличии"}
                </div>
                ${
                  taken
                    ? `
                    <div style="font-size: 0.85rem; color: #aaa;">
                        <div>Чек: ${escapeHTML(winner.receipt)}</div>
                        <div>Дата: ${escapeHTML(formatDate(winner.date))}</div>
                    </div>
                `
                    : ""
                }
            </div>
        `;
      list.appendChild(item);
    });
  }

  // Отрисовка таблицы (серверная пагинация)
  function renderParticipants(items) {
    const tbody = document.getElementById("participantsBody");
    if (!tbody) return;
    tbody.innerHTML = "";

    const loadMoreBtn = document.getElementById("loadMoreBtn");
    if (loadMoreBtn) loadMoreBtn.classList.add("hidden");

    // Вспомогательная функция для получения числового значения приза участника
    const getPrizeNumber = (receipt) => {
      const found = winners.find(w => cleanR(w.receipt) === cleanR(receipt));
      if (found && found.prize !== undefined && found.prize !== null) {
        // Извлекаем только числовые последовательности из номера приза, например "Подвеска №23" -> 23
        const match = String(found.prize).match(/\d+/);
        return match ? parseInt(match[0], 10) : parseInt(found.prize, 10) || 0;
      }
      return null;
    };

    // 1. Фильтруем items, выделяя тех, кто точно НЕ является победителем
    const queryNonWinners = (items || []).filter(p => {
      const isWin = p.won || winners.some(w => cleanR(w.receipt) === cleanR(p.receipt));
      return !isWin;
    });

    // 2. Коллекционируем победителей, которых нужно показать на текущей странице / состоянии
    let winnersToRender = [];

    if (adminSearchQuery) {
      // При наличии поиска показываем только тех победителей из глобального списка, которые соответствуют поисковому запросу
      const sq = adminSearchQuery.toLowerCase();
      winnersToRender = winners.filter(w => 
        String(w.name || "").toLowerCase().includes(sq) ||
        String(w.receipt || "").toLowerCase().includes(sq) ||
        String(w.phone || "").toLowerCase().includes(sq)
      );
    } else if (adminCurrentPage === 1) {
      // Если это Page 1 и нет фильтра - показываем ВСЕХ глобальных победителей
      winnersToRender = [...winners];
    }

    // Сортируем победителей глобально по номеру приза по возрастанию
    winnersToRender.sort((a, b) => {
      const numA = getPrizeNumber(a.receipt) ?? 999;
      const numB = getPrizeNumber(b.receipt) ?? 999;
      return numA - numB;
    });

    // Строим итоговый список элементов для отрисовки на странице
    // Сначала победители в глобальном отсортированном порядке, затем не-победители текущей страницы
    const displayItems = [];
    const processedReceipts = new Set();
    
    // Добавляем победителей
    winnersToRender.forEach(w => {
      const rClean = cleanR(w.receipt);
      if (processedReceipts.has(rClean)) return;
      processedReceipts.add(rClean);

      // Ищем исходного участника среди items, чтобы подтянуть amount или checkTime, если они есть
      const orig = (items || []).find(p => cleanR(p.receipt) === rClean);
      displayItems.push({
        receipt: w.receipt,
        name: w.name || (orig ? orig.name : "Участник"),
        phone: w.phone || (orig ? orig.phone : "—"),
        checkTime: orig ? orig.checkTime : undefined,
        amount: orig ? orig.amount : undefined,
        date: w.date || (orig ? orig.date : undefined),
        won: true,
        bgWinner: true
      });
    });

    // Теперь добавляем обычных участников текущей страницы
    queryNonWinners.forEach(p => {
      const rClean = cleanR(p.receipt);
      if (processedReceipts.has(rClean)) return; // Избегаем дублирования
      processedReceipts.add(rClean);
      displayItems.push(p);
    });

    if (displayItems.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted, #888); padding: 40px;">Ничего не найдено</td></tr>';
      return;
    }

    const sortedItems = displayItems;

    sortedItems.forEach((p) => {
      const tr = document.createElement("tr");

      const found = winners.find(
        (w) => cleanR(w.receipt) === cleanR(p.receipt),
      );
      const isWinner = !!found || !!p.won;

      if (isWinner) tr.style.backgroundColor = "rgba(25, 163, 105, 0.05)";

      const checkTimeStr = p.checkTime ? formatDate(p.checkTime) : "—";
      const amountStr =
        p.amount && !isNaN(parseFloat(p.amount))
          ? p.amount + " руб."
          : p.amount || "—";

      let prizeStr = "";
      let prizeIndexFormatted = "";

      if (isWinner) {
        if (found && found.prize) {
          prizeIndexFormatted = found.prize;
          const resolved = resolvePrizeName(found.prize, found);
          prizeStr = resolved;
        } else {
          prizeStr = "Приз уточняется";
        }
      }

      tr.innerHTML = `
            <td><strong>${escapeHTML(p.receipt)}</strong></td>
            <td>${escapeHTML(p.name)}</td>
            <td>${escapeHTML(p.phone)}</td>
            <td>${escapeHTML(checkTimeStr)}</td>
            <td>${escapeHTML(amountStr)}</td>
            <td>${escapeHTML(formatDate(p.date))}</td>
            <td>
              ${
                isWinner
                  ? `
                <div style="color:var(--primary);font-weight:bold;margin-bottom:4px;">Победитель ${prizeIndexFormatted ? `(Приз №${prizeIndexFormatted})` : ""}</div>
                ${prizeStr ? `<div style="font-size:0.85rem;color:#333;margin-bottom:6px;">${escapeHTML(prizeStr)}</div>` : ""}
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                  <button class="btn remove-winner-btn" data-receipt="${escapeHTML(p.receipt)}" style="padding: 4px 8px; font-size: 0.8rem; background-color: var(--error, #e74c3c); color: white; border: none; border-radius: 4px; cursor: pointer;">Сбросить победу</button>
                  <button class="btn delete-participant-btn" data-receipt="${escapeHTML(p.receipt)}" data-name="${escapeHTML(p.name)}" style="padding: 4px 8px; font-size: 0.8rem; background-color: #555; color: white; border: none; border-radius: 4px; cursor: pointer; transition: background-color 0.2s;">Удалить</button>
                </div>
              `
                  : `
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                  <span style="color:#999;font-size:0.9rem;">Участник</span>
                  <button class="btn delete-participant-btn" data-receipt="${escapeHTML(p.receipt)}" data-name="${escapeHTML(p.name)}" style="padding: 4px 8px; font-size: 0.8rem; background-color: #555; color: white; border: none; border-radius: 4px; cursor: pointer; transition: background-color 0.2s;">Удалить</button>
                </div>
              `
              }
            </td>
        `;
      
      tbody.appendChild(tr);
    });
  }

  // Кастомные диалоги
  window.showConfirmDialog = (message = "Вы действительно хотите выполнить это действие?", confirmText = "Да", cancelText = "Нет") => {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal";
      overlay.style.zIndex = "3000";

      const content = document.createElement("div");
      content.className = "modal-content";
      content.style.maxWidth = "420px";
      content.style.padding = "30px";
      content.style.textAlign = "center";
      content.style.borderRadius = "12px";
      content.style.border = "1px solid #333";
      content.style.boxShadow = "0 20px 40px rgba(0,0,0,0.5)";

      const title = document.createElement("h3");
      title.textContent = "Подтверждение действия";
      title.style.marginBottom = "15px";
      title.style.fontSize = "1.3rem";
      title.style.color = "var(--text-color)";

      const text = document.createElement("div");
      text.style.fontSize = "1rem";
      text.style.marginBottom = "25px";
      text.style.lineHeight = "1.6";
      text.style.color = "#ddd";
      // Support line breaks (e.g. for winner removal warning)
      text.innerHTML = message.replace(/\n/g, "<br>");

      const btnContainer = document.createElement("div");
      btnContainer.style.display = "flex";
      btnContainer.style.justifyContent = "center";
      btnContainer.style.gap = "15px";

      const confirmBtn = document.createElement("button");
      confirmBtn.className = "btn";
      confirmBtn.textContent = confirmText;
      confirmBtn.style.padding = "10px 20px";
      confirmBtn.style.background = "var(--error, #e74c3c)";
      confirmBtn.style.color = "white";
      confirmBtn.style.border = "none";
      confirmBtn.style.cursor = "pointer";
      confirmBtn.style.borderRadius = "6px";
      confirmBtn.style.fontWeight = "bold";

      const cancelBtn = document.createElement("button");
      cancelBtn.className = "btn";
      cancelBtn.textContent = cancelText;
      cancelBtn.style.padding = "10px 20px";
      cancelBtn.style.background = "#222";
      cancelBtn.style.color = "#ccc";
      cancelBtn.style.border = "1px solid #444";
      cancelBtn.style.cursor = "pointer";
      cancelBtn.style.borderRadius = "6px";

      cancelBtn.onclick = () => {
        document.body.removeChild(overlay);
        resolve(false);
      };

      confirmBtn.onclick = () => {
        document.body.removeChild(overlay);
        resolve(true);
      };

      // Button order: Yes, No, wait... user requested Да, Нет. Usually it's Yes then No or No then Yes for mobile. I will place Yes first (confirm), then No (cancel). Wait, cancel first helps prevent accidental clicks on "Да". I will put No (cancelBtn) first. But the user asked "Кнопки: Да, Нет". Yes, Да, Нет. I'll put Yes, No. Wait "Да, Нет" means left Да right Нет? Let's keep Yes then No or No then Yes. Let's do Yes then No... actually standard is Cancel then Confirm, let's swap them. Actually, I'll append confirmBtn (Да) then cancelBtn (Нет) so Да is on the left.
      // Or I can keep cancelBtn then confirmBtn. Let's just do Yes on left, No on right:
      btnContainer.appendChild(confirmBtn);
      btnContainer.appendChild(cancelBtn);

      content.appendChild(title);
      content.appendChild(text);
      content.appendChild(btnContainer);
      overlay.appendChild(content);
      document.body.appendChild(overlay);
    });
  };

  window.showAlertDialog = (message, isSuccess = false) => {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "modal";
      overlay.style.zIndex = "3000";

      const content = document.createElement("div");
      content.className = "modal-content";
      content.style.maxWidth = "420px";
      content.style.padding = "30px";
      content.style.textAlign = "center";
      content.style.borderRadius = "12px";
      content.style.border = "1px solid #333";
      content.style.boxShadow = "0 20px 40px rgba(0,0,0,0.5)";

      const title = document.createElement("h3");
      title.style.marginBottom = "15px";
      title.style.fontSize = "1.3rem";
      if (isSuccess) {
        title.textContent = "Успешно!";
        title.style.color = "var(--primary, #06a658)";
      } else {
        title.textContent = "Уведомление";
        title.style.color = "#ffcc00";
      }

      const text = document.createElement("p");
      text.style.fontSize = "1rem";
      text.style.marginBottom = "25px";
      text.style.lineHeight = "1.6";
      text.style.color = "#ddd";
      text.textContent = message;

      const okBtn = document.createElement("button");
      okBtn.className = "btn";
      okBtn.textContent = "ОК";
      okBtn.style.padding = "10px 30px";
      okBtn.style.background = isSuccess ? "var(--primary, #06a658)" : "#444";
      okBtn.style.color = "white";
      okBtn.style.border = "none";
      okBtn.style.cursor = "pointer";
      okBtn.style.borderRadius = "6px";
      okBtn.style.fontWeight = "bold";

      okBtn.onclick = () => {
        document.body.removeChild(overlay);
        resolve();
      };

      content.appendChild(title);
      content.appendChild(text);
      content.appendChild(okBtn);
      overlay.appendChild(content);
      document.body.appendChild(overlay);
    });
  };

  // Розыгрыш победителя (Атомарные Сделки)
  document.getElementById("drawWinnerBtn").addEventListener("click", async () => {
    const msg = document.getElementById("drawMessage");
    const btn = document.getElementById("drawWinnerBtn");

    if (window.winnerHideTimeout) {
      clearTimeout(window.winnerHideTimeout);
      window.winnerHideTimeout = null;
    }

    msg.style.opacity = "1";
    msg.style.transition = "";
    msg.className = "message";
    msg.textContent = "";

    function showWinnerMessage(w) {
      msg.innerHTML = `🎉 Победитель выбран!<br><strong style="font-size:1.2rem">${escapeHTML(w.name)} (Чек: ${escapeHTML(w.receipt)})</strong><br>Телефон: ${escapeHTML(w.phone)}<br><div style="margin-top: 5px; color: var(--primary); font-weight: bold;">${escapeHTML(resolvePrizeName(w.prize, w) || "Главный приз")}</div>`;
      msg.className = "message success";
      msg.style.opacity = "1";
      msg.style.transition = "";

      if (window.winnerHideTimeout) {
        clearTimeout(window.winnerHideTimeout);
      }
      window.winnerHideTimeout = setTimeout(() => {
        msg.style.transition = "opacity 1s ease";
        msg.style.opacity = "0";

        window.winnerHideTimeout = setTimeout(() => {
          msg.textContent = "";
          msg.className = "message";
          msg.style.opacity = "";
          msg.style.transition = "";
        }, 1000);
      }, 4000);
    }

    if (!useMock && supabase) {
      btn.disabled = true;

      let candidates = [];
      const { data } = await supabase.from('participants').select('receipt, name').eq('won', false).limit(30);
      if (data && data.length > 0) candidates = data;

      if (candidates.length === 0) {
        msg.textContent = "Нет доступных участников для розыгрыша";
        msg.className = "message error";
        btn.disabled = false;
        return;
      }
      
      msg.className = "message info";
      msg.style.opacity = "1";

      let spinInterval;

      if (candidates.length > 0) {
        spinInterval = setInterval(() => {
          const rand = candidates[Math.floor(Math.random() * candidates.length)];
          msg.innerHTML = `
            <div style="font-size: 1.1rem; margin-bottom: 5px;">🎰 <strong>Вращение барабана...</strong></div>
            <div style="font-family: monospace; font-size: 1.3rem; color: var(--primary); letter-spacing: 2px;">
              ${escapeHTML(rand.receipt)}
            </div>
            <div style="font-size: 0.9rem; opacity: 0.8; margin-top: 5px;">
              ${escapeHTML(rand.name)}
            </div>
          `;
        }, 80);
      } else {
        msg.innerHTML = "<strong>Подготовка к розыгрышу...</strong>";
      }

      try {
        // Вызываем безопасный бэкенд Edge-функции через Supabase Functions API
        const { data: responseData, error } = await supabase.functions.invoke("draw-winner", {
          body: { action: "draw" }
        });

        if (spinInterval) clearInterval(spinInterval);

        if (error) {
          let errorMsg = error.message || "Ошибка выполнения Edge-функции";
          if (error.context && typeof error.context.json === "function") {
            try {
              const errJson = await error.context.json();
              if (errJson && errJson.message) errorMsg = errJson.message;
            } catch (_) {}
          }
          throw new Error(errorMsg);
        }

        if (responseData && responseData.success) {
          showWinnerMessage(responseData.winner);
          await loadAdminData();
          await loadWinners(true);
        } else {
          msg.textContent = (responseData && responseData.message) || "Ошибка розыгрыша";
          msg.className = "message error";
        }
      } catch (e) {
        if (spinInterval) clearInterval(spinInterval);
        msg.textContent = e.message || "Ошибка соединения. Попробуйте позже.";
        msg.className = "message error";
      } finally {
        btn.disabled = false;
      }
      return;
    }

    // Демо-режим
    const eligible = participants.filter((p) => !p.won);

    if (eligible.length === 0) {
      msg.textContent = "Нет доступных участников для розыгрыша (все уже выиграли или участников 0).";
      msg.className = "message error";
      return;
    }

    btn.disabled = true;
    msg.className = "message info";
    msg.style.opacity = "1";
    let count = 0;

    let interval = setInterval(() => {
      let rand = eligible[Math.floor(Math.random() * eligible.length)];
      msg.innerHTML = `
        <div style="font-size: 1.1rem; margin-bottom: 5px;">🎰 <strong>Вращение барабана...</strong> (Демо)</div>
        <div style="font-family: monospace; font-size: 1.3rem; color: var(--primary); letter-spacing: 2px;">
          ${escapeHTML(rand.receipt)}
        </div>
        <div style="font-size: 0.9rem; opacity: 0.8; margin-top: 5px;">
          ${escapeHTML(rand.name)}
        </div>
      `;
      count++;
      if (count > 25) {
        clearInterval(interval);
        finishDraw();
      }
    }, 80);

    function finishDraw() {
      const winnerIndex = Math.floor(Math.random() * eligible.length);
      const winner = eligible[winnerIndex];

      const dynamicPrizesList = getDynamicPrizes();
      const currentWinnersCount = winners.length;

      if (currentWinnersCount >= dynamicPrizesList.length) {
        msg.textContent = `Все главные призы (${dynamicPrizesList.length} мест) уже разыграны!`;
        msg.className = "message error";
        btn.disabled = false;
        return;
      }

      const usedPrizes = winners.map((w) => parseInt(w.prize, 10));
      let prizeIndex = -1;
      for (let i = dynamicPrizesList.length; i >= 1; i--) {
        if (!usedPrizes.includes(i)) {
          prizeIndex = i;
          break;
        }
      }

      winner.won = true;
      winner.prize = prizeIndex;
      const winRecord = {
        receipt: winner.receipt,
        name: winner.name,
        phone: winner.phone,
        prize: prizeIndex,
        date: new Date().toISOString(),
      };
      winners.push(winRecord);

      showWinnerMessage(winner);
      btn.disabled = false;

      renderAdminStats();
      const q = document.getElementById("searchInput").value.toLowerCase();
      if (q) {
        document.getElementById("searchInput").dispatchEvent(new Event("input"));
      } else {
        renderParticipants(participants);
      }
    }
  });

  // Действия сброса победы и удаления участника
  window.removeWinnerAction = async (receiptOrBtn, possibleBtn) => {
    console.trace("removeWinnerAction called");
    let receipt;
    let btn;
    if (receiptOrBtn instanceof HTMLElement) {
      btn = receiptOrBtn;
      receipt = btn.getAttribute("data-receipt");
    } else {
      receipt = receiptOrBtn;
      btn = possibleBtn;
    }

    if (!receipt) {
      console.error("No receipt found or passed to removeWinnerAction");
      return;
    }

    const winnerObj = winners.find((w) => cleanR(w.receipt) === cleanR(receipt));
    const winnerName = winnerObj ? winnerObj.name : "Неизвестно";

    // Disable immediately to prevent double-calls
    if (btn) {
      btn.disabled = true;
    }

    const confirmed = await window.showConfirmDialog(
      `Вы действительно хотите аннулировать победу участника:\n${winnerName}\n\nПриз будет возвращён в список доступных призов.`
    );
    if (!confirmed) {
      if (btn) btn.disabled = false;
      return;
    }

    if (btn) {
      btn.textContent = "Удаление...";
    }

    try {
      if (useMock || !supabase) {
        winners = winners.filter((w) => cleanR(w.receipt) !== cleanR(receipt));
        const p = participants.find((part) => cleanR(part.receipt) === cleanR(receipt));
        if (p) p.won = false;

        await loadAdminData();
      } else {
        // Благодаря нашему новому триггеру AFTER DELETE ON winners в СУБД,
        // нам достаточно выполнить ровно один атомарный запрос к таблице победителей.
        // Это полностью страхует систему от рассинхронизации во время обрывов связи!
        const { error: winErr } = await supabase
          .from("winners")
          .delete()
          .eq("receipt", receipt);

        if (winErr) throw winErr;

        // Записываем лог
        await supabase.from("logs").insert({
          action: "REMOVE_WINNER",
          receipt: receipt,
          admin_user: authEmail()
        });

        await loadAdminData();
      }
    } catch (err) {
      console.error("Error removing winner:", err);
      await window.showAlertDialog("Произошла ошибка при связи с сервером.", false);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Сбросить победу";
      }
    }
  };

  window.deleteParticipantAction = async (receiptOrBtn, possibleBtn) => {
    let receipt;
    let btn;
    let participantName = "Участник";
    
    if (receiptOrBtn instanceof HTMLElement) {
      btn = receiptOrBtn;
      receipt = btn.getAttribute("data-receipt");
      participantName = btn.getAttribute("data-name") || "Участник";
    } else {
      receipt = receiptOrBtn;
      btn = possibleBtn;
      if (btn) participantName = btn.getAttribute("data-name") || "Участник";
    }

    if (!receipt) {
      console.error("No receipt found or passed to deleteParticipantAction");
      return;
    }

    // Disable immediately to prevent double-calls
    if (btn) {
      btn.disabled = true;
    }

    const confirmed = await window.showConfirmDialog(
      `Вы действительно хотите удалить участника ${escapeHTML(participantName)}?\n\nЕсли он является победителем, он также удалится из списка победителей.`,
      "Да",
      "Нет"
    );
    if (!confirmed) {
      if (btn) btn.disabled = false;
      return;
    }

    if (btn) {
      btn.textContent = "Удаление...";
    }

    try {
      if (useMock || !supabase) {
        participants = participants.filter((p) => cleanR(p.receipt) !== cleanR(receipt));
        winners = winners.filter((w) => cleanR(w.receipt) !== cleanR(receipt));

        await loadAdminData();
      } else {
        // Благодаря ON DELETE CASCADE в PostgreSQL схеме,
        // удаление участника автоматически очищает победителей!
        const { error: deleteErr } = await supabase
          .from("participants")
          .delete()
          .eq("receipt", receipt);

        if (deleteErr) throw deleteErr;

        // Логирование действия администратора
        await supabase.from("logs").insert({
          action: "DELETE_PARTICIPANT",
          receipt: receipt,
          admin_user: authEmail()
        });

        await loadAdminData();
      }
    } catch (err) {
      console.error("Error deleting participant:", err);
      await window.showAlertDialog("Произошла ошибка при связи с сервером.", false);
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Удалить";
      }
    }
  };

  window.clearAllDataAction = async () => {
    const btn = document.getElementById("clearAllDataBtn");
    if (btn) {
      btn.disabled = true;
    }

    const confirmed = await window.showConfirmDialog(
      "ВНИМАНИЕ! Вы собираетесь полностью удалить ВСЕХ зарегистрированных участников и ВСЕХ победителей!\nЭто действие необратимо.\n\nВы действительно хотите выполнить это действие?",
      "Да",
      "Нет"
    );
    if (!confirmed) {
      if (btn) btn.disabled = false;
      return;
    }

    if (btn) {
      btn.textContent = "Очистка...";
    }

    try {
      if (useMock || !supabase) {
        participants = [];
        winners = [];
        await loadAdminData();
      } else {
        // Удаляем всех участников, каскадно удаляя всех победителей
        const { error: clearErr } = await supabase
          .from("participants")
          .delete()
          .neq("receipt", "");

        if (clearErr) throw clearErr;

        // Лог действия админа
        await supabase.from("logs").insert({
          action: "CLEAR_ALL_DATA",
          admin_user: authEmail()
        });

        await loadAdminData();
      }
    } catch (err) {
      console.error("Error clearing all data:", err);
      await window.showAlertDialog("Произошла ошибка при связи с сервером.", false);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Очистить базу данных";
      }
    }
  };

  function authEmail() {
    if (supabase && adminUserEmail) {
      return adminUserEmail;
    }
    return "admin";
  }

  // Делегирование клика в таблице участников
  const participantsBody = document.getElementById("participantsBody");
  if (participantsBody) {
    participantsBody.addEventListener("click", (e) => {
      const winnerBtn = e.target.closest(".remove-winner-btn");
      if (winnerBtn) {
        e.preventDefault();
        e.stopPropagation();
        window.removeWinnerAction(winnerBtn);
        return;
      }

      const deleteBtn = e.target.closest(".delete-participant-btn");
      if (deleteBtn) {
        e.preventDefault();
        e.stopPropagation();
        window.deleteParticipantAction(deleteBtn);
      }
    });
  }

  const clearAllBtn = document.getElementById("clearAllDataBtn");
  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", window.clearAllDataAction);
  }

  // Живой поиск чеков
  const searchInput = document.getElementById("searchInput");
  if (searchInput) {
    let searchTimeout;
    searchInput.addEventListener("input", (e) => {
      const query = e.target.value.trim();
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        loadAdminData(1, query);
      }, 500);
    });
  }

  function tbodyClean() {
    const tbody = document.getElementById("participantsBody");
    if (tbody) tbody.innerHTML = "";
  }

  // ---- ЛОГИКА ВКЛАДОК ПАНЕЛИ АДМИНИСТРАТОРА ----
  const tabParticipants = document.getElementById("tabParticipants");
  const tabSettings = document.getElementById("tabSettings");
  const tabSiteSettings = document.getElementById("tabSiteSettings");
  const participantsTabContent = document.getElementById("participantsTabContent");
  const settingsTabContent = document.getElementById("settingsTabContent");
  const siteSettingsTabContent = document.getElementById("siteSettingsTabContent");

  function saveCurrentInputsToLocal() {
    const nameInputs = document.querySelectorAll(".admin-prize-name");
    const linkInputs = document.querySelectorAll(".admin-prize-link");
    localPrizes = [];
    nameInputs.forEach((input, i) => {
      const idx = i + 1;
      const name = input.value.trim();
      const link = linkInputs[i] ? linkInputs[i].value.trim() : "";
      localPrizes.push({ idx, name, link });
    });
  }

  function renderAdminPrizes() {
    const container = document.getElementById("adminPrizesList");
    if (!container) return;

    container.innerHTML = "";

    localPrizes.forEach((p, i) => {
      const idx = i + 1;
      const winnerForPrize = winners.find(w => parseInt(w.prize, 10) === idx);
      
      let badgeHtml = "";
      if (winnerForPrize) {
        badgeHtml = `<div style="grid-column: 1 / -1; color: #f1c40f; font-size: 0.85rem; font-weight: bold; margin-top: -5px; margin-bottom: 5px;">🏆 Связан с победителем (${escapeHTML(winnerForPrize.name)})</div>`;
      }

      const itemDiv = document.createElement("div");
      itemDiv.className = "admin-prize-row";
      itemDiv.style.cssText = "display: grid; grid-template-columns: 40px 1fr 1fr auto; gap: 15px; align-items: center; background: #0a0a0a; padding: 15px; border-radius: var(--radius); border: 1px solid #222; margin-bottom: 10px;";

      itemDiv.innerHTML = `
${badgeHtml}
        <div style="font-weight: bold; font-size: 1.2rem; color: var(--primary); text-align: center;">${idx}</div>
        <div>
          <label style="display:block; font-size:0.85rem; color:var(--text-muted); margin-bottom:5px;">Название приза</label>
          <input type="text" class="admin-prize-name" data-index="${idx}" value="${escapeHTML(p.name)}" style="width:100%; padding:8px 10px; border:1px solid var(--border-color); border-radius:var(--radius); background:#121212; color:#fff;" />
        </div>
        <div>
          <label style="display:block; font-size:0.85rem; color:var(--text-muted); margin-bottom:5px;">Ссылка на приз</label>
          <input type="text" class="admin-prize-link" data-index="${idx}" value="${escapeHTML(p.link)}" style="width:100%; padding:8px 10px; border:1px solid var(--border-color); border-radius:var(--radius); background:#121212; color:#fff;" />
        </div>
        <div style="text-align: center;">
          <button type="button" class="delete-prize-btn btn" data-index="${i}" 
                  style="margin-top: 18px; padding: 8px 12px; background: #cf6679; color: #fff; border: none; border-radius: var(--radius); cursor: pointer;"
                  title="Удалить приз">
            🗑
          </button>
        </div>
      `;
      container.appendChild(itemDiv);
    });

    const addBtnContainer = document.createElement("div");
    addBtnContainer.style.cssText = "text-align: left; margin-top: 15px;";
    addBtnContainer.innerHTML = `
      <button id="addPrizeBtn" type="button" class="btn" style="background-color: var(--primary); color: white; border: none; padding: 10px 20px; border-radius: var(--radius); cursor: pointer; font-weight: bold; font-family: var(--font-heading);">
        ➕ Добавить приз
      </button>
    `;
    container.appendChild(addBtnContainer);

    document.getElementById("addPrizeBtn").addEventListener("click", () => {
      saveCurrentInputsToLocal();
      localPrizes.push({
        idx: localPrizes.length + 1,
        name: "",
        link: "https://go-go.md/"
      });
      renderAdminPrizes();
    });

    const deleteBtns = container.querySelectorAll(".delete-prize-btn");
    deleteBtns.forEach(btn => {
      btn.addEventListener("click", async (e) => {
        saveCurrentInputsToLocal();
        const deleteIndex = parseInt(btn.getAttribute("data-index"), 10);
        const prizeIdx = deleteIndex + 1;
        const prizeName = localPrizes[deleteIndex].name || `Приз №${prizeIdx}`;

        const winnerForPrize = winners.find(w => parseInt(w.prize, 10) === prizeIdx);

        let confirmMsg = `Вы действительно хотите удалить приз:\n"${prizeName}"?`;
        if (winnerForPrize) {
          confirmMsg = `Этот приз уже участвовал в розыгрыше. Продолжить удаление?`;
        }

        btn.disabled = true;
        btn.style.opacity = "0.5";
        const isConfirmed = await window.showConfirmDialog(confirmMsg);
        if (!isConfirmed) {
          btn.disabled = false;
          btn.style.opacity = "1";
          return;
        }

        if (!useMock && supabase) {
          btn.disabled = true;
          btn.style.opacity = "0.5";
          try {
            // Вызываем процедуру в БД, которая выполнит ВСЕ удаления,
            // каскадные сбросы флага won, перенумерацию призов и победителей в одной СУБД-транзакции!
            const { data: rpcRes, error: rpcErr } = await supabase.rpc("delete_prize_and_reorder", {
              prize_idx_to_delete: prizeIdx,
              admin_email: authEmail()
            });

            if (rpcErr) throw rpcErr;

            await loadPrizes();
            await loadAdminData();

            localPrizes.splice(deleteIndex, 1);
            localPrizes.forEach((item, k) => {
              item.idx = k + 1;
            });

            const newSyncPrizes = localPrizes.map(p => ({
              id: p.idx,
              name: p.name,
              link: p.link
            }));
            config.prizes = newSyncPrizes;
            renderAdminPrizes();

          } catch (err) {
            console.error("Ошибка при удалении приза через RPC:", err);
            await window.showAlertDialog("Ошибка при удалении приза: " + (err.message || err), false);
            btn.disabled = false;
            btn.style.opacity = "1";
            return;
          }
        } else {
          // Демо-режим
          if (winnerForPrize) {
            winners = winners.filter(w => w.receipt !== winnerForPrize.receipt);
            let pObj = participants.find((p) => p.receipt === winnerForPrize.receipt);
            if (pObj) pObj.won = false;
            currentWinnersCount = winners.length;
          }

          localPrizes.splice(deleteIndex, 1);
          localPrizes.forEach((item, k) => {
            item.idx = k + 1;
          });

          const newSyncPrizes = localPrizes.map(p => ({
            id: p.idx,
            name: p.name,
            link: p.link
          }));

          // Перенумерация и обновление локальных победителей в демо-режиме
          winners.forEach((w) => {
            const currentPrizeId = parseInt(w.prize, 10);
            if (currentPrizeId > prizeIdx) {
              const targetPrizeId = currentPrizeId - 1;
              const foundNewPrize = newSyncPrizes.find(p => p.id === targetPrizeId);
              w.prize = targetPrizeId;
              w.prize_name = foundNewPrize ? foundNewPrize.name : `Приз №${targetPrizeId}`;
            }
          });

          config.prizes = newSyncPrizes;
          localStorage.setItem("lottery_prizes", JSON.stringify(newSyncPrizes));
          renderAdminPrizes();
        }

        // Обновляем UI
        if (!useMock && supabase) {
          await loadAdminData();
        } else {
          renderAdminPrizes();
        }
      });
    });
  }

  function fillSiteSettingsInputs() {
    const titleInput = document.getElementById("adminSiteTitle");
    const subtitleInput = document.getElementById("adminSiteSubtitle");
    const minAmountInput = document.getElementById("adminMinAmount");
    
    if (minAmountInput) {
      minAmountInput.value = config.minPurchaseAmount ? config.minPurchaseAmount.toString() : "1500";
    }
    
    const heroTitleNode = document.getElementById("hero-title");
    if (titleInput) {
      titleInput.value = config.heroTitle || (heroTitleNode ? heroTitleNode.textContent.trim() : "");
    }
    
    const heroSubTitleNode = document.getElementById("hero-prize-text");
    if (subtitleInput) {
      subtitleInput.value = config.heroSubtitle || (heroSubTitleNode ? heroSubTitleNode.textContent.trim().replace(/\s+/g, " ") : "");
    }

    const cards = document.querySelectorAll(".prizes-grid .prize-card");
    localPrizes = Array.from(cards).map((card, i) => {
      const num = i + 1;
      return {
        idx: num,
        name: card.querySelector(".prize-text").textContent.trim().replace(/\s+/g, " "),
        link: card.getAttribute("href") || ""
      };
    });

    renderAdminPrizes();
  }

  function fillSettingsInputs() {
    const startInput = document.getElementById("adminStartDate");
    const endInput = document.getElementById("adminEndDate");
    const drawInput = document.getElementById("adminDrawDate");

    if (startInput && config.startDate) {
      startInput.value = formatAdminDate(new Date(config.startDate));
    }

    if (endInput && config.endDate) {
      endInput.value = formatAdminDate(new Date(config.endDate));
    }

    if (drawInput && config.drawDate) {
      drawInput.value = formatAdminDate(new Date(config.drawDate));
    }

    const publishInput = document.getElementById("publishWinners");
    if (publishInput) {
      publishInput.checked = config.winnersPublished === true;
    }

    updateRegistrationStatusUI();
  }

  function formatAdminDate(dateObj) {
    if (isNaN(dateObj.getTime())) return "";
    const dd = String(dateObj.getDate()).padStart(2, "0");
    const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
    const yyyy = dateObj.getFullYear();
    const hh = String(dateObj.getHours()).padStart(2, "0");
    const mins = String(dateObj.getMinutes()).padStart(2, "0");
    return `${dd}.${mm}.${yyyy} ${hh}:${mins}`;
  }

  function updateRegistrationStatusUI() {
    const statusText = document.getElementById("adminRegStatusText");
    const toggleBtn = document.getElementById("toggleRegBtn");
    if (!statusText || !toggleBtn) return;

    const isEnabled = config.registrationEnabled !== false;
    if (isEnabled) {
      statusText.textContent = "🟢 Открыта";
      statusText.style.backgroundColor = "rgba(46, 204, 113, 0.2)";
      statusText.style.color = "var(--primary, #2ecc71)";
      toggleBtn.textContent = "🔴 Закрыть регистрацию";
      toggleBtn.className = "btn btn-outline";
      toggleBtn.style.color = "var(--error, #cf6679)";
      toggleBtn.style.borderColor = "var(--error, #cf6679)";
    } else {
      statusText.textContent = "🔴 Закрыта";
      statusText.style.backgroundColor = "rgba(207, 102, 121, 0.2)";
      statusText.style.color = "var(--error, #cf6679)";
      toggleBtn.textContent = "🟢 Открыть регистрацию";
      toggleBtn.className = "btn btn-outline";
      toggleBtn.style.color = "var(--primary, #06a658)";
      toggleBtn.style.borderColor = "var(--primary, #06a658)";
    }
  }

  function parseUserDate(str) {
    if (!str) return null;
    str = str.trim();

    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(str)) {
      return str.replace(" ", "T");
    }

    let match = str.match(
      /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/,
    );
    if (match) {
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10) - 1;
      const year = parseInt(match[3], 10);
      const hour = match[4] ? parseInt(match[4], 10) : 0;
      const min = match[5] ? parseInt(match[5], 10) : 0;
      const sec = match[6] ? parseInt(match[6], 10) : 0;
      return new Date(year, month, day, hour, min, sec).toISOString();
    }
    return null;
  }

  // Сохранение настроек акции
  const saveSettingsBtn = document.getElementById("saveSettingsBtn");
  if (saveSettingsBtn) {
    saveSettingsBtn.addEventListener("click", async () => {
      const msg = document.getElementById("settingsMessage");
      const startVal = document.getElementById("adminStartDate").value;
      const endVal = document.getElementById("adminEndDate").value;
      const drawVal = document.getElementById("adminDrawDate").value;

      if (!startVal || !endVal || !drawVal) {
        msg.textContent = "Пожалуйста, заполните все поля.";
        msg.className = "message error";
        return;
      }

      const parsedStart = parseUserDate(startVal);
      const parsedEnd = parseUserDate(endVal);
      const parsedDraw = parseUserDate(drawVal);

      if (!parsedStart || !parsedEnd || !parsedDraw) {
        msg.textContent =
          "Неверный формат даты. Пожалуйста, используйте формат: ДД.ММ.ГГГГ ЧЧ:ММ (например: 30.06.2026 23:59)";
        msg.className = "message error";
        return;
      }

      saveSettingsBtn.disabled = true;
      saveSettingsBtn.textContent = "Сохранение...";
      msg.textContent = "";
      msg.className = "message";

      const isDrawDateChanged = config.drawDate !== parsedDraw;

      const newSettings = {
        startDate: parsedStart,
        endDate: parsedEnd,
        drawDate: parsedDraw,
        registrationEnabled: config.registrationEnabled !== false,
        winnersPublished: document.getElementById("publishWinners").checked,
        configHash: config.configHash || ""
      };

      try {
        if (useMock || !supabase) {
          await new Promise((r) => setTimeout(r, 600));
          if (isDrawDateChanged) {
            config.drawDate = parsedDraw;
            await recalculateAndSaveConfigHash();
            newSettings.configHash = config.configHash;
          }
          localStorage.setItem("lottery_settings", JSON.stringify(newSettings));
          config = { ...config, ...newSettings };
          msg.textContent = "Настройки успешно сохранены локально в демо-режиме.";
          msg.className = "message success";
        } else {
          if (isDrawDateChanged) {
            config.drawDate = parsedDraw;
            await recalculateAndSaveConfigHash();
            newSettings.configHash = config.configHash;
          }
          const upsertSettings = [
            { key: "startDate", value: parsedStart },
            { key: "endDate", value: parsedEnd },
            { key: "drawDate", value: parsedDraw },
            { key: "registrationEnabled", value: String(newSettings.registrationEnabled) },
            { key: "winnersPublished", value: String(newSettings.winnersPublished) }
          ];
          const { error } = await supabase.from("settings").upsert(upsertSettings);
          if (error) throw error;
          
          await supabase.from("logs").insert({
            action: "SAVE_SETTINGS",
            admin_user: authEmail(),
            created_at: new Date().toISOString()
          }).select().maybeSingle();
          
          config = { ...config, ...newSettings };
          msg.textContent = "Настройки успешно сохранены.";
          msg.className = "message success";
        }
        
        updateDynamicDateTexts();
        initDatePicker();
        checkRegistrationPeriod();
        fillSettingsInputs();
        saveToCache();
      } catch (err) {
        console.error("Ошибка при сохранении настроек:", err);
        msg.textContent = "Произошла ошибка связи с сервером.";
        msg.className = "message error";
      } finally {
        saveSettingsBtn.disabled = false;
        saveSettingsBtn.textContent = "Сохранить настройки";
      }
    });
  }

  if (tabParticipants && tabSettings && tabSiteSettings) {
    tabParticipants.addEventListener("click", async () => {
      await loadPrizes();
      tabParticipants.classList.add("active");
      tabParticipants.style.color = "var(--primary)";
      tabParticipants.style.borderBottom = "3px solid var(--primary)";

      tabSettings.classList.remove("active");
      tabSettings.style.color = "var(--text-muted)";
      tabSettings.style.borderBottom = "none";

      tabSiteSettings.classList.remove("active");
      tabSiteSettings.style.color = "var(--text-muted)";
      tabSiteSettings.style.borderBottom = "none";

      participantsTabContent.classList.remove("hidden");
      settingsTabContent.classList.add("hidden");
      siteSettingsTabContent.classList.add("hidden");
    });

    tabSettings.addEventListener("click", async () => {
      await loadPrizes();
      tabSettings.classList.add("active");
      tabSettings.style.color = "var(--primary)";
      tabSettings.style.borderBottom = "3px solid var(--primary)";

      tabParticipants.classList.remove("active");
      tabParticipants.style.color = "var(--text-muted)";
      tabParticipants.style.borderBottom = "none";

      tabSiteSettings.classList.remove("active");
      tabSiteSettings.style.color = "var(--text-muted)";
      tabSiteSettings.style.borderBottom = "none";

      participantsTabContent.classList.add("hidden");
      settingsTabContent.classList.remove("hidden");
      siteSettingsTabContent.classList.add("hidden");

      fillSettingsInputs();
    });

    tabSiteSettings.addEventListener("click", async () => {
      await loadPrizes();
      tabSiteSettings.classList.add("active");
      tabSiteSettings.style.color = "var(--primary)";
      tabSiteSettings.style.borderBottom = "3px solid var(--primary)";

      tabParticipants.classList.remove("active");
      tabParticipants.style.color = "var(--text-muted)";
      tabParticipants.style.borderBottom = "none";

      tabSettings.classList.remove("active");
      tabSettings.style.color = "var(--text-muted)";
      tabSettings.style.borderBottom = "none";

      participantsTabContent.classList.add("hidden");
      settingsTabContent.classList.add("hidden");
      siteSettingsTabContent.classList.remove("hidden");

      fillSiteSettingsInputs();
    });
  }

  // Пагинация участников в админке
  const prevBtn = document.getElementById("prevPageBtn");
  const nextBtn = document.getElementById("nextPageBtn");
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      if (adminCurrentPage > 1) {
        loadAdminData(adminCurrentPage - 1, adminSearchQuery);
      }
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      if (adminCurrentPage * adminPageSize < adminTotalParticipants) {
        loadAdminData(adminCurrentPage + 1, adminSearchQuery);
      }
    });
  }



  const toggleRegBtn = document.getElementById("toggleRegBtn");
  if (toggleRegBtn) {
    toggleRegBtn.addEventListener("click", () => {
      config.registrationEnabled =
        config.registrationEnabled === false ? true : false;
      updateRegistrationStatusUI();
    });
  }

  // Вспомогательная функция для автоматического сохранения обновленного хэша в бэкенд
  async function recalculateAndSaveConfigHash() {
    const nextHash = calculateConfigHash(
      config.drawDate,
      config.heroTitle,
      config.heroSubtitle,
      config.minPurchaseAmount,
      config.prizes
    );
    config.configHash = nextHash;
    
    if (useMock || !supabase) {
      console.log(`%c[Config Hashing] (Demo) Локальный расчет хэша первого экрана: ${nextHash}`, "color: #00bcd4; font-weight: bold;");
      return nextHash;
    }
    
    try {
      const { error } = await supabase.from("settings").upsert({
        key: "configHash",
        value: nextHash
      });
      if (error) throw error;
      console.log(`%c[Config Hashing] Хэш конфигурации сохранен в Supabase: ${nextHash}`, "color: #00bcd4; font-weight: bold;");
      return nextHash;
    } catch (err) {
      console.error("[Config Hashing] Критическая ошибка при сохранении хэша:", err);
      throw err;
    }
  }


  function updateFrontEndPrizesUI(prizes) {
    const grid = document.querySelector(".prizes-grid");
    if (!grid) return;
    
    grid.innerHTML = `<!-- PRIZES_LIST_START -->\n` + 
      prizes.map((p, i) => {
        const prizeNum = i + 1;
        const safeLink = p.link.replace(/"/g, "&quot;");
        const safeName = escapeHTML(p.name);
        return `
            <!-- PRIZE_${prizeNum}_START -->
            <a
              href="${safeLink}"
              target="_blank"
              class="prize-card"
            >
              <div class="prize-rank">${prizeNum}</div>
              <div class="prize-text">
                ${safeName}
              </div>
            </a>
            <!-- PRIZE_${prizeNum}_END -->
        `;
      }).join("\n") +
      `\n<!-- PRIZES_LIST_END -->`;
  }

  // Сохранение настроек сайта
  let siteSettingsTimeout = null;
  const saveSiteSettingsBtn = document.getElementById("saveSiteSettingsBtn");
  if (saveSiteSettingsBtn) {
    saveSiteSettingsBtn.addEventListener("click", async () => {
      if (siteSettingsTimeout) clearTimeout(siteSettingsTimeout);
      const msg = document.getElementById("siteSettingsMessage");
      const titleVal = document.getElementById("adminSiteTitle").value.trim();
      const subtitleVal = document.getElementById("adminSiteSubtitle").value.trim();

      if (!titleVal || !subtitleVal) {
        msg.textContent = "Пожалуйста, заполните заголовок и подзаголовок.";
        msg.className = "message error";
        return;
      }

      const newPrizes = [];
      const nameInputs = document.querySelectorAll(".admin-prize-name");
      const linkInputs = document.querySelectorAll(".admin-prize-link");

      if (nameInputs.length === 0 || nameInputs.length !== linkInputs.length) {
        msg.textContent = "Ошибка: не все поля призов заполнены корректно.";
        msg.className = "message error";
        return;
      }

      for (let i = 0; i < nameInputs.length; i++) {
        const nameVal = nameInputs[i].value.trim();
        const linkVal = linkInputs[i].value.trim();
        if (!nameVal || !linkVal) {
          msg.textContent = `Пожалуйста, заполните все поля для приза №${i + 1}.`;
          msg.className = "message error";
          return;
        }

        try {
          const parsedUrl = new URL(linkVal);
          if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            msg.textContent = `Ссылка для приза №${i + 1} содержит недопустимый протокол. Разрешены только http:// и https://`;
            msg.className = "message error";
            return;
          }
        } catch (e) {
          msg.textContent = `Приз №${i + 1} содержит невалидный URL.`;
          msg.className = "message error";
          return;
        }

        newPrizes.push({
          id: i + 1,
          name: nameVal,
          link: linkVal
        });
      }

      saveSiteSettingsBtn.disabled = true;
      saveSiteSettingsBtn.textContent = "Сохранение...";
      msg.textContent = "";
      msg.className = "message";

      try {
        if (useMock || !supabase) {
          await new Promise((r) => setTimeout(r, 600));
          
          config.heroTitle = titleVal;
          config.heroSubtitle = subtitleVal;
          config.prizes = newPrizes;
          await recalculateAndSaveConfigHash();
          
          localStorage.setItem("lottery_settings", JSON.stringify({
            startDate: config.startDate,
            endDate: config.endDate,
            drawDate: config.drawDate,
            registrationEnabled: config.registrationEnabled,
            winnersPublished: config.winnersPublished,
            minPurchaseAmount: config.minPurchaseAmount,
            heroTitle: titleVal,
            heroSubtitle: subtitleVal,
            configHash: config.configHash
          }));
          
          localStorage.setItem("lottery_prizes", JSON.stringify(newPrizes));

          msg.textContent = "Настройки сайта изменены локально в браузере (демо-режим).";
          msg.className = "message success";
          siteSettingsTimeout = setTimeout(() => {
            msg.textContent = "";
            msg.className = "message";
          }, 5000);
        } else {
          const upsertSettings = [
            { key: "heroTitle", value: titleVal },
            { key: "heroSubtitle", value: subtitleVal }
          ];
          const { error: settingsError } = await supabase.from("settings").upsert(upsertSettings);
          if (settingsError) throw settingsError;

          if (newPrizes.length > 0) {
            const { error: delError } = await supabase.from("prizes").delete().gt("id", newPrizes.length);
            if (delError) throw delError;

            const { error: prizesError } = await supabase.from("prizes").upsert(newPrizes);
            if (prizesError) throw prizesError;
          }

          await supabase.from("logs").insert({
            action: "SAVE_SITE_SETTINGS",
            admin_user: authEmail(),
            created_at: new Date().toISOString()
          }).select().maybeSingle();

          config.heroTitle = titleVal;
          config.heroSubtitle = subtitleVal;
          config.prizes = newPrizes;

          await recalculateAndSaveConfigHash();

          msg.textContent = "Настройки сайта изменены в базе данных.";
          msg.className = "message success";
          siteSettingsTimeout = setTimeout(() => {
            msg.textContent = "";
            msg.className = "message";
          }, 5000);
        }

        const titleEl = document.getElementById("hero-title");
        if (titleEl) titleEl.textContent = titleVal;
        
        const subtitleEl = document.getElementById("hero-prize-text");
        if (subtitleEl) subtitleEl.textContent = subtitleVal;

        updateFrontEndPrizesUI(newPrizes);

        fillSiteSettingsInputs();
        saveToCache();
      } catch (err) {
        console.error("Ошибка при сохранении настроек сайта:", err);
        msg.textContent = "Произошла ошибка связи с сервером: " + err.message;
        msg.className = "message error";
      } finally {
        saveSiteSettingsBtn.disabled = false;
        saveSiteSettingsBtn.textContent = "Сохранить настройки сайта";
      }
    });
  }

  // Обновление минимальной суммы
  const saveMinAmountBtn = document.getElementById("saveMinAmountBtn");
  if (saveMinAmountBtn) {
    saveMinAmountBtn.addEventListener("click", async () => {
      const msg = document.getElementById("minAmountMessage");
      const minAmountVal = document.getElementById("adminMinAmount").value.trim();

      if (!minAmountVal || isNaN(parseInt(minAmountVal, 10)) || parseInt(minAmountVal, 10) < 0) {
        msg.style.display = "block";
        msg.textContent = "Введите корректную минимальную сумму.";
        msg.className = "message error";
        return;
      }

      saveMinAmountBtn.disabled = true;
      saveMinAmountBtn.textContent = "Сохранение...";
      msg.style.display = "none";
      msg.className = "message";

      const parsedAmount = parseFloat(minAmountVal);

      try {
        if (useMock || !supabase) {
          await new Promise(r => setTimeout(r, 600));
          config.minPurchaseAmount = parsedAmount;
          await recalculateAndSaveConfigHash();
          
          localStorage.setItem("lottery_settings", JSON.stringify({
            startDate: config.startDate,
            endDate: config.endDate,
            drawDate: config.drawDate,
            registrationEnabled: config.registrationEnabled,
            winnersPublished: config.winnersPublished,
            minPurchaseAmount: minAmountVal,
            heroTitle: config.heroTitle,
            heroSubtitle: config.heroSubtitle,
            configHash: config.configHash
          }));

          msg.textContent = "Минимальная сумма покупки сохранена локально.";
          msg.className = "message success";
          msg.style.display = "block";
        } else {
          const { error } = await supabase.from("settings").upsert([
            { key: "minPurchaseAmount", value: minAmountVal }
          ]);
          if (error) throw error;
          
          await supabase.from("logs").insert({
            action: "SAVE_MIN_AMOUNT",
            admin_user: authEmail(),
            created_at: new Date().toISOString()
          }).select().maybeSingle();
          
          config.minPurchaseAmount = parsedAmount;
          await recalculateAndSaveConfigHash();
          
          msg.textContent = "Сумма успешно сохранена в базе данных.";
          msg.className = "message success";
          msg.style.display = "block";
        }
        
        const amountInput = document.getElementById("amount");
        if (amountInput) {
          amountInput.setAttribute("min", minAmountVal);
          amountInput.setAttribute("placeholder", "Минимум " + minAmountVal + " рублей");
        }
        const m1 = document.getElementById("promoMinAmountText1");
        if (m1) m1.innerHTML = minAmountVal;
        const m2 = document.getElementById("promoMinAmountText2");
        if (m2) m2.innerHTML = minAmountVal;
        saveToCache();
      } catch (err) {
        console.error("Ошибка при сохранении суммы:", err);
        msg.style.display = "block";
        msg.textContent = "Произошла ошибка связи с сервером.";
        msg.className = "message error";
      } finally {
        saveMinAmountBtn.disabled = false;
        saveMinAmountBtn.textContent = "Сохранить сумму акции";
      }
    });
  }

  // Ленивая загрузка победителей с использованием Intersection Observer
  function setupWinnersLazyLoading() {
    const list = document.getElementById("winnersList");
    const promoForm = document.getElementById("promoForm");
    const winnersSection = document.querySelector(".winners-section");

    if (!list) return;

    // Скелетон загрузки показываем изначально до начала загрузки
    list.classList.add("winners-fade-in");
    list.innerHTML = `
      <div class="skeleton-card shimmer">
        <div class="skeleton-header"></div>
        <div class="skeleton-name"></div>
        <div class="skeleton-receipt"></div>
      </div>
      <div class="skeleton-card shimmer">
        <div class="skeleton-header"></div>
        <div class="skeleton-name"></div>
        <div class="skeleton-receipt"></div>
      </div>
      <div class="skeleton-card shimmer">
        <div class="skeleton-header"></div>
        <div class="skeleton-name"></div>
        <div class="skeleton-receipt"></div>
      </div>
    `;

    if (typeof IntersectionObserver !== "undefined") {
      const observer = new IntersectionObserver((entries) => {
        const isIntersecting = entries.some(entry => entry.isIntersecting);
        if (isIntersecting) {
          console.log("Доскроллили до формы регистрации или блока победителей, загружаем результаты...");
          loadWinners();
          observer.disconnect();
        }
      }, {
        rootMargin: "150px 0px" // Подгружаем на 150px раньше пересечения для максимально бесшовного эффекта
      });

      if (promoForm) observer.observe(promoForm);
      if (winnersSection) observer.observe(winnersSection);
    } else {
      // Фолбэк для устаревших систем
      loadWinners();
    }
  }

  // Запуск ленивой оптимизированной загрузки
  setupWinnersLazyLoading();
});
