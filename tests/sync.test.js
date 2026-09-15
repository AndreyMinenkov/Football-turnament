/**
 * Юнит-тесты модуля синхронизации (assets/js/sync.js).
 * Запуск: npm test
 *
 * Вместо реального GitHub используется поддельный fetch — сеть не затрагивается.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../assets/js/logic.js');
const S = require('../assets/js/sync.js');

/** Ответ, ведущий себя как Response (нужны только поля, которые использует sync.js). */
function jsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(payload)
    };
}

/** Поддельный fetch: маршруты проверяются по порядку, все вызовы записываются. */
function fakeFetch(routes) {
    const calls = [];
    const impl = (url, init) => {
        calls.push({ url, init: init || {} });

        const route = routes.find((item) => item.match(url, init || {}));

        if (!route) {
            return Promise.reject(new Error('нет маршрута для ' + url));
        }

        // Как настоящий fetch — всегда возвращаем промис
        return Promise.resolve().then(() => route.reply(url, init || {}));
    };

    impl.calls = calls;
    return impl;
}

const GITHUB = {
    owner: 'AndreyMinenkov',
    repo: 'Football-turnament',
    branch: 'main',
    path: 'data.json'
};

function clientWith(fetchImpl, token) {
    return S.createClient({
        github: GITHUB,
        fetch: fetchImpl,
        getToken: () => (token === undefined ? 'test-token' : token)
    });
}

function sampleData(overrides) {
    const data = L.createDefaultData();
    data.updatedAt = '2026-09-15T10:00:00.000Z';
    data.revision = 3;
    return Object.assign(data, overrides || {});
}

test('encodeBase64Utf8 и decodeBase64Utf8: кириллица, эмодзи, переводы строк', () => {
    const samples = [
        'Спартак — ЦСКА 2:1',
        'Команда «Динамо» 📣',
        JSON.stringify({ name: 'Локомотив', players: ['Иванов А.', 'Петров П.'] }, null, 2),
        ''
    ];

    samples.forEach((sample) => {
        assert.equal(S.decodeBase64Utf8(S.encodeBase64Utf8(sample)), sample);
    });

    // GitHub отдаёт base64 с переносами строк
    const wrapped = S.encodeBase64Utf8('Динамо').replace(/(.{4})/g, '$1\n');
    assert.equal(S.decodeBase64Utf8(wrapped), 'Динамо');
});

test('адреса: raw, файл сайта и Contents API', () => {
    assert.equal(
        S.rawUrl(GITHUB, 123),
        'https://raw.githubusercontent.com/AndreyMinenkov/Football-turnament/main/data.json?v=123'
    );
    assert.equal(
        S.rawUrl(GITHUB),
        'https://raw.githubusercontent.com/AndreyMinenkov/Football-turnament/main/data.json'
    );
    assert.equal(S.localUrl(GITHUB), 'data.json');
    assert.equal(S.localUrl(GITHUB, 42), 'data.json?v=42');
    assert.equal(S.contentsUrl(GITHUB), 'https://api.github.com/repos/AndreyMinenkov/Football-turnament/contents/data.json');

    // Вложенный путь кодируется по частям
    const nested = Object.assign({}, GITHUB, { path: 'data/итоги турнира.json' });
    assert.match(S.rawUrl(nested), /%D0%B8%D1%82%D0%BE%D0%B3%D0%B8%20%D1%82%D1%83%D1%80%D0%BD%D0%B8%D1%80%D0%B0\.json$/);

    // Адреса API можно подменить (это используется в тестах)
    const custom = S.normalizeConfig({ owner: 'o', repo: 'r', apiBase: '/mock-api/', rawBase: '/mock-raw' });
    assert.equal(S.contentsUrl(custom), '/mock-api/repos/o/r/contents/data.json');
    assert.equal(S.rawUrl(custom), '/mock-raw/o/r/main/data.json');
});

test('normalizeConfig: значения по умолчанию и обрезка пробелов', () => {
    const config = S.normalizeConfig({ owner: '  user  ', repo: 'repo', branch: '', path: '' });

    assert.equal(config.owner, 'user');
    assert.equal(config.repo, 'repo');
    assert.equal(config.branch, 'main', 'пустая ветка заменяется на main');
    assert.equal(config.path, 'data.json', 'пустой путь заменяется на data.json');
    assert.equal(S.configReady(config), true);
    assert.equal(S.configReady(S.normalizeConfig({})), false, 'без owner/repo синхронизация не работает');
});

test('newest: сравнение локальной и удалённой версий', () => {
    const older = { updatedAt: '2026-09-14T10:00:00.000Z', revision: 5 };
    const newer = { updatedAt: '2026-09-15T10:00:00.000Z', revision: 4 };

    assert.equal(S.newest(older, newer).source, 'remote');
    assert.equal(S.newest(newer, older).source, 'local');
    assert.equal(S.newest(older, null).source, 'local');
    assert.equal(S.newest(null, newer).source, 'remote');

    // Одинаковое время — решает номер версии
    const sameTimeOlder = { updatedAt: '2026-09-15T10:00:00.000Z', revision: 1 };
    const sameTimeNewer = { updatedAt: '2026-09-15T10:00:00.000Z', revision: 2 };

    assert.equal(S.newest(sameTimeOlder, sameTimeNewer).source, 'remote');
    assert.equal(S.newest(sameTimeNewer, sameTimeOlder).source, 'local');
    assert.equal(S.newest(sameTimeNewer, { updatedAt: sameTimeNewer.updatedAt, revision: 2 }).source, 'local');
});

test('parseContentsResponse и buildUpdateRequest', () => {
    assert.equal(S.parseContentsResponse(null).ok, false);
    assert.equal(S.parseContentsResponse({}).ok, false);
    assert.deepEqual(S.parseContentsResponse({ sha: 'abc' }), { ok: true, sha: 'abc' });

    const data = sampleData();
    const withoutSha = S.buildUpdateRequest(GITHUB, data, null, 'Тест');

    assert.equal(withoutSha.branch, 'main');
    assert.equal(withoutSha.message, 'Тест');
    assert.equal('sha' in withoutSha, false, 'при создании файла sha не передаётся');
    assert.deepEqual(JSON.parse(S.decodeBase64Utf8(withoutSha.content)), data);

    const withSha = S.buildUpdateRequest(GITHUB, data, 'abc123');
    assert.equal(withSha.sha, 'abc123');
});

test('commitMessage и normalizeRemoteData', () => {
    assert.match(S.commitMessage('Команда добавлена'), /^Команда добавлена — данные турнира$/);
    assert.equal(S.commitMessage(''), 'Обновление данных турнира');

    assert.equal(S.normalizeRemoteData(null).ok, false);
    assert.equal(S.normalizeRemoteData('строка').ok, false);
    assert.equal(S.normalizeRemoteData({ teams: [], matches: 'нет' }).ok, false);

    const fixed = S.normalizeRemoteData({
        revision: 4,
        updatedAt: '2026-09-15T10:00:00.000Z',
        teams: [{ id: 1, name: 'A', players: [] }, { id: 1, name: 'A', players: [] }],
        matches: [{ id: 1, teamA: 1, teamB: 99, scoreA: 1, scoreB: 0, date: '2026-09-10', finished: true }]
    });

    assert.equal(fixed.ok, true);
    assert.equal(fixed.repaired, true, 'повреждённые части данных исправляются');
    assert.equal(fixed.data.teams.length, 1);
    assert.equal(fixed.data.matches.length, 0, 'матч с несуществующей командой отброшен');
    assert.equal(fixed.data.revision, 4);
});

test('createClient.pull: сначала репозиторий, затем файл сайта', async () => {
    const remote = sampleData();

    const fromRaw = await clientWith(fakeFetch([
        { match: (url) => url.includes('raw.githubusercontent.com'), reply: () => jsonResponse(200, remote) }
    ])).pull(111);

    assert.equal(fromRaw.ok, true);
    assert.equal(fromRaw.source, 'repository');
    assert.equal(fromRaw.data.revision, 3);
    assert.equal(
        fromRaw.url,
        'https://raw.githubusercontent.com/AndreyMinenkov/Football-turnament/main/data.json?v=111'
    );

    // raw недоступен → берём файл, отданный самим сайтом
    const fromSite = await clientWith(fakeFetch([
        { match: (url) => url.startsWith('https://raw.githubusercontent.com'), reply: () => jsonResponse(404, {}) },
        { match: (url) => url.startsWith('data.json'), reply: () => jsonResponse(200, remote) }
    ])).pull();

    assert.equal(fromSite.ok, true);
    assert.equal(fromSite.source, 'site');

    // оба источника недоступны
    const failure = await clientWith(fakeFetch([
        { match: (url) => url.startsWith('https://raw.githubusercontent.com'), reply: () => jsonResponse(500, {}) },
        { match: (url) => url.startsWith('data.json'), reply: () => jsonResponse(404, {}) }
    ])).pull();

    assert.equal(failure.ok, false);
    assert.equal(failure.data, null);
    assert.equal(failure.details.length, 2, 'в отчёте обе попытки');

    // неверный формат файла
    const wrongFormat = await clientWith(fakeFetch([
        { match: () => true, reply: () => jsonResponse(200, { foo: 'bar' }) }
    ])).pull();
    assert.equal(wrongFormat.ok, false);

    // полностью недоступная сеть: промис не должен «упасть»
    const offline = await clientWith(fakeFetch([
        { match: () => true, reply: () => Promise.reject(new Error('сеть недоступна')) }
    ])).pull();
    assert.equal(offline.ok, false);
});

test('createClient.pull: без настроек репозитория запросы не выполняются', async () => {
    const fetchImpl = fakeFetch([]);
    const client = S.createClient({ github: {}, fetch: fetchImpl });
    const result = await client.pull();

    assert.equal(result.ok, false);
    assert.match(result.error, /Не заданы репозиторий/);
    assert.equal(fetchImpl.calls.length, 0);
});

test('createClient.checkAccess: токен, sha и расшифрованный документ', async () => {
    const remote = sampleData();

    const okFetch = fakeFetch([
        { match: () => true, reply: () => jsonResponse(200, { sha: 'sha-1', content: S.encodeBase64Utf8(JSON.stringify(remote)) }) }
    ]);
    const access = await clientWith(okFetch).checkAccess();

    assert.equal(access.ok, true);
    assert.equal(access.exists, true);
    assert.equal(access.sha, 'sha-1');
    assert.equal(access.data.revision, 3, 'в ответе есть документ из репозитория');
    assert.match(okFetch.calls[0].url, /\/contents\/data\.json\?ref=main$/);
    assert.equal(okFetch.calls[0].init.headers['Authorization'], 'Bearer test-token');

    // Файла ещё нет — это не ошибка (он будет создан при первой публикации)
    const missing = await clientWith(fakeFetch([
        { match: () => true, reply: () => jsonResponse(404, {}) }
    ])).checkAccess();
    assert.deepEqual(
        { ok: missing.ok, exists: missing.exists, sha: missing.sha },
        { ok: true, exists: false, sha: null }
    );

    // Ошибки авторизации
    const unauthorized = await clientWith(fakeFetch([{ match: () => true, reply: () => jsonResponse(401, {}) }])).checkAccess();
    assert.match(unauthorized.error, /401/);

    const forbidden = await clientWith(fakeFetch([{ match: () => true, reply: () => jsonResponse(403, {}) }])).checkAccess();
    assert.match(forbidden.error, /Contents: Read and write/);

    // Без токена запрос не уходит вообще
    const noTokenFetch = fakeFetch([]);
    const noToken = await clientWith(noTokenFetch, '').checkAccess();
    assert.equal(noToken.ok, false);
    assert.match(noToken.error, /Введите токен/);
    assert.equal(noTokenFetch.calls.length, 0);
});

test('createClient.publish: корректный запрос к GitHub API', async () => {
    const data = sampleData();

    const fetchImpl = fakeFetch([
        {
            match: (url, init) => init.method === 'PUT',
            reply: () => jsonResponse(200, {
                content: { sha: 'sha-2' },
                commit: { html_url: 'https://github.com/AndreyMinenkov/Football-turnament/commit/abc' }
            })
        }
    ]);

    const result = await clientWith(fetchImpl).publish(data, 'sha-1', 'Тестовое изменение');

    assert.equal(result.ok, true);
    assert.equal(result.sha, 'sha-2');
    assert.equal(result.htmlUrl, 'https://github.com/AndreyMinenkov/Football-turnament/commit/abc');

    const request = fetchImpl.calls[0];
    assert.equal(request.url, 'https://api.github.com/repos/AndreyMinenkov/Football-turnament/contents/data.json');
    assert.equal(request.init.method, 'PUT');
    assert.equal(request.init.headers['Authorization'], 'Bearer test-token');
    assert.equal(request.init.headers['Accept'], 'application/vnd.github+json');
    assert.equal(request.init.headers['Content-Type'], 'application/json');

    const body = JSON.parse(request.init.body);
    assert.equal(body.sha, 'sha-1');
    assert.equal(body.branch, 'main');
    assert.equal(body.message, 'Тестовое изменение');
    assert.equal(S.decodeBase64Utf8(body.content).includes('Спартак'), true, 'данные переданы с кириллицей');
});

test('createClient.publish: конфликт в репозитории и понятные ошибки', async () => {
    const data = sampleData();

    const conflict = await clientWith(fakeFetch([
        { match: () => true, reply: () => jsonResponse(409, { message: 'sha does not match' }) }
    ])).publish(data, 'старый', 'Изменение');

    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict, true);
    assert.match(conflict.error, /Забрать из репозитория/);

    const statuses = [
        [401, /401/],
        [403, /Contents: Read and write/],
        [404, /Репозиторий или ветка не найдены/],
        [422, /отклонил запрос/],
        [500, /HTTP 500/]
    ];

    for (const [status, pattern] of statuses) {
        const result = await clientWith(fakeFetch([
            { match: () => true, reply: () => jsonResponse(status, { message: 'detail' }) }
        ])).publish(data, 'sha', 'Изменение');

        assert.equal(result.ok, false, 'код ' + status);
        assert.match(result.error, pattern, 'код ' + status);
    }

    // Без токена — понятное сообщение, без обращения к сети
    const noTokenFetch = fakeFetch([]);
    const noToken = await clientWith(noTokenFetch, '').publish(data, null, 'Изменение');
    assert.equal(noToken.ok, false);
    assert.match(noToken.error, /Введите токен/);
    assert.equal(noTokenFetch.calls.length, 0);

    // Сеть недоступна
    const offline = await clientWith(fakeFetch([
        { match: () => true, reply: () => Promise.reject(new Error('нет соединения')) }
    ])).publish(data, 'sha', 'Изменение');
    assert.equal(offline.ok, false);
    assert.match(offline.error, /Сеть недоступна/);
});
