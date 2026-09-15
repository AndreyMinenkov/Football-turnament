/**
 * Слой представления: роутинг, отрисовка страниц и админ-панель.
 *
 * Вся «чистая» логика (расчёты, валидация, хранилище) находится в assets/js/logic.js
 * и доступна как window.FTLogic. Здесь — только DOM и события.
 *
 * Принципы:
 *   • никаких inline-скриптов и inline-стилей — это позволяет включить строгую CSP;
 *   • пользовательский ввод всегда экранируется (защита от XSS и «сломанной» вёрстки);
 *   • все изменения данных проходят через saveData() → localStorage + перерисовка.
 */
(function () {
    'use strict';

    var L = window.FTLogic;
    var S = window.FTSync;
    var CONFIG = L.CONFIG;
    var SETTINGS = window.FT_CONFIG || {};
    var KEYS = SETTINGS.storageKeys || {
        token: 'ft.githubToken',
        autoPublish: 'ft.autoPublish',
        publishedAt: 'ft.publishedAt',
        localBackup: 'ft.localBackup',
        localEdits: 'ft.localEdits'
    };

    /** Состояние приложения (в хранилище попадает только state.data). */
    var state = {
        data: L.createDefaultData(),
        dataFromStorage: false,
        initialized: false,
        settingsOpen: false,
        storage: null,
        storageAvailable: true,
        admin: false,
        route: 'home',
        matchesFilter: 'all',
        editingTeamId: null,
        editingMatchId: null,
        editingPlayer: null
    };

    /**
     * Состояние синхронизации с репозиторием GitHub.
     * Токен и метка последней публикации живут только в localStorage этого устройства.
     */
    /** Состояние синхронизации с репозиторием GitHub. */
    var sync = {
        client: null,
        token: '',
        sha: null,
        publishedAt: '',
        autoPublish: false,
        publishing: false,
        pullCompleted: false,
        lastAction: '',
        lastError: '',
        lastPullError: '',
        lastCommitUrl: '',
        timer: null,
        refreshTimer: null
    };

    /* ================================================================== */
    /* Настройки синхронизации и токен (локально на устройстве)           */
    /* ================================================================== */

    function readStoredValue(key) {
        try {
            return state.storage ? state.storage.getItem(key) : null;
        } catch (error) {
            return null;
        }
    }

    function writeStoredValue(key, value) {
        try {
            if (!state.storage) {
                return;
            }

            if (value === null || value === undefined) {
                state.storage.removeItem(key);
            } else {
                state.storage.setItem(key, String(value));
            }
        } catch (error) {
            // приватный режим браузера — просто игнорируем
        }
    }

    function readSyncSettings() {
        sync.token = readStoredValue(KEYS.token) || '';
        sync.publishedAt = readStoredValue(KEYS.publishedAt) || '';

        var storedAuto = readStoredValue(KEYS.autoPublish);
        sync.autoPublish = storedAuto === null ? Boolean(sync.token) : storedAuto === '1';
    }

    function createSyncClient() {
        if (!S || typeof S.createClient !== 'function') {
            return null;
        }

        return S.createClient({
            github: SETTINGS.github,
            getToken: function () { return sync.token; },
            fetch: (typeof window.fetch === 'function') ? window.fetch.bind(window) : undefined
        });
    }

    /**
     * Есть ли на устройстве правки, которые ещё не попали в репозиторий.
     * Отметка ставится при каждом изменении и снимается после публикации
     * или после загрузки версии из репозитория.
     */
    function hasUnpublishedEdits() {
        return Boolean(readStoredValue(KEYS.localEdits));
    }

    function markUnpublishedEdits() {
        writeStoredValue(KEYS.localEdits, state.data.updatedAt || new Date().toISOString());
    }

    function clearUnpublishedEdits() {
        writeStoredValue(KEYS.localEdits, null);
    }

    function isDirty() {
        return Boolean(state.admin && hasUnpublishedEdits());
    }

    function schedulePublish() {
        if (!sync.autoPublish || !sync.token || !sync.client) {
            return;
        }

        if (sync.timer) {
            window.clearTimeout(sync.timer);
        }

        var delay = Number(SETTINGS.autoPublishDelayMs);
        if (!Number.isFinite(delay) || delay < 0) {
            delay = 12000;
        }

        sync.timer = window.setTimeout(function () {
            sync.timer = null;
            publishNow({ silent: true });
        }, delay);
    }

    /* ================================================================== */
    /* Небольшие помощники DOM                                            */
    /* ================================================================== */

    function $(id) {
        return document.getElementById(id);
    }

    function qsa(selector) {
        return Array.prototype.slice.call(document.querySelectorAll(selector));
    }

    function esc(value) {
        return L.escapeHtml(value);
    }

    /** Иконка из инлайнового SVG-спрайта (см. index.html). */
    function icon(name, extraClass) {
        return '<svg class="icon' + (extraClass ? ' ' + extraClass : '') + '" aria-hidden="true"><use href="#i-' +
            esc(name) + '"></use></svg>';
    }

    function teamBadge(team, small) {
        if (!team) {
            return '';
        }

        return '<span class="team-badge ' + L.badgeColorForTeam(team.id) + (small ? ' team-badge-sm' : '') +
            '" aria-hidden="true">' + esc(L.getTeamInitials(team.name)) + '</span>';
    }

    /** Точки «форма» — последние результаты команды (В/Н/П). */
    function formDots(form) {
        if (!form || !form.length) {
            return '<span class="admin-muted" title="Нет завершённых матчей">—</span>';
        }

        var titles = { W: 'Победа', D: 'Ничья', L: 'Поражение' };
        var classes = { W: 'form-w', D: 'form-d', L: 'form-l' };

        return '<span class="form-row">' + form.map(function (result) {
            return '<span class="form-dot ' + classes[result] + '" title="' + esc(titles[result]) + '"></span>';
        }).join('') + '</span>';
    }

    function statusPill(match) {
        return match.finished
            ? '<span class="status-pill finished">' + icon('check') + 'Завершён</span>'
            : '<span class="status-pill upcoming">' + icon('clock') + 'Предстоит</span>';
    }

    /* ================================================================== */
    /* Уведомления и сообщения об ошибках                                 */
    /* ================================================================== */

    function toast(message, type) {
        var container = $('toast-container');

        if (!container) {
            return;
        }

        var kind = type || 'info';
        var icons = { success: 'check', error: 'alert', info: 'info' };
        var element = document.createElement('div');

        element.className = 'toast toast-' + kind;
        element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
        element.innerHTML = icon(icons[kind] || 'info') + '<span>' + esc(message) + '</span>';
        container.appendChild(element);

        window.setTimeout(function () {
            if (element.parentNode) {
                element.parentNode.removeChild(element);
            }
        }, 5000);
    }

    function setFieldError(elementId, message) {
        var element = $(elementId);

        if (element) {
            element.textContent = message || '';
        }
    }

    function showDataBanner(reason) {
        var banner = $('data-warning');

        if (!banner || !reason) {
            return;
        }

        banner.className = 'banner banner-warning mb-6';
        banner.hidden = false;
        banner.innerHTML = icon('alert') +
            '<span class="flex-1">' + esc(reason) + '</span>' +
            '<button type="button" class="btn btn-sm btn-secondary" data-action="hide-banner">Понятно</button>';
    }

    /* ================================================================== */
    /* Работа с хранилищем                                                */
    /* ================================================================== */

    function getStorage(kind) {
        try {
            return kind === 'session' ? window.sessionStorage : window.localStorage;
        } catch (error) {
            return null;
        }
    }

    /**
     * Сохранение данных + полная перерисовка + необязательное уведомление.
     * options.publish === false — данные пришли из репозитория, публиковать их не нужно.
     */
    function saveData(message, options) {
        var opts = options || {};
        var isLocalChange = opts.publish !== false;

        if (isLocalChange) {
            L.touchData(state.data);
            sync.lastAction = message || sync.lastAction;
            markUnpublishedEdits();
        }

        var result = L.saveToStorage(state.storage, state.data);
        state.storageAvailable = result.ok;
        state.dataFromStorage = true;

        if (!result.ok && result.error) {
            toast(result.error, 'error');
        }

        renderAll();
        renderSyncStatus();

        if (isLocalChange) {
            schedulePublish();
        }

        if (message) {
            toast(message, 'success');
        }

        return result.ok;
    }

    /* ================================================================== */
    /* Синхронизация с репозиторием: статус и чтение                      */
    /* ================================================================== */

    /**
     * Показывает или скрывает блок настроек публикации.
     * Блок живёт в шапке админки за кнопкой «Настройки», а короткий статус
     * публикации всегда виден рядом с ней (см. renderSyncIndicator).
     */
    function renderAdminSettings() {
        var panel = $('admin-settings');
        var button = $('admin-settings-button');

        if (panel) {
            panel.hidden = !state.settingsOpen;
        }

        if (button) {
            button.setAttribute('aria-expanded', state.settingsOpen ? 'true' : 'false');
            button.classList.toggle('btn-primary', state.settingsOpen);
            button.classList.toggle('btn-ghost', !state.settingsOpen);
        }

        if (state.settingsOpen) {
            fillSyncInputs();
        }

        // Обновляет содержимое панели и короткий статус в шапке
        renderSyncStatus();
    }

    function toggleAdminSettings() {
        state.settingsOpen = !state.settingsOpen;
        renderAdminSettings();
    }

    function openAdminSettings() {
        if (!state.settingsOpen) {
            state.settingsOpen = true;
        }

        renderAdminSettings();
    }

    /** Короткая строка о публикации в шапке админки: видна даже с закрытыми настройками. */
    function renderSyncIndicator() {
        var indicator = $('sync-indicator');

        if (!indicator) {
            return;
        }

        var text;
        var iconName = 'info';

        if (!sync.token) {
            text = 'Публикация не настроена';
            iconName = 'alert';
        } else if (sync.publishing) {
            text = 'Публикуем…';
            iconName = 'upload';
        } else if (sync.lastError) {
            text = 'Ошибка публикации';
            iconName = 'alert';
        } else if (isDirty()) {
            text = 'Есть неопубликованные изменения';
            iconName = 'alert';
        } else if (sync.publishedAt) {
            var published = new Date(sync.publishedAt);
            text = 'Опубликовано в ' + String(published.getHours()).padStart(2, '0') + ':' +
                String(published.getMinutes()).padStart(2, '0');
            iconName = 'check';
        } else {
            text = 'Готово к публикации';
        }

        indicator.innerHTML = icon(iconName) + '<span>' + esc(text) + '</span>';
        indicator.setAttribute('title', text + ' — открыть настройки публикации');
    }

    /** Строка состояния синхронизации в админке и подпись «данные обновлены» в подвале. */
    function renderSyncStatus() {
        var freshness = $('data-freshness');
        var statusElement = $('sync-status');
        var restoreButton = $('github-restore');
        var updatedLabel = state.data.updatedAt ? L.formatDateTime(state.data.updatedAt) : '';

        if (freshness) {
            freshness.textContent = updatedLabel
                ? 'Данные обновлены: ' + updatedLabel + (sync.lastPullError ? ' (нет связи с репозиторием)' : '')
                : '';
        }

        if (restoreButton) {
            restoreButton.hidden = !hasLocalBackup();
        }

        if (!statusElement) {
            return;
        }

        var parts = [];

        if (!sync.token) {
            parts.push('Токен не задан — изменения видны только на этом устройстве.');
        } else if (sync.publishing) {
            parts.push('Публикуем изменения…');
        } else if (sync.lastError) {
            parts.push('Не удалось опубликовать: ' + sync.lastError + '.');
        } else if (isDirty()) {
            parts.push(sync.autoPublish
                ? 'Есть неопубликованные изменения: публикация произойдёт автоматически.'
                : 'Есть неопубликованные изменения — нажмите «Опубликовать сейчас».');
        } else if (sync.publishedAt) {
            parts.push('Опубликовано: ' + L.formatDateTime(sync.publishedAt) + '.');
        } else {
            parts.push('Всё готово к публикации.');
        }

        if (!sync.lastError && updatedLabel) {
            parts.push('Версия данных: ' + updatedLabel + '.');
        }

        if (sync.lastPullError) {
            parts.push('Чтение из репозитория: ' + sync.lastPullError + '.');
        }

        statusElement.innerHTML = esc(parts.join(' ')) +
            (sync.lastCommitUrl
                ? ' <a class="underline hover:text-white" href="' + esc(sync.lastCommitUrl) +
                    '" target="_blank" rel="noopener noreferrer">Открыть коммит</a>'
                : '');

        renderSyncIndicator();
    }

    /** Заполняет поля блока «Публикация» текущими настройками (токен в разметку не подставляем). */
    function fillSyncInputs() {
        var checkbox = $('github-auto');
        var tokenInput = $('github-token');

        if (checkbox) {
            checkbox.checked = sync.autoPublish;
        }

        if (tokenInput) {
            tokenInput.value = '';
            tokenInput.placeholder = sync.token
                ? 'Токен сохранён — введите новый, чтобы заменить'
                : 'github_pat_…';
        }
    }

    /* --- Резервная копия перед заменой данных версией из репозитория --- */

    function saveLocalBackup(data) {
        try {
            writeStoredValue(KEYS.localBackup, JSON.stringify(data));
            return true;
        } catch (error) {
            return false;
        }
    }

    function hasLocalBackup() {
        return Boolean(readStoredValue(KEYS.localBackup));
    }

    /** Возвращает данные из резервной копии (если она есть) как локальные изменения. */
    function restoreLocalBackup() {
        var raw = readStoredValue(KEYS.localBackup);

        if (!raw) {
            toast('Резервной копии нет', 'error');
            return;
        }

        var parsed = L.parseImport(raw);

        if (!parsed.ok) {
            toast('Не удалось прочитать резервную копию: ' + parsed.error, 'error');
            return;
        }

        if (!askConfirm('Вернуть данные из резервной копии (' + L.formatDateTime(parsed.data.updatedAt) + ')?\n' +
                'Текущие данные будут заменены. После проверки нажмите «Опубликовать сейчас».')) {
            return;
        }

        state.data = parsed.data;
        L.touchData(state.data); // чтобы копия считалась новым изменением и её можно было опубликовать
        saveData('Данные восстановлены из резервной копии');
    }

    /**
     * Чтение данных из репозитория и обновление страницы.
     *
     * Данные репозитория считаются главными, но если на устройстве администратора есть
     * отличающиеся данные, приложение сначала спросит и сохранит копию — потерять правки нельзя.
     */
    function pullFromRepository(options) {
        var opts = options || {};

        if (!sync.client) {
            return Promise.resolve({ ok: false, error: 'Синхронизация недоступна' });
        }

        return sync.client.pull(Date.now()).then(function (result) {
            if (!result.ok) {
                sync.lastPullError = result.error;
                sync.pullCompleted = true;
                renderSyncStatus();

                if (opts.verbose) {
                    toast('Не удалось получить данные из репозитория: ' + result.error, 'error');
                }

                return result;
            }

            sync.lastPullError = '';
            sync.pullCompleted = true;

            // Данные уже совпадают — ничего не меняем
            if (S.documentsEqual(state.data, result.data)) {
                sync.publishedAt = result.data.updatedAt || sync.publishedAt;
                sync.lastError = '';
                clearUnpublishedEdits();
                writeStoredValue(KEYS.publishedAt, sync.publishedAt);
                renderSyncStatus();

                if (opts.verbose) {
                    toast('Данные уже совпадают с версией в репозитории', 'info');
                }

                return result;
            }

            // Фоновые обновления не трогают неопубликованные правки
            var localTime = S.timestampOf(state.data);
            var remoteTime = S.timestampOf(result.data);

            // Данные считаются «работой пользователя», если на устройстве есть отметка
            // о неопубликованных правках либо из хранилища загружена версия новее репозитория.
            // Только что созданные демонстрационные данные к таким не относятся.
            var localNewer = localTime > remoteTime;
            var localIsWork = hasUnpublishedEdits() || (state.dataFromStorage && localNewer);

            // 1. На устройстве есть неопубликованная работа — фоновая синхронизация её не трогает
            if (localIsWork && !opts.force) {
                renderSyncStatus();
                return result;
            }

            // 2. Пользователь сам просит «забрать из репозитория»: если есть работа,
            //    сначала спрашиваем и сохраняем копию
            if (localIsWork && !opts.confirmed &&
                !askConfirm('На этом устройстве есть данные, которых нет в репозитории' +
                    (hasUnpublishedEdits() ? ' (похоже, они ещё не опубликованы)' : '') + '.\n' +
                    'Заменить их версией из репозитория (от ' + L.formatDateTime(result.data.updatedAt) + ')?\n' +
                    'Копия текущих данных будет сохранена: её можно вернуть кнопкой «Восстановить копию».')) {
                renderSyncStatus();

                if (opts.verbose) {
                    toast('Данные оставлены без изменений — их можно опубликовать кнопкой «Опубликовать сейчас»', 'info');
                }

                return result;
            }

            // 3. Остальные случаи (устаревшая копия, первый визит) — спокойно заменяем
            var backupSaved = state.admin && localIsWork ? saveLocalBackup(state.data) : false;

            state.data = result.data;
            state.dataFromStorage = true;
            clearUnpublishedEdits();
            sync.publishedAt = result.data.updatedAt || '';
            sync.lastError = '';
            writeStoredValue(KEYS.publishedAt, sync.publishedAt);
            saveData('', { publish: false });

            if (opts.verbose) {
                toast('Данные загружены из репозитория (версия от ' + L.formatDateTime(result.data.updatedAt) + ')' +
                    (backupSaved ? '. Копия прежних данных сохранена' : ''), 'success');
            }

            return result;
        });
    }

    /** Публикация данных в репозиторий. */
    function publishNow(options) {
        var opts = options || {};

        if (!sync.client) {
            return Promise.resolve({ ok: false, error: 'Синхронизация недоступна' });
        }

        if (sync.publishing) {
            return Promise.resolve({ ok: false, error: 'Публикация уже выполняется' });
        }

        if (!sync.token) {
            toast('Сначала введите и сохраните токен GitHub', 'error');
            return Promise.resolve({ ok: false, error: 'Не задан токен' });
        }

        sync.publishing = true;
        sync.lastError = '';
        renderSyncStatus();

        return sync.client.checkAccess()
            .then(function (access) {
                if (!access.ok) {
                    return { ok: false, error: access.error };
                }

                sync.sha = access.sha;

                // Файла в репозитории ещё нет — просто создаём его
                if (!access.exists || !access.data) {
                    return sync.client.publish(state.data, sync.sha, S.commitMessage(sync.lastAction));
                }

                // Данные уже совпадают с репозиторием — публиковать нечего (частая ситуация
                // после авто-публикации или повторного нажатия кнопки, и это не ошибка)
                if (S.documentsEqual(state.data, access.data)) {
                    return { ok: true, unchanged: true, sha: access.sha };
                }

                var localTime = S.timestampOf(state.data);
                var remoteTime = S.timestampOf(access.data);

                // С этого устройства ещё не публиковали: нет базовой версии для сравнения
                if (!sync.publishedAt) {
                    return {
                        ok: false,
                        stale: true,
                        error: 'с этого устройства данные ещё не публиковались. ' +
                            'Нажмите «Забрать из репозитория», чтобы получить текущую версию, ' +
                            'и повторите изменения'
                    };
                }

                // В репозитории более новая версия — публикация остановлена
                if (localTime < remoteTime) {
                    return {
                        ok: false,
                        stale: true,
                        error: 'в репозитории версия новее вашей (от ' + L.formatDateTime(access.data.updatedAt) +
                            '). Нажмите «Забрать из репозитория», проверьте данные и повторите публикацию'
                    };
                }

                // Одинаковое время, но разное содержимое: спрашиваем, что важнее
                if (localTime === remoteTime &&
                    !askConfirm('В репозитории версия с тем же временем, но другим содержимым.\n' +
                        'Опубликовать вашу версию поверх?')) {
                    return {
                        ok: false,
                        error: 'публикация отменена: сначала проверьте данные кнопкой «Забрать из репозитория»'
                    };
                }

                return sync.client.publish(state.data, sync.sha, S.commitMessage(sync.lastAction));
            })
            .then(function (result) {
                sync.publishing = false;

                if (result && result.ok) {
                    // Публикация прошла (или публиковать было нечего): отложенная
                    // авто-публикация больше не нужна
                    if (sync.timer) {
                        window.clearTimeout(sync.timer);
                        sync.timer = null;
                    }

                    sync.sha = result.sha || sync.sha;
                    sync.publishedAt = state.data.updatedAt;
                    sync.lastError = '';
                    clearUnpublishedEdits();
                    writeStoredValue(KEYS.publishedAt, sync.publishedAt);

                    if (result.unchanged) {
                        renderSyncStatus();

                        if (!opts.silent) {
                            toast('Изменений нет: данные в репозитории уже совпадают', 'info');
                        }
                    } else {
                        sync.lastCommitUrl = result.htmlUrl || sync.lastCommitUrl;
                        renderSyncStatus();

                        if (!opts.silent) {
                            toast('Результаты опубликованы — их увидят все устройства', 'success');
                        }
                    }
                } else {
                    sync.lastError = (result && result.error) || 'не удалось опубликовать данные';
                    renderSyncStatus();
                    toast('Публикация не выполнена: ' + sync.lastError, 'error');
                }

                return result;
            });
    }

    /** Автообновление данных у зрителей (и у админа, если нет неопубликованных правок). */
    function startRefreshTimer() {
        var interval = Number(SETTINGS.refreshIntervalMs);

        if (!Number.isFinite(interval) || interval <= 0) {
            return;
        }

        sync.refreshTimer = window.setInterval(function () {
            if (document.visibilityState === 'hidden') {
                return; // не тратим запросы, пока вкладка не видна
            }

            pullFromRepository();
        }, interval);

        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible' && !sync.timer) {
                pullFromRepository();
            }
        });
    }

    /* ================================================================== */
    /* Действия администратора в блоке «Публикация»                       */
    /* ================================================================== */

    function saveTokenFromInput() {
        var input = $('github-token');
        var value = input ? String(input.value).trim() : '';

        if (!value) {
            toast('Вставьте токен GitHub в поле и нажмите «Сохранить токен»', 'error');
            return;
        }

        sync.token = value;
        writeStoredValue(KEYS.token, value);

        if (input) {
            input.value = '';
        }

        // При первом сохранении токена включаем авто-публикацию
        if (readStoredValue(KEYS.autoPublish) === null) {
            sync.autoPublish = true;
            writeStoredValue(KEYS.autoPublish, '1');
        }

        fillSyncInputs();
        renderSyncStatus();
        toast('Токен сохранён на этом устройстве', 'success');

        sync.client.checkAccess().then(function (access) {
            if (!access.ok) {
                sync.lastError = access.error;
                renderSyncStatus();
                toast(access.error, 'error');
                return;
            }

            sync.sha = access.sha;
            sync.lastError = '';
            renderSyncStatus();
            toast(access.exists
                ? 'Доступ к репозиторию есть'
                : 'Доступ есть: файл данных появится при первой публикации', 'success');
        });
    }

    function forgetToken() {
        sync.token = '';
        sync.sha = null;
        sync.lastError = '';
        sync.publishedAt = '';
        writeStoredValue(KEYS.token, null);
        writeStoredValue(KEYS.publishedAt, null);
        fillSyncInputs();
        renderSyncStatus();
        toast('Токен удалён с этого устройства', 'info');
    }

    function checkRepositoryAccess() {
        if (!sync.client) {
            return;
        }

        if (!sync.token) {
            toast('Сначала сохраните токен GitHub', 'error');
            return;
        }

        sync.client.checkAccess().then(function (access) {
            if (!access.ok) {
                sync.lastError = access.error;
                renderSyncStatus();
                toast(access.error, 'error');
                return;
            }

            sync.sha = access.sha;
            sync.lastError = '';
            renderSyncStatus();
            toast(access.exists
                ? 'Доступ к репозиторию есть, файл данных найден'
                : 'Доступ есть: файл данных будет создан при первой публикации', 'success');
        });
    }

    /** Ручное обновление данных из репозитория (кнопки «Обновить данные» и «Забрать из репозитория»). */
    function refreshDataFromRepository() {
        // Если данные отличаются, приложение само спросит подтверждение и сохранит копию
        pullFromRepository({ verbose: true, force: true });
    }

    /* ================================================================== */
    /* Публичные страницы                                                 */
    /* ================================================================== */

    function renderHome() {
        var stats = L.getStats(state.data);
        var finished = L.sortMatches(state.data.matches.filter(L.isFinished), 'desc');
        var upcoming = L.sortMatches(state.data.matches.filter(function (match) {
            return !L.isFinished(match);
        }), 'asc');

        $('stat-teams').textContent = stats.teams;
        $('stat-matches').textContent = stats.matches;
        $('stat-players').textContent = stats.players;
        $('stat-finished').textContent = stats.finished;

        $('latest-results').innerHTML = finished.slice(0, CONFIG.recentMatches).map(matchCard).join('') ||
            '<p class="empty-state">Завершённых матчей пока нет</p>';

        $('upcoming-matches').innerHTML = upcoming.slice(0, CONFIG.recentMatches).map(matchCard).join('') ||
            '<p class="empty-state">Предстоящих матчей нет</p>';
    }

    /** Карточка матча для публичных списков. */
    function matchCard(match) {
        var teamA = L.findTeam(state.data.teams, match.teamA);
        var teamB = L.findTeam(state.data.teams, match.teamB);

        return '' +
            '<article class="match-card ' + (match.finished ? 'finished' : 'upcoming') + '">' +
                '<div class="flex items-center gap-3">' +
                    '<div class="flex items-center gap-2 flex-1 min-w-0">' +
                        teamBadge(teamA, true) +
                        '<span class="font-medium truncate">' + esc(teamA ? teamA.name : 'Команда удалена') + '</span>' +
                    '</div>' +
                    '<div class="px-2 text-center">' +
                        (match.finished
                            ? '<span class="score-display">' + match.scoreA + ' : ' + match.scoreB + '</span>'
                            : '<span class="text-dark-500 text-sm">против</span>') +
                    '</div>' +
                    '<div class="flex items-center gap-2 flex-1 min-w-0 justify-end">' +
                        '<span class="font-medium truncate text-right">' + esc(teamB ? teamB.name : 'Команда удалена') + '</span>' +
                        teamBadge(teamB, true) +
                    '</div>' +
                '</div>' +
                '<div class="mt-2 text-xs text-dark-600 flex flex-wrap items-center gap-3">' +
                    '<span class="inline-flex items-center gap-1">' + icon('calendar') + esc(L.formatDate(match.date, 'long')) + '</span>' +
                    statusPill(match) +
                '</div>' +
            '</article>';
    }

    function renderStandings() {
        var standings = L.computeStandings(state.data.teams, state.data.matches);

        $('standings-body').innerHTML = standings.map(function (row) {
            var rowClass = row.place === 1 ? 'bg-amber-50' : (row.place <= 3 ? 'bg-primary-50' : '');
            var diffClass = row.goalDiff > 0 ? 'text-green-700' : (row.goalDiff < 0 ? 'text-red-700' : '');

            return '' +
                '<tr class="' + rowClass + '">' +
                    '<td class="num font-medium text-dark-600">' + row.place + '</td>' +
                    '<td>' +
                        '<div class="flex items-center gap-3">' +
                            teamBadge({ id: row.id, name: row.name }, true) +
                            '<span class="font-medium">' + esc(row.name) + '</span>' +
                        '</div>' +
                    '</td>' +
                    '<td class="num">' + row.played + '</td>' +
                    '<td class="num text-green-700">' + row.wins + '</td>' +
                    '<td class="num">' + row.draws + '</td>' +
                    '<td class="num text-red-700">' + row.losses + '</td>' +
                    '<td class="num">' + row.goalsFor + '–' + row.goalsAgainst + '</td>' +
                    '<td class="num font-medium ' + diffClass + '">' + (row.goalDiff > 0 ? '+' : '') + row.goalDiff + '</td>' +
                    '<td class="num">' + formDots(row.form) + '</td>' +
                    '<td class="num font-bold text-primary-900">' + row.points + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderTeams() {
        var searchInput = $('team-search');
        var query = (searchInput ? searchInput.value : '').trim().toLowerCase();
        var standings = L.computeStandings(state.data.teams, state.data.matches);
        var byId = {};

        standings.forEach(function (row) {
            byId[row.id] = row;
        });

        var teams = state.data.teams.filter(function (team) {
            return !query || String(team.name).toLowerCase().indexOf(query) !== -1;
        });

        if (!teams.length) {
            $('teams-grid').innerHTML = '<p class="empty-state card md:col-span-2 lg:col-span-3">' +
                (state.data.teams.length ? 'Команды не найдены' : 'Команды ещё не добавлены') + '</p>';
            return;
        }

        $('teams-grid').innerHTML = teams.map(function (team) {
            var row = byId[team.id] || { points: 0, played: 0, place: '—' };
            var players = (team.players || []).length
                ? team.players.map(function (player) {
                    return '<span class="chip">' + esc(player) + '</span>';
                }).join('')
                : '<span class="text-dark-500 text-xs">Состав не заполнен</span>';

            return '' +
                '<article class="card p-4">' +
                    '<div class="flex items-center gap-3 mb-3">' +
                        teamBadge(team) +
                        '<div class="min-w-0">' +
                            '<h3 class="font-bold text-lg truncate">' + esc(team.name) + '</h3>' +
                            '<p class="text-xs text-dark-600">Место: ' + row.place + ' · Очки: ' + row.points +
                                ' · Игры: ' + row.played + '</p>' +
                        '</div>' +
                    '</div>' +
                    '<div class="border-t border-dark-200 pt-3">' +
                        '<p class="text-xs text-dark-500 uppercase mb-2">Игроки (' + (team.players || []).length + ')</p>' +
                        '<div class="flex flex-wrap gap-2">' + players + '</div>' +
                    '</div>' +
                '</article>';
        }).join('');
    }

    function renderMatches() {
        var list = L.selectMatches(state.data.matches, state.matchesFilter);

        qsa('[data-filter]').forEach(function (button) {
            button.classList.toggle('is-active', button.getAttribute('data-filter') === state.matchesFilter);
        });

        $('matches-list').innerHTML = list.map(matchCard).join('') ||
            '<p class="empty-state card">' +
                (state.data.matches.length ? 'По этому фильтру матчей нет' : 'Матчи ещё не добавлены') +
            '</p>';
    }

    /** Полная перерисовка всех страниц (публичных и админских). */
    function renderAll() {
        renderHome();
        renderStandings();
        renderTeams();
        renderMatches();
        renderAdmin();
    }

    /* ================================================================== */
    /* Админ-панель: сводка, команды, матчи, игроки                       */
    /* ================================================================== */

    function renderAdmin() {
        renderAdminSummary();
        renderAdminTeams();
        renderAdminMatches();
        renderAdminPlayers();
        fillAdminSelects();
    }

    /** Сводные карточки админки. */
    function renderAdminSummary() {
        var container = $('admin-summary');

        if (!container) {
            return;
        }

        var stats = L.getStats(state.data);

        container.innerHTML = [
            { label: 'Команд', value: stats.teams },
            { label: 'Матчей', value: stats.matches },
            { label: 'Игроков', value: stats.players },
            { label: 'Завершено', value: stats.finished },
            { label: 'Голов', value: stats.goals }
        ].map(function (item) {
            return '<div class="admin-card text-center">' +
                '<div class="text-2xl font-bold text-white">' + item.value + '</div>' +
                '<div class="admin-hint uppercase tracking-wide mt-1">' + esc(item.label) + '</div>' +
            '</div>';
        }).join('');
    }

    /** Таблица команд с возможностью переименования и удаления. */
    function renderAdminTeams() {
        var body = $('admin-teams-body');

        if (!body) {
            return;
        }

        if (!state.data.teams.length) {
            body.innerHTML = '<tr><td colspan="4" class="admin-hint py-6 text-center">Команды ещё не добавлены</td></tr>';
            return;
        }

        body.innerHTML = state.data.teams.map(function (team) {
            var isEditing = state.editingTeamId === team.id;
            var nameCell = isEditing
                ? '<input type="text" id="team-rename-input" class="admin-input" maxlength="' + CONFIG.maxTeamNameLength +
                    '" value="' + esc(team.name) + '" aria-label="Новое название команды">'
                : '<div class="flex items-center gap-3">' + teamBadge(team, true) +
                    '<span class="font-medium">' + esc(team.name) + '</span></div>';

            var actions = isEditing
                ? '<div class="flex flex-wrap gap-2">' +
                    '<button type="button" class="btn btn-sm btn-primary" data-action="team-save" data-id="' + team.id + '">' +
                        icon('check') + 'Сохранить</button>' +
                    '<button type="button" class="btn btn-sm btn-ghost" data-action="team-cancel-edit" data-id="' + team.id + '">Отмена</button>' +
                  '</div>'
                : '<div class="flex flex-wrap gap-2">' +
                    '<button type="button" class="btn btn-sm btn-ghost" data-action="team-rename" data-id="' + team.id + '">' +
                        icon('pencil') + 'Изменить</button>' +
                    '<button type="button" class="btn btn-sm btn-danger" data-action="team-delete" data-id="' + team.id + '">' +
                        icon('trash') + 'Удалить</button>' +
                  '</div>';

            var matchesCount = state.data.matches.filter(function (match) {
                return match.teamA === team.id || match.teamB === team.id;
            }).length;

            return '<tr>' +
                '<td>' + nameCell + '</td>' +
                '<td class="num">' + (team.players || []).length + '</td>' +
                '<td class="num">' + matchesCount + '</td>' +
                '<td>' + actions + '</td>' +
            '</tr>';
        }).join('');
    }

    /** Таблица матчей: ввод/правка счёта, переоткрытие, редактирование, удаление. */
    function renderAdminMatches() {
        var body = $('admin-matches-body');

        if (!body) {
            return;
        }

        var matches = L.sortMatches(state.data.matches, 'desc');

        if (!matches.length) {
            body.innerHTML = '<tr><td colspan="5" class="admin-hint py-6 text-center">Матчи ещё не добавлены</td></tr>';
            return;
        }

        body.innerHTML = matches.map(function (match) {
            var teamA = L.getTeamName(state.data.teams, match.teamA);
            var teamB = L.getTeamName(state.data.teams, match.teamB);

            return '<tr>' +
                '<td class="whitespace-nowrap">' + esc(L.formatDate(match.date, 'numeric')) + '</td>' +
                '<td>' + esc(teamA) + ' — ' + esc(teamB) + '</td>' +
                '<td class="num">' +
                    '<div class="inline-flex items-center gap-1">' +
                        '<input type="number" min="0" max="' + CONFIG.maxScore + '" step="1" class="admin-score" id="score-a-' +
                            match.id + '" value="' + (match.scoreA === null ? '' : match.scoreA) +
                            '" aria-label="Счёт команды ' + esc(teamA) + '">' +
                        '<span class="admin-muted">:</span>' +
                        '<input type="number" min="0" max="' + CONFIG.maxScore + '" step="1" class="admin-score" id="score-b-' +
                            match.id + '" value="' + (match.scoreB === null ? '' : match.scoreB) +
                            '" aria-label="Счёт команды ' + esc(teamB) + '">' +
                    '</div>' +
                '</td>' +
                '<td class="num">' + statusPill(match) + '</td>' +
                '<td>' +
                    '<div class="flex flex-wrap gap-2">' +
                        '<button type="button" class="btn btn-sm btn-primary" data-action="match-save-score" data-id="' +
                            match.id + '">' + icon('check') + 'Сохранить счёт</button>' +
                        (match.finished
                            ? '<button type="button" class="btn btn-sm btn-ghost" data-action="match-reopen" data-id="' +
                                match.id + '">' + icon('undo') + 'Переоткрыть</button>'
                            : '') +
                        '<button type="button" class="btn btn-sm btn-ghost" data-action="match-edit" data-id="' +
                            match.id + '">' + icon('pencil') + 'Изменить</button>' +
                        '<button type="button" class="btn btn-sm btn-danger" data-action="match-delete" data-id="' +
                            match.id + '">' + icon('trash') + 'Удалить</button>' +
                    '</div>' +
                '</td>' +
            '</tr>';
        }).join('');
    }

    /** Список игроков выбранной команды. */
    function renderAdminPlayers() {
        var container = $('admin-players-list');
        var select = $('player-team-select');

        if (!container || !select) {
            return;
        }

        var team = L.findTeam(state.data.teams, L.toInt(select.value));
        var title = $('admin-players-team');

        if (title) {
            title.textContent = team ? team.name : 'команда не выбрана';
        }

        if (!team) {
            container.innerHTML = state.data.teams.length
                ? '<p class="admin-hint py-4">Выберите команду, чтобы увидеть состав</p>'
                : '<p class="admin-hint py-4">Сначала добавьте хотя бы одну команду</p>';
            return;
        }

        if (!team.players.length) {
            container.innerHTML = '<p class="admin-hint py-4">В команде «' + esc(team.name) + '» пока нет игроков</p>';
            return;
        }

        container.innerHTML = team.players.map(function (player, index) {
            var isEditing = !!state.editingPlayer &&
                state.editingPlayer.teamId === team.id &&
                state.editingPlayer.index === index;

            if (isEditing) {
                return '<div class="admin-card flex items-center gap-2">' +
                    '<input type="text" id="player-rename-input" class="admin-input" maxlength="' + CONFIG.maxPlayerNameLength +
                        '" value="' + esc(player) + '" aria-label="Новое имя игрока">' +
                    '<button type="button" class="btn btn-sm btn-primary" data-action="player-save" data-team="' + team.id +
                        '" data-index="' + index + '" title="Сохранить">' + icon('check') + '</button>' +
                    '<button type="button" class="btn btn-sm btn-ghost" data-action="player-cancel-edit" title="Отмена">Отмена</button>' +
                '</div>';
            }

            return '<div class="admin-card flex items-center justify-between gap-2">' +
                '<span class="truncate"><span class="admin-muted mr-2">' + (index + 1) + '.</span>' + esc(player) + '</span>' +
                '<span class="flex gap-1">' +
                    '<button type="button" class="btn btn-sm btn-ghost" data-action="player-rename" data-team="' + team.id +
                        '" data-index="' + index + '" title="Переименовать">' + icon('pencil') + '</button>' +
                    '<button type="button" class="btn btn-sm btn-danger" data-action="player-delete" data-team="' + team.id +
                        '" data-index="' + index + '" title="Удалить">' + icon('trash') + '</button>' +
                '</span>' +
            '</div>';
        }).join('');
    }

    /**
     * Заполняет выпадающие списки админки (команды для матчей и игроков).
     * Текущий выбор сохраняется, если команда ещё существует
     * (раньше список пересоздавался и выделение сбрасывалось).
     */
    function fillAdminSelects() {
        var options = state.data.teams.map(function (team) {
            return '<option value="' + team.id + '">' + esc(team.name) + '</option>';
        }).join('');

        ['match-team-a', 'match-team-b'].forEach(function (selectId) {
            var select = $(selectId);

            if (!select) {
                return;
            }

            var previous = select.value;

            select.innerHTML = options || '<option value="">Нет команд</option>';
            select.disabled = !state.data.teams.length;

            if (previous && L.findTeam(state.data.teams, previous)) {
                select.value = previous;
            }
        });

        var playerSelect = $('player-team-select');

        if (playerSelect) {
            var previousTeam = playerSelect.value;

            playerSelect.innerHTML = '<option value="">Выберите команду…</option>' + options;
            playerSelect.disabled = !state.data.teams.length;

            if (previousTeam && L.findTeam(state.data.teams, previousTeam)) {
                playerSelect.value = previousTeam;
            }
        }
    }

    /* ================================================================== */
    /* Роутинг и сессия администратора (хэш-адреса: #/standings и т.п.)   */
    /* ================================================================== */

    var ROUTES = { home: true, standings: true, teams: true, matches: true, admin: true };

    function parseHash() {
        var raw = String(window.location.hash || '')
            .replace(/^#\/?/, '')
            .replace(/\/+$/, '')
            .toLowerCase();

        return ROUTES[raw] ? raw : 'home';
    }

    function askConfirm(question) {
        if (typeof window.confirm !== 'function') {
            return true;
        }

        return window.confirm(question);
    }

    function findMatch(matchId) {
        var id = L.toInt(matchId);

        for (var i = 0; i < state.data.matches.length; i++) {
            if (L.toInt(state.data.matches[i].id) === id) {
                return state.data.matches[i];
            }
        }

        return null;
    }

    function readAdminSession() {
        var storage = getStorage('session');

        try {
            return !!storage && storage.getItem(CONFIG.sessionKey) === '1';
        } catch (error) {
            return false;
        }
    }

    function writeAdminSession(isAdmin) {
        var storage = getStorage('session');

        try {
            if (!storage) {
                return;
            }

            if (isAdmin) {
                storage.setItem(CONFIG.sessionKey, '1');
            } else {
                storage.removeItem(CONFIG.sessionKey);
            }
        } catch (error) {
            // приватный режим браузера — просто игнорируем
        }
    }

    function sectionForRoute(route) {
        if (route === 'admin') {
            return state.admin ? 'page-admin-dashboard' : 'page-admin-login';
        }

        return 'page-' + route;
    }

    /** Переключение страницы: активная секция, подсветка меню (в т.ч. мобильного), хэш. */
    function applyRoute(route, options) {
        var opts = options || {};
        var target = ROUTES[route] ? route : 'home';
        var sectionId = sectionForRoute(target);

        state.route = target;

        qsa('.page-section').forEach(function (section) {
            section.classList.toggle('active', section.id === sectionId);
        });

        qsa('[data-nav]').forEach(function (element) {
            var isActive = element.getAttribute('data-nav') === target;

            element.classList.toggle('active', isActive);

            if (isActive) {
                element.setAttribute('aria-current', 'page');
            } else {
                element.removeAttribute('aria-current');
            }
        });

        var menu = $('mobile-menu');

        if (menu) {
            menu.classList.add('hidden');
        }

        if (opts.updateHash !== false) {
            var hash = '#/' + target;

            if (window.location.hash !== hash) {
                window.location.hash = hash;
            }
        }

        if (opts.scroll !== false && typeof window.scrollTo === 'function') {
            window.scrollTo(0, 0);
        }

        if (target === 'admin') {
            prepareAdminPage();
        } else if (target === 'home') {
            renderHome();
        } else if (target === 'standings') {
            renderStandings();
        } else if (target === 'teams') {
            renderTeams();
        } else if (target === 'matches') {
            renderMatches();
        }
    }

    function prepareAdminPage() {
        if (!state.admin) {
            var password = $('admin-password');

            if (password) {
                password.value = '';
            }

            setFieldError('login-error', '');
            return;
        }

        renderAdmin();
        resetMatchForm();
        resetPlayerForm();
        renderAdminSettings();
    }

    function handleAdminLogin(event) {
        event.preventDefault();

        var input = $('admin-password');

        if (!L.adminPasswordMatches(input ? input.value : '')) {
            setFieldError('login-error', 'Неверный пароль');
            toast('Неверный пароль', 'error');
            return;
        }

        state.admin = true;
        writeAdminSession(true);
        setFieldError('login-error', '');

        if (input) {
            input.value = '';
        }

        applyRoute('admin');
        toast('Вы вошли в режим администратора', 'success');
    }

    function handleLogout() {
        state.admin = false;
        state.settingsOpen = false;
        state.editingTeamId = null;
        state.editingMatchId = null;
        state.editingPlayer = null;
        writeAdminSession(false);
        applyRoute('home');
        toast('Вы вышли из админ-панели', 'info');
    }

    /* ================================================================== */
    /* Формы админки: подготовка и сброс                                  */
    /* ================================================================== */

    function resetMatchForm() {
        state.editingMatchId = null;

        var title = $('match-form-title');
        var submit = $('match-submit');
        var cancel = $('match-cancel');
        var date = $('match-date');

        if (title) {
            title.textContent = 'Добавить матч';
        }

        if (submit) {
            submit.innerHTML = icon('plus') + 'Сохранить матч';
        }

        if (cancel) {
            cancel.hidden = true;
        }

        ['match-score-a', 'match-score-b'].forEach(function (id) {
            var input = $(id);

            if (input) {
                input.value = '';
            }
        });

        if (date) {
            date.value = L.todayISO();
        }

        setFieldError('match-form-error', '');
    }

    function resetPlayerForm() {
        state.editingPlayer = null;

        var input = $('new-player-name');

        if (input) {
            input.value = '';
        }

        setFieldError('player-form-error', '');
    }

    function readMatchForm() {
        var read = function (id) {
            var element = $(id);
            return element ? element.value : '';
        };

        return {
            teamA: read('match-team-a'),
            teamB: read('match-team-b'),
            scoreA: read('match-score-a'),
            scoreB: read('match-score-b'),
            date: read('match-date')
        };
    }

    /** Загружает матч в форму (режим редактирования). */
    function startMatchEdit(matchId) {
        var match = findMatch(matchId);

        if (!match) {
            toast('Матч не найден', 'error');
            return;
        }

        state.editingMatchId = match.id;

        var setValue = function (id, value) {
            var element = $(id);

            if (element) {
                element.value = value;
            }
        };

        setValue('match-team-a', String(match.teamA));
        setValue('match-team-b', String(match.teamB));
        setValue('match-date', match.date || L.todayISO());
        setValue('match-score-a', match.scoreA === null ? '' : String(match.scoreA));
        setValue('match-score-b', match.scoreB === null ? '' : String(match.scoreB));

        var title = $('match-form-title');
        var submit = $('match-submit');
        var cancel = $('match-cancel');

        if (title) {
            title.textContent = 'Изменить матч';
        }

        if (submit) {
            submit.innerHTML = icon('check') + 'Сохранить изменения';
        }

        if (cancel) {
            cancel.hidden = false;
        }

        setFieldError('match-form-error', '');

        if (typeof window.scrollTo === 'function') {
            window.scrollTo(0, 0);
        }
    }

    /* ================================================================== */
    /* Команды: добавление, переименование, удаление                      */
    /* ================================================================== */

    function handleAddTeam(event) {
        event.preventDefault();

        var input = $('new-team-name');
        var check = L.validateTeamName(input ? input.value : '', state.data.teams);

        if (!check.ok) {
            setFieldError('team-form-error', check.error);
            return;
        }

        state.data.teams.push({
            id: L.nextFreeId(state.data.teams),
            name: check.value,
            players: []
        });

        if (input) {
            input.value = '';
        }

        setFieldError('team-form-error', '');
        saveData('Команда «' + check.value + '» добавлена');
    }

    function startTeamRename(teamId) {
        state.editingTeamId = L.toInt(teamId);
        renderAdminTeams();

        var input = $('team-rename-input');

        if (input) {
            input.focus();
        }
    }

    function cancelTeamRename() {
        state.editingTeamId = null;
        renderAdminTeams();
    }

    function saveTeamRename(teamId) {
        var team = L.findTeam(state.data.teams, teamId);
        var input = $('team-rename-input');

        if (!team || !input) {
            return;
        }

        var check = L.validateTeamName(input.value, state.data.teams, { ignoreId: team.id });

        if (!check.ok) {
            toast(check.error, 'error');
            input.focus();
            return;
        }

        team.name = check.value;
        state.editingTeamId = null;
        saveData('Команда переименована');
    }

    function deleteTeam(teamId) {
        var team = L.findTeam(state.data.teams, teamId);

        if (!team) {
            return;
        }

        var related = state.data.matches.filter(function (match) {
            return match.teamA === team.id || match.teamB === team.id;
        }).length;

        var question = 'Удалить команду «' + team.name + '»?' +
            (related ? '\nВместе с ней будут удалены матчи: ' + related + '.' : '');

        if (!askConfirm(question)) {
            return;
        }

        state.data.teams = state.data.teams.filter(function (item) {
            return item.id !== team.id;
        });

        state.data.matches = state.data.matches.filter(function (match) {
            return match.teamA !== team.id && match.teamB !== team.id;
        });

        if (state.editingPlayer && state.editingPlayer.teamId === team.id) {
            state.editingPlayer = null;
        }

        saveData('Команда «' + team.name + '» удалена');
    }

    /* ================================================================== */
    /* Матчи: добавление, правка, счёт, переоткрытие, удаление            */
    /* ================================================================== */

    function handleMatchSubmit(event) {
        event.preventDefault();

        var check = L.validateMatchInput(readMatchForm(), state.data.teams);

        if (!check.ok) {
            setFieldError('match-form-error', check.error);
            return;
        }

        setFieldError('match-form-error', '');

        if (state.editingMatchId !== null) {
            var match = findMatch(state.editingMatchId);

            if (!match) {
                toast('Матч не найден', 'error');
                resetMatchForm();
                return;
            }

            match.teamA = check.match.teamA;
            match.teamB = check.match.teamB;
            match.date = check.match.date;
            match.scoreA = check.match.scoreA;
            match.scoreB = check.match.scoreB;
            match.finished = check.match.finished;

            resetMatchForm();
            saveData('Матч обновлён');
            return;
        }

        state.data.matches.push({
            id: L.nextFreeId(state.data.matches),
            teamA: check.match.teamA,
            teamB: check.match.teamB,
            date: check.match.date,
            scoreA: check.match.scoreA,
            scoreB: check.match.scoreB,
            finished: check.match.finished
        });

        resetMatchForm();
        saveData('Матч добавлен');
    }

    /**
     * Сохранение счёта прямо в строке таблицы матчей.
     * Пустые поля переводят матч в статус «предстоит» (счёт стирается).
     */
    function saveMatchScore(matchId) {
        var match = findMatch(matchId);

        if (!match) {
            toast('Матч не найден', 'error');
            return;
        }

        var scoreA = $('score-a-' + match.id);
        var scoreB = $('score-b-' + match.id);

        var check = L.validateMatchInput({
            teamA: match.teamA,
            teamB: match.teamB,
            date: match.date,
            scoreA: scoreA ? scoreA.value : '',
            scoreB: scoreB ? scoreB.value : ''
        }, state.data.teams);

        if (!check.ok) {
            toast(check.error, 'error');
            return;
        }

        match.scoreA = check.match.scoreA;
        match.scoreB = check.match.scoreB;
        match.finished = check.match.finished;

        saveData(check.match.finished
            ? 'Счёт матча сохранён'
            : 'Счёт очищен — матч снова предстоящий');
    }

    function reopenMatch(matchId) {
        var match = findMatch(matchId);

        if (!match) {
            return;
        }

        match.scoreA = null;
        match.scoreB = null;
        match.finished = false;

        saveData('Матч переоткрыт');
    }

    function deleteMatch(matchId) {
        var match = findMatch(matchId);

        if (!match) {
            return;
        }

        var question = 'Удалить матч ' + L.getTeamName(state.data.teams, match.teamA) + ' — ' +
            L.getTeamName(state.data.teams, match.teamB) + ' от ' + L.formatDate(match.date, 'numeric') + '?';

        if (!askConfirm(question)) {
            return;
        }

        state.data.matches = state.data.matches.filter(function (item) {
            return item.id !== match.id;
        });

        if (state.editingMatchId === match.id) {
            resetMatchForm();
        }

        saveData('Матч удалён');
    }

    /* ================================================================== */
    /* Игроки: добавление, переименование, удаление                       */
    /* ================================================================== */

    function handleAddPlayer(event) {
        event.preventDefault();

        var select = $('player-team-select');
        var input = $('new-player-name');
        var team = L.findTeam(state.data.teams, select ? select.value : null);

        if (!team) {
            setFieldError('player-form-error', 'Выберите команду');
            return;
        }

        var check = L.validatePlayerName(input ? input.value : '', team);

        if (!check.ok) {
            setFieldError('player-form-error', check.error);
            return;
        }

        team.players.push(check.value);

        if (input) {
            input.value = '';
        }

        setFieldError('player-form-error', '');
        saveData('Игрок добавлен в «' + team.name + '»');
    }

    function startPlayerRename(teamId, index) {
        state.editingPlayer = { teamId: L.toInt(teamId), index: L.toInt(index) };
        renderAdminPlayers();

        var input = $('player-rename-input');

        if (input) {
            input.focus();
        }
    }

    function cancelPlayerRename() {
        state.editingPlayer = null;
        renderAdminPlayers();
    }

    function savePlayerRename(teamId, index) {
        var team = L.findTeam(state.data.teams, teamId);
        var input = $('player-rename-input');

        if (!team || !input || index === null) {
            return;
        }

        var check = L.validatePlayerName(input.value, team, { ignoreIndex: index });

        if (!check.ok) {
            toast(check.error, 'error');
            input.focus();
            return;
        }

        team.players[index] = check.value;
        state.editingPlayer = null;
        saveData('Имя игрока изменено');
    }

    function deletePlayer(teamId, index) {
        var team = L.findTeam(state.data.teams, teamId);

        if (!team || index === null || !team.players[index]) {
            return;
        }

        if (!askConfirm('Удалить игрока «' + team.players[index] + '» из команды «' + team.name + '»?')) {
            return;
        }

        team.players.splice(index, 1);
        state.editingPlayer = null;
        saveData('Игрок удалён');
    }

    /* ================================================================== */
    /* Резервное копирование: сброс, экспорт и импорт JSON                */
    /* ================================================================== */

    function resetData() {
        if (!askConfirm('Вернуть демонстрационные данные?\nВсе текущие команды, матчи и игроки будут заменены.')) {
            return;
        }

        state.data = L.createDefaultData();
        state.editingTeamId = null;
        state.editingMatchId = null;
        state.editingPlayer = null;

        saveData('Загружены демонстрационные данные');
    }

    function exportData() {
        try {
            var blob = new Blob([L.serializeData(state.data)], { type: 'application/json' });
            var url = URL.createObjectURL(blob);
            var link = document.createElement('a');

            link.href = url;
            link.download = 'football-tournament-' + L.todayISO() + '.json';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            toast('Файл с данными выгружен', 'success');
        } catch (error) {
            toast('Браузер не позволил выгрузить файл — скопируйте данные вручную', 'error');
        }
    }

    function triggerImport() {
        var input = $('file-import');

        if (!input) {
            return;
        }

        input.value = '';
        input.click();
    }

    function handleImportFile(event) {
        var input = event.target;
        var file = input.files && input.files[0];

        if (!file) {
            return;
        }

        var reader = new FileReader();

        reader.onload = function () {
            applyImport(String(reader.result));
        };

        reader.onerror = function () {
            toast('Не удалось прочитать файл', 'error');
        };

        reader.readAsText(file);
    }

    /** Применяет данные из JSON-строки (используется импортом из файла). */
    function applyImport(text) {
        var result = L.parseImport(text);

        if (!result.ok) {
            toast(result.error, 'error');
            return false;
        }

        state.data = result.data;
        state.editingTeamId = null;
        state.editingMatchId = null;
        state.editingPlayer = null;

        saveData('Данные загружены из файла');

        if (result.repaired) {
            toast('Часть данных была исправлена при загрузке', 'info');
        }

        return true;
    }

    /* ================================================================== */
    /* Обработчики событий (делегирование, без inline-скриптов)           */
    /* ================================================================== */

    function handleClick(event) {
        var element = event.target && event.target.closest ? event.target.closest('[data-action]') : null;

        if (!element) {
            return;
        }

        var action = element.getAttribute('data-action');
        var id = element.getAttribute('data-id');
        var teamId = element.getAttribute('data-team');
        var index = element.hasAttribute('data-index') ? L.toInt(element.getAttribute('data-index')) : null;

        if (action === 'navigate') {
            applyRoute(element.getAttribute('data-page') || 'home');
        } else if (action === 'toggle-menu') {
            var menu = $('mobile-menu');

            if (menu) {
                menu.classList.toggle('hidden');
            }
        } else if (action === 'filter') {
            state.matchesFilter = element.getAttribute('data-filter') || 'all';
            renderMatches();
        } else if (action === 'hide-banner') {
            var banner = $('data-warning');

            if (banner) {
                banner.hidden = true;
            }
        } else if (action === 'logout') {
            handleLogout();
        } else if (action === 'reset-data') {
            resetData();
        } else if (action === 'export-data') {
            exportData();
        } else if (action === 'import-trigger') {
            triggerImport();
        } else if (action === 'team-rename') {
            startTeamRename(id);
        } else if (action === 'team-save') {
            saveTeamRename(id);
        } else if (action === 'team-cancel-edit') {
            cancelTeamRename();
        } else if (action === 'team-delete') {
            deleteTeam(id);
        } else if (action === 'match-save-score') {
            saveMatchScore(id);
        } else if (action === 'match-reopen') {
            reopenMatch(id);
        } else if (action === 'match-edit') {
            startMatchEdit(id);
        } else if (action === 'match-cancel-edit') {
            resetMatchForm();
        } else if (action === 'match-delete') {
            deleteMatch(id);
        } else if (action === 'player-rename') {
            startPlayerRename(teamId, index);
        } else if (action === 'player-save') {
            savePlayerRename(teamId, index);
        } else if (action === 'player-cancel-edit') {
            cancelPlayerRename();
        } else if (action === 'player-delete') {
            deletePlayer(teamId, index);
        } else if (action === 'github-save-token') {
            saveTokenFromInput();
        } else if (action === 'github-forget-token') {
            forgetToken();
        } else if (action === 'github-check') {
            checkRepositoryAccess();
        } else if (action === 'github-publish') {
            publishNow();
        } else if (action === 'github-pull') {
            refreshDataFromRepository();
        } else if (action === 'github-restore-backup') {
            restoreLocalBackup();
        } else if (action === 'toggle-settings') {
            toggleAdminSettings();
        } else if (action === 'open-settings') {
            openAdminSettings();
        } else if (action === 'refresh-data') {
            refreshDataFromRepository();
        }
    }

    function handleSubmit(event) {
        var form = event.target;
        var name = form && form.getAttribute ? form.getAttribute('data-form') : null;

        if (name === 'login') {
            handleAdminLogin(event);
        } else if (name === 'add-team') {
            handleAddTeam(event);
        } else if (name === 'match') {
            handleMatchSubmit(event);
        } else if (name === 'add-player') {
            handleAddPlayer(event);
        }
    }

    function handleChange(event) {
        var target = event.target;

        if (!target || !target.id) {
            return;
        }

        if (target.id === 'player-team-select') {
            state.editingPlayer = null;
            renderAdminPlayers();
        } else if (target.id === 'file-import') {
            handleImportFile(event);
        } else if (target.id === 'github-auto') {
            sync.autoPublish = Boolean(target.checked);
            writeStoredValue(KEYS.autoPublish, sync.autoPublish ? '1' : '0');
            renderSyncStatus();

            if (sync.autoPublish && isDirty()) {
                schedulePublish();
            }
        }
    }

    function handleInput(event) {
        var target = event.target;

        if (target && target.id === 'team-search') {
            renderTeams();
        }
    }

    function bindEvents() {
        document.addEventListener('click', handleClick);
        document.addEventListener('submit', handleSubmit);
        document.addEventListener('change', handleChange);
        document.addEventListener('input', handleInput);

        window.addEventListener('hashchange', function () {
            applyRoute(parseHash(), { updateHash: false, scroll: false });
        });
    }

    /* ================================================================== */
    /* Запуск приложения                                                  */
    /* ================================================================== */

    function init() {
        // Защита от повторного запуска: обработчики событий не должны дублироваться
        if (state.initialized) {
            return;
        }

        state.initialized = true;
        state.storage = getStorage('local');

        var loaded = L.loadFromStorage(state.storage);

        state.data = loaded.data;
        state.dataFromStorage = !loaded.fresh;
        state.admin = readAdminSession();
        state.storageAvailable = !!state.storage;

        readSyncSettings();
        sync.client = createSyncClient();

        // Первый запуск: сразу фиксируем демонстрационные данные в хранилище
        if (loaded.fresh) {
            L.saveToStorage(state.storage, state.data);
        }

        if (loaded.repaired) {
            showDataBanner(loaded.reason);
        }

        bindEvents();
        renderAll();
        applyRoute(parseHash(), { updateHash: false });
        fillSyncInputs();
        renderSyncStatus();

        // Подтягиваем актуальные данные турнира из репозитория
        pullFromRepository();
        startRefreshTimer();

        /* Публичный API: нужен автотестам и удобен для отладки из консоли браузера */
        window.FTApp = {
            config: CONFIG,
            navigate: applyRoute,
            getData: function () {
                return state.data;
            },
            setData: function (data) {
                state.data = data;
                saveData();
            },
            getState: function () {
                return state;
            },
            isAdmin: function () {
                return state.admin;
            },
            login: function (password) {
                if (!L.adminPasswordMatches(password)) {
                    return false;
                }

                state.admin = true;
                writeAdminSession(true);
                applyRoute('admin');
                return true;
            },
            importData: applyImport,
            render: renderAll,
            /* Синхронизация с репозиторием: используется автотестами и для отладки */
            sync: {
                pull: pullFromRepository,
                publish: publishNow,
                check: checkRepositoryAccess,
                refresh: refreshDataFromRepository,
                isDirty: isDirty,
                status: renderSyncStatus,
                state: sync
            }
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

