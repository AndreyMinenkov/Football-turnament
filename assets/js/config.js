/**
 * Конфигурация сайта.
 *
 * Файл подключается ПЕРВЫМ (до logic.js, sync.js и app.js), чтобы все модули
 * читали настройки из одного места. Значения ниже можно менять — правки
 * применятся после перезагрузки страницы.
 */
window.FT_CONFIG = window.FT_CONFIG || {};

/* --- Где хранятся общие данные турнира (репозиторий на GitHub) --- */
window.FT_CONFIG.github = Object.assign({
    // Владелец и имя репозитория, в котором лежит сайт
    owner: 'Footballorchestra',
    repo: 'Football-turnament',

    // Ветка и файл с данными
    branch: 'main',
    path: 'data.json',

    // Адреса API GitHub. Менять не нужно: они подставляются в запросы,
    // а в автотестах подменяются на локальный макет, чтобы не трогать реальный GitHub.
    apiBase: 'https://api.github.com',
    rawBase: 'https://raw.githubusercontent.com'
}, window.FT_CONFIG.github || {});

/* --- Автообновление данных у зрителей, миллисекунды (0 — выключено) --- */
window.FT_CONFIG.refreshIntervalMs = window.FT_CONFIG.refreshIntervalMs === undefined
    ? 300000 // 5 минут
    : window.FT_CONFIG.refreshIntervalMs;

/* --- Пауза перед авто-публикацией: несколько быстрых правок склеиваются в один коммит --- */
window.FT_CONFIG.autoPublishDelayMs = window.FT_CONFIG.autoPublishDelayMs === undefined
    ? 12000
    : window.FT_CONFIG.autoPublishDelayMs;

/* --- Ключи в localStorage --- */
window.FT_CONFIG.storageKeys = Object.assign({
    token: 'ft.githubToken',        // токен GitHub (только на устройстве администратора)
    autoPublish: 'ft.autoPublish',  // «публиковать автоматически»
    publishedAt: 'ft.publishedAt',  // метка последней успешной публикации
    localBackup: 'ft.localBackup',  // копия данных перед заменой версией из репозитория
    localEdits: 'ft.localEdits'     // отметка «на устройстве есть неопубликованные правки»
}, window.FT_CONFIG.storageKeys || {});
