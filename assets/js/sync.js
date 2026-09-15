/**
 * Синхронизация с репозиторием GitHub.
 *
 * Зачем: данные турнира должны быть одинаковыми на всех устройствах.
 * Файл data.json лежит в репозитории рядом с сайтом:
 *   • чтение — публичное, без ключей (raw.githubusercontent.com или сам сайт);
 *   • запись — через GitHub Contents API по токену, который хранится ТОЛЬКО
 *     в браузере администратора (в коде сайта и в репозитории его нет).
 *
 * Модуль не зависит от DOM: все сетевые вызовы идут через переданный fetch,
 * поэтому его удобно проверять тестами (см. tests/sync.test.js).
 */
(function (root, factory) {
    'use strict';

    var isNode = typeof module === 'object' && module.exports;
    var logic = isNode ? require('./logic.js') : (root && root.FTLogic);

    if (!logic) {
        throw new Error('sync.js требует подключённый logic.js (window.FTLogic)');
    }

    var api = factory(logic);

    if (isNode) {
        module.exports = api;
    }

    if (root) {
        root.FTSync = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (logic) {
    'use strict';

    var DEFAULT_GITHUB = {
        owner: '',
        repo: '',
        branch: 'main',
        path: 'data.json',
        apiBase: 'https://api.github.com',
        rawBase: 'https://raw.githubusercontent.com'
    };

    /* ------------------------------------------------------------------ */
    /* Вспомогательные функции                                            */
    /* ------------------------------------------------------------------ */

    function trimSlashes(value) {
        return String(value === null || value === undefined ? '' : value).replace(/^\/+|\/+$/g, '');
    }

    /** Убирает только замыкающие слэши (ведущий слэш нужен для относительных адресов). */
    function trimTrailingSlashes(value) {
        return String(value === null || value === undefined ? '' : value).replace(/\/+$/g, '');
    }

    /** Кодирует путь для URL, сохраняя разделители каталогов. */
    function encodePath(path) {
        return String(path)
            .split('/')
            .filter(function (part) { return part !== ''; })
            .map(encodeURIComponent)
            .join('/');
    }

    /** Настройки с значениями по умолчанию. */
    function normalizeConfig(github) {
        var source = github || {};
        var config = {};

        Object.keys(DEFAULT_GITHUB).forEach(function (key) {
            var value = source[key];
            config[key] = (value === undefined || value === null || value === '') ? DEFAULT_GITHUB[key] : String(value).trim();
        });

        return config;
    }

    /** Сравнение двух документов турнира по содержимому (ключи всегда в одном порядке). */
    function documentsEqual(a, b) {
        if (!a || !b) {
            return false;
        }

        return JSON.stringify(a) === JSON.stringify(b);
    }

    function configReady(config) {
        return Boolean(config.owner && config.repo && config.branch && config.path);
    }

    /** Адрес «сырого» файла данных: обновляется через несколько секунд после коммита. */
    function rawUrl(github, cacheBust) {
        var config = normalizeConfig(github);
        var url = trimTrailingSlashes(config.rawBase) + '/' + config.owner + '/' + config.repo + '/' +
            encodeURIComponent(config.branch) + '/' + encodePath(config.path);

        return cacheBust ? url + '?v=' + encodeURIComponent(String(cacheBust)) : url;
    }

    /** Тот же файл, но отданный самим сайтом (запасной источник; кэш GitHub Pages 10 минут). */
    function localUrl(github, cacheBust) {
        var config = normalizeConfig(github);
        return encodePath(config.path) + (cacheBust ? '?v=' + encodeURIComponent(String(cacheBust)) : '');
    }

    /** Адрес GitHub Contents API для файла с данными. */
    function contentsUrl(github) {
        var config = normalizeConfig(github);
        return trimTrailingSlashes(config.apiBase) + '/repos/' + config.owner + '/' + config.repo +
            '/contents/' + encodePath(config.path);
    }

    /* --- base64 с поддержкой UTF-8 (имена команд на кириллице) --- */

    function encodeBase64Utf8(text) {
        var binary = encodeURIComponent(String(text === null || text === undefined ? '' : text))
            .replace(/%([0-9A-F]{2})/g, function (match, hex) {
                return String.fromCharCode(parseInt(hex, 16));
            });

        return btoa(binary);
    }

    function decodeBase64Utf8(base64) {
        var binary = atob(String(base64).replace(/\s+/g, ''));
        var encoded = '';

        for (var i = 0; i < binary.length; i++) {
            encoded += '%' + ('0' + binary.charCodeAt(i).toString(16)).slice(-2);
        }

        return decodeURIComponent(encoded);
    }

    /* --- Сравнение версий данных --- */

    function timestampOf(data) {
        var parsed = Date.parse((data && data.updatedAt) || '');
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function revisionOf(data) {
        var revision = logic.toInt(data && data.revision);
        return revision === null ? 0 : revision;
    }

    /** Какие данные считать актуальнее: сравнение по updatedAt, затем по revision. */
    function newest(local, remote) {
        if (!remote) {
            return { source: 'local', data: local || null };
        }

        if (!local) {
            return { source: 'remote', data: remote };
        }

        var localTime = timestampOf(local);
        var remoteTime = timestampOf(remote);

        if (remoteTime > localTime) {
            return { source: 'remote', data: remote };
        }

        if (remoteTime < localTime) {
            return { source: 'local', data: local };
        }

        return revisionOf(remote) > revisionOf(local)
            ? { source: 'remote', data: remote }
            : { source: 'local', data: local };
    }

    /* ------------------------------------------------------------------ */
    /* Разбор ответов и подготовка запросов GitHub                        */
    /* ------------------------------------------------------------------ */

    /** Разбор ответа Contents API: нужен sha, чтобы безопасно перезаписать файл. */
    function parseContentsResponse(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return { ok: false, error: 'GitHub вернул неожиданный ответ' };
        }

        if (typeof payload.sha !== 'string' || !payload.sha) {
            return { ok: false, error: 'В ответе GitHub нет идентификатора версии файла (sha)' };
        }

        return { ok: true, sha: payload.sha };
    }

    /** Тело запроса на сохранение файла (создание, если sha ещё нет, или обновление). */
    function buildUpdateRequest(config, data, sha, message) {
        var body = {
            message: message || 'Обновление данных турнира',
            content: encodeBase64Utf8(JSON.stringify(data, null, 2)),
            branch: config.branch
        };

        if (sha) {
            body.sha = sha;
        }

        return body;
    }

    /** Текст коммита. */
    function commitMessage(action) {
        return (action ? action + ' — данные турнира' : 'Обновление данных турнира');
    }

    /** Проверка, что ответ похож на документ турнира, и приведение к корректной структуре. */
    function normalizeRemoteData(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
            !Array.isArray(payload.teams) || !Array.isArray(payload.matches)) {
            return { ok: false, error: 'Файл данных повреждён или имеет неверный формат' };
        }

        var normalized = logic.normalizeData(payload);

        return {
            ok: true,
            data: normalized.data,
            repaired: normalized.repaired,
            reason: normalized.reason
        };
    }

    /* ------------------------------------------------------------------ */
    /* Клиент синхронизации                                                */
    /* ------------------------------------------------------------------ */

    function resolveFetch(provided) {
        if (typeof provided === 'function') {
            return provided;
        }

        if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') {
            return globalThis.fetch.bind(globalThis);
        }

        return null;
    }

    /**
     * Создаёт клиент синхронизации.
     *
     * options.github   — { owner, repo, branch, path, apiBase, rawBase }
     * options.getToken — функция, возвращающая токен администратора
     * options.fetch    — реализация fetch (в тестах подменяется)
     */
    function createClient(options) {
        var settings = options || {};
        var config = normalizeConfig(settings.github);
        var fetchImpl = resolveFetch(settings.fetch);
        var getToken = settings.getToken || function () { return ''; };
        var ready = configReady(config);

        function request(url, init) {
            if (!fetchImpl) {
                return Promise.reject(new Error('fetch недоступен в этом окружении'));
            }

            return fetchImpl(url, init);
        }

        function authHeaders(token) {
            return {
                'Authorization': 'Bearer ' + token,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
            };
        }

        function readJson(response) {
            if (!response || typeof response.json !== 'function') {
                return Promise.resolve(null);
            }

            return response.json().catch(function () { return null; });
        }

        /** Чтение данных: сначала raw-адрес репозитория, затем файл самого сайта. */
        function pull(cacheBust) {
            if (!ready) {
                return Promise.resolve({ ok: false, error: 'Не заданы репозиторий, ветка или путь к файлу данных' });
            }

            var attempts = [rawUrl(config, cacheBust), localUrl(config, cacheBust)];
            var failures = [];

            function tryNext(index) {
                if (index >= attempts.length) {
                    return {
                        ok: false,
                        error: 'Не удалось получить данные из репозитория',
                        details: failures,
                        data: null
                    };
                }

                return request(attempts[index], { cache: 'no-store', headers: { 'Accept': 'application/json' } })
                    .then(function (response) {
                        if (!response || !response.ok) {
                            throw new Error('HTTP ' + (response ? response.status : '?'));
                        }

                        return response.json();
                    })
                    .then(function (payload) {
                        var normalized = normalizeRemoteData(payload);

                        if (!normalized.ok) {
                            throw new Error(normalized.error);
                        }

                        return {
                            ok: true,
                            data: normalized.data,
                            source: index === 0 ? 'repository' : 'site',
                            url: attempts[index],
                            repaired: normalized.repaired
                        };
                    })
                    .catch(function (error) {
                        failures.push(attempts[index] + ' → ' + error.message);
                        return tryNext(index + 1);
                    });
            }

            return Promise.resolve().then(function () { return tryNext(0); });
        }

        /** Проверка токена и получение sha текущего файла. */
        function checkAccess() {
            var token = String(getToken() || '').trim();

            if (!token) {
                return Promise.resolve({ ok: false, error: 'Введите токен GitHub' });
            }

            if (!ready) {
                return Promise.resolve({ ok: false, error: 'Не заданы репозиторий, ветка или путь к файлу данных' });
            }

            var url = contentsUrl(config) + '?ref=' + encodeURIComponent(config.branch);

            return request(url, { headers: authHeaders(token), cache: 'no-store' })
                .then(function (response) {
                    if (response.status === 404) {
                        return { ok: true, exists: false, sha: null };
                    }

                    if (response.status === 401) {
                        return { ok: false, error: 'GitHub не принял токен (401): проверьте, что он скопирован целиком' };
                    }

                    if (response.status === 403) {
                        return { ok: false, error: 'Нет доступа к файлу (403): нужно право Contents: Read and write' };
                    }

                    if (!response.ok) {
                        return { ok: false, error: 'GitHub вернул HTTP ' + response.status };
                    }

                    return readJson(response).then(function (payload) {
                        var parsed = parseContentsResponse(payload);

                        if (!parsed.ok) {
                            return { ok: false, error: parsed.error };
                        }

                        // Заодно возвращаем сам документ: он нужен, чтобы не затереть
                        // более свежую версию из репозитория устаревшей локальной копией.
                        var document_ = null;

                        if (typeof payload.content === 'string' && payload.content.trim()) {
                            try {
                                var decoded = JSON.parse(decodeBase64Utf8(payload.content));
                                var normalized = normalizeRemoteData(decoded);

                                if (normalized.ok) {
                                    document_ = normalized.data;
                                }
                            } catch (error) {
                                document_ = null;
                            }
                        }

                        return { ok: true, exists: true, sha: parsed.sha, data: document_ };
                    });
                })
                .catch(function (error) {
                    return { ok: false, error: 'Сеть недоступна: ' + error.message };
                });
        }

        /** Публикация данных в репозиторий (создаёт файл или обновляет его). */
        function publish(data, sha, message) {
            var token = String(getToken() || '').trim();

            if (!token) {
                return Promise.resolve({ ok: false, error: 'Введите токен GitHub в блоке «Публикация»' });
            }

            if (!ready) {
                return Promise.resolve({ ok: false, error: 'Не заданы репозиторий, ветка или путь к файлу данных' });
            }

            var body = buildUpdateRequest(config, data, sha, message);

            return request(contentsUrl(config), {
                method: 'PUT',
                headers: authHeaders(token),
                body: JSON.stringify(body)
            })
                .then(function (response) {
                    return readJson(response).then(function (payload) {
                        if (response.status === 409) {
                            return {
                                ok: false,
                                conflict: true,
                                error: 'В репозитории уже есть более новая версия файла. ' +
                                    'Нажмите «Забрать из репозитория» и повторите публикацию'
                            };
                        }

                        if (response.status === 401) {
                            return { ok: false, error: 'GitHub не принял токен (401): проверьте токен' };
                        }

                        if (response.status === 403) {
                            return { ok: false, error: 'Недостаточно прав (403): нужно право Contents: Read and write' };
                        }

                        if (response.status === 404) {
                            return { ok: false, error: 'Репозиторий или ветка не найдены (404): проверьте owner, repo и branch' };
                        }

                        if (response.status === 422) {
                            return {
                                ok: false,
                                error: 'GitHub отклонил запрос (422): ' +
                                    ((payload && payload.message) || 'проверьте ветку и путь к файлу')
                            };
                        }

                        if (!response.ok) {
                            return {
                                ok: false,
                                error: 'GitHub вернул HTTP ' + response.status +
                                    (payload && payload.message ? ': ' + payload.message : '')
                            };
                        }

                        return {
                            ok: true,
                            sha: (payload && payload.content && payload.content.sha) || null,
                            commit: (payload && payload.commit) || null,
                            htmlUrl: (payload && payload.commit && payload.commit.html_url) || null
                        };
                    });
                })
                .catch(function (error) {
                    return { ok: false, error: 'Сеть недоступна: ' + error.message };
                });
        }

        return {
            config: config,
            ready: ready,
            pull: pull,
            checkAccess: checkAccess,
            publish: publish,
            contentsUrl: contentsUrl(config),
            rawUrl: function (cacheBust) { return rawUrl(config, cacheBust); },
            localUrl: function (cacheBust) { return localUrl(config, cacheBust); }
        };
    }

    /* ------------------------------------------------------------------ */

    return {
        DEFAULT_GITHUB: DEFAULT_GITHUB,
        normalizeConfig: normalizeConfig,
        configReady: configReady,
        encodePath: encodePath,
        rawUrl: rawUrl,
        localUrl: localUrl,
        contentsUrl: contentsUrl,
        encodeBase64Utf8: encodeBase64Utf8,
        decodeBase64Utf8: decodeBase64Utf8,
        timestampOf: timestampOf,
        revisionOf: revisionOf,
        newest: newest,
        documentsEqual: documentsEqual,
        parseContentsResponse: parseContentsResponse,
        buildUpdateRequest: buildUpdateRequest,
        commitMessage: commitMessage,
        normalizeRemoteData: normalizeRemoteData,
        createClient: createClient
    };
});
