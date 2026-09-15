/**
 * DOM-тесты приложения: все страницы и админ-панель в среде jsdom.
 * Запуск: npm test
 *
 * Проверяется реальная разметка index.html + оба скрипта из assets/js.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');
const DATA_KEY = 'footballTournamentData';

const L = require('../assets/js/logic.js');
const { createMockRepository } = require('./helpers/mock-github.js');

function readSource(relativePath) {
    return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/**
 * Поднимает страницу index.html в jsdom, выполняет скрипты приложения
 * и возвращает удобные помощники для проверок.
 *
 * options.mock — макет GitHub (tests/helpers/mock-github.js); без него сеть считается недоступной.
 */
function boot(options) {
    const settings = options || {};
    const mock = settings.mock || null;
    const html = readSource('index.html');

    const dom = new JSDOM(html, {
        url: 'https://tournament.test/',
        runScripts: 'outside-only',
        pretendToBeVisual: true,
        beforeParse(window) {
            window.scrollTo = () => {};
            window.confirm = () => settings.confirm !== false;

            // Настройки и «сеть» задаются до запуска приложения
            window.FT_CONFIG = {
                github: {
                    owner: 'test',
                    repo: 'test',
                    branch: 'main',
                    path: 'data.json',
                    apiBase: '/mock-api',
                    rawBase: '/mock-raw'
                },
                refreshIntervalMs: 0, // в тестах фоновые таймеры не нужны
                autoPublishDelayMs: settings.autoPublishDelayMs === undefined ? 10 : settings.autoPublishDelayMs
            };

            window.fetch = mock
                ? mock.fetch
                : () => Promise.reject(new Error('сеть недоступна'));

            if (settings.seed) {
                Object.keys(settings.seed).forEach((key) => {
                    window.localStorage.setItem(key, settings.seed[key]);
                });
            }
        }
    });

    const { window } = dom;
    const document = window.document;

    window.eval(readSource('assets/js/config.js'));
    window.eval(readSource('assets/js/logic.js'));
    window.eval(readSource('assets/js/sync.js'));
    window.eval(readSource('assets/js/app.js'));

    if (document.readyState === 'loading') {
        document.dispatchEvent(new window.Event('DOMContentLoaded'));
    }

    function fire(type, target, init) {
        target.dispatchEvent(new window.Event(type, Object.assign({ bubbles: true, cancelable: true }, init || {})));
    }

    return {
        dom,
        window,
        document,
        mock,
        $: (selector) => document.querySelector(selector),
        $$: (selector) => Array.from(document.querySelectorAll(selector)),
        id: (elementId) => document.getElementById(elementId),
        click: (target) => fire('click', target),
        submit: (form) => fire('submit', form),
        change: (target) => fire('change', target),
        type: (input, value) => {
            input.value = value;
            fire('input', input);
        },
        /** Даёт завершиться промисам синхронизации */
        settle: () => new Promise((resolve) => window.setTimeout(resolve, 0)),
        wait: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
        /** Активная секция страницы */
        activeSection: () => {
            const active = document.querySelector('.page-section.active');
            return active ? active.id : null;
        },
        storedData: () => JSON.parse(window.localStorage.getItem(DATA_KEY)),
        navigate: (page) => {
            fire('click', document.querySelector('[data-nav="' + page + '"]'));
        },
        /** Кнопка действия (внутри контейнера или на всей странице) */
        actionButton: (action, container) => {
            const scope = container || document;
            return scope.querySelector('[data-action="' + action + '"]');
        },
        /** Вход в админку «как в жизни» — через форму */
        login: (password) => {
            fire('click', document.querySelector('[data-nav="admin"]'));
            const input = document.getElementById('admin-password');
            input.value = password === undefined ? 'admin' : password;
            fire('submit', document.querySelector('[data-form="login"]'));
        },
        /** Сохраняет токен GitHub через поле в блоке «Публикация» */
        saveToken: (token) => {
            const input = document.getElementById('github-token');
            input.value = token === undefined ? 'test-token' : token;
            fire('click', document.querySelector('[data-action="github-save-token"]'));
        },
        syncStatus: () => (document.getElementById('sync-status') || { textContent: '' }).textContent,
        freshness: () => (document.getElementById('data-freshness') || { textContent: '' }).textContent
    };
}

test('главная страница: активна только она, статистика и списки матчей заполнены', () => {
    const app = boot();

    assert.equal(app.activeSection(), 'page-home');
    assert.equal(app.id('stat-teams').textContent, '4');
    assert.equal(app.id('stat-matches').textContent, '4');
    assert.equal(app.id('stat-players').textContent, '9');
    assert.equal(app.id('stat-finished').textContent, '2');

    const latest = app.id('latest-results').querySelectorAll('.match-card');
    assert.equal(latest.length, 2, 'на главной только завершённые матчи');
    assert.match(latest[0].textContent, /Динамо/, 'сначала самый поздний матч');
    assert.equal(app.id('upcoming-matches').querySelectorAll('.match-card').length, 2);
    assert.equal(app.id('latest-results').querySelectorAll('.score-display').length, 2);

    assert.equal(app.storedData().teams.length, 4, 'демо-данные сразу попадают в хранилище');
});

test('навигация: переключение страниц, подсветка меню и хэш-адреса', () => {
    const app = boot();

    ['standings', 'teams', 'matches', 'admin', 'home'].forEach((page) => {
        app.navigate(page);

        const expected = page === 'admin' ? 'page-admin-login' : 'page-' + page;
        assert.equal(app.activeSection(), expected, 'страница ' + page);

        const buttons = app.$$('[data-nav="' + page + '"]');
        assert.equal(buttons.length, 2, 'пункт есть и в десктопном, и в мобильном меню');
        buttons.forEach((button) => {
            assert.ok(button.classList.contains('active'), 'подсвечен активный пункт меню');
            assert.equal(button.getAttribute('aria-current'), 'page');
        });

        assert.equal(app.window.location.hash, '#/' + page);
    });

    // Прямая ссылка с хэшем открывает нужную страницу
    const direct = boot();
    direct.window.location.hash = '#/teams';
    direct.window.dispatchEvent(new direct.window.Event('hashchange'));
    assert.equal(direct.activeSection(), 'page-teams');

    assert.equal(app.id('mobile-menu').classList.contains('hidden'), true, 'меню закрывается после перехода');
});

test('турнирная таблица: места, очки, разница мячей и форма', () => {
    const app = boot();

    app.navigate('standings');

    const rows = Array.from(app.id('standings-body').querySelectorAll('tr'));
    assert.equal(rows.length, 4);

    const cells = (row) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent.trim());
    const teamOf = (row) => {
        const badge = row.querySelector('.team-badge');
        return { badge: badge.textContent.trim(), name: badge.nextElementSibling.textContent.trim() };
    };

    assert.equal(cells(rows[0])[0], '1', 'место в первом столбце');
    assert.deepEqual(teamOf(rows[0]), { badge: 'СП', name: 'Спартак' });
    assert.deepEqual(cells(rows[0]).slice(2, 8), ['1', '1', '0', '0', '2–1', '+1'], 'И, В, Н, П, мячи, РМ');
    assert.equal(cells(rows[0])[9], '3', 'очки лидера');

    assert.equal(teamOf(rows[1]).name, 'Динамо');
    assert.equal(cells(rows[1])[9], '1');
    assert.equal(teamOf(rows[3]).name, 'Локомотив');
    assert.equal(cells(rows[3])[9], '0');

    assert.equal(rows[0].querySelectorAll('.form-dot').length, 1, 'форма команды показана точками');
});

test('команды: карточки, поиск и состав', () => {
    const app = boot();

    app.navigate('teams');
    assert.equal(app.$$('#teams-grid article').length, 4);
    assert.match(app.id('teams-grid').textContent, /Иванов А\./);
    assert.match(app.id('teams-grid').textContent, /Место: 1/);

    app.type(app.id('team-search'), 'спар');
    assert.equal(app.$$('#teams-grid article').length, 1);
    assert.match(app.id('teams-grid').textContent, /Спартак/);

    app.type(app.id('team-search'), 'такой команды нет');
    assert.match(app.id('teams-grid').textContent, /Команды не найдены/);

    app.type(app.id('team-search'), '');
    assert.equal(app.$$('#teams-grid article').length, 4);
});

test('матчи: фильтры «все», «завершённые», «предстоящие»', () => {
    const app = boot();

    app.navigate('matches');
    assert.equal(app.$$('#matches-list .match-card').length, 4);

    const finishedButton = app.$('[data-filter="finished"]');
    app.click(finishedButton);
    assert.equal(app.$$('#matches-list .match-card').length, 2);
    assert.ok(finishedButton.classList.contains('is-active'));
    assert.equal(app.id('matches-list').querySelectorAll('.status-pill.finished').length, 2);

    app.click(app.$('[data-filter="upcoming"]'));
    assert.equal(app.$$('#matches-list .match-card').length, 2);
    assert.equal(app.id('matches-list').querySelectorAll('.status-pill.upcoming').length, 2);

    app.click(app.$('[data-filter="all"]'));
    assert.equal(app.$$('#matches-list .match-card').length, 4);
});

test('админка: вход только по паролю, сессия сохраняется, выход работает', () => {
    const app = boot();

    app.navigate('admin');
    assert.equal(app.activeSection(), 'page-admin-login', 'без пароля видна форма входа');

    app.login('неверный');
    assert.equal(app.id('login-error').textContent, 'Неверный пароль');
    assert.equal(app.activeSection(), 'page-admin-login');
    assert.equal(app.window.FTApp.isAdmin(), false);

    app.login('admin');
    assert.equal(app.id('login-error').textContent, '');
    assert.equal(app.activeSection(), 'page-admin-dashboard');
    assert.equal(app.window.FTApp.isAdmin(), true);
    assert.equal(app.id('admin-password').value, '', 'пароль не остаётся в поле');

    app.navigate('home');
    app.navigate('admin');
    assert.equal(app.activeSection(), 'page-admin-dashboard', 'повторный вход не требуется');
    assert.equal(app.window.sessionStorage.getItem('footballTournamentAdmin'), '1');

    app.click(app.actionButton('logout'));
    assert.equal(app.activeSection(), 'page-home');
    assert.equal(app.window.FTApp.isAdmin(), false);

    app.navigate('admin');
    assert.equal(app.activeSection(), 'page-admin-login', 'после выхода нужен пароль снова');
});

test('админка: добавление, переименование и удаление команд', () => {
    const app = boot();
    app.login();

    assert.equal(app.id('admin-teams-body').querySelectorAll('tr').length, 4);

    // Добавление (пробелы лишние убираются)
    app.type(app.id('new-team-name'), '  Зенит  ');
    app.submit(app.$('[data-form="add-team"]'));
    assert.equal(app.storedData().teams.length, 5);
    assert.equal(app.id('admin-teams-body').querySelectorAll('tr').length, 5);
    assert.match(app.id('admin-teams-body').textContent, /Зенит/);
    assert.equal(app.id('new-team-name').value, '');
    assert.equal(app.id('team-form-error').textContent, '');
    assert.equal(app.id('stat-teams').textContent, '5', 'публичная статистика обновилась');

    // Дубликат в другом регистре
    app.type(app.id('new-team-name'), 'зенит');
    app.submit(app.$('[data-form="add-team"]'));
    assert.match(app.id('team-form-error').textContent, /уже есть/);
    assert.equal(app.storedData().teams.length, 5);

    // Пустое название
    app.type(app.id('new-team-name'), '   ');
    app.submit(app.$('[data-form="add-team"]'));
    assert.match(app.id('team-form-error').textContent, /Введите название/);

    const teamRow = (name) => Array.from(app.id('admin-teams-body').querySelectorAll('tr'))
        .find((row) => row.textContent.includes(name));

    // Переименование
    app.click(teamRow('Зенит').querySelector('[data-action="team-rename"]'));
    assert.ok(app.id('team-rename-input'), 'появилось поле переименования');
    app.type(app.id('team-rename-input'), 'Зенит СПб');
    app.click(app.id('admin-teams-body').querySelector('[data-action="team-save"]'));
    assert.equal(app.id('team-rename-input'), null, 'режим правки закрылся');
    assert.ok(app.storedData().teams.some((team) => team.name === 'Зенит СПб'));

    // Отмена переименования ничего не меняет
    app.click(teamRow('Зенит СПб').querySelector('[data-action="team-rename"]'));
    app.id('team-rename-input').value = 'Не должно сохраниться';
    app.click(app.id('admin-teams-body').querySelector('[data-action="team-cancel-edit"]'));
    assert.equal(app.storedData().teams.filter((team) => team.name === 'Не должно сохраниться').length, 0);

    // Удаление: команда удаляется вместе со своими матчами
    const before = app.storedData();
    assert.equal(before.matches.length, 4);
    app.click(teamRow('Спартак').querySelector('[data-action="team-delete"]'));

    const after = app.storedData();
    assert.equal(after.teams.length, 4);
    assert.equal(after.teams.some((team) => team.name === 'Спартак'), false);
    assert.equal(after.matches.length, 2, 'матчи удалённой команды тоже удалены');
    assert.ok(after.matches.every((match) => match.teamA !== 1 && match.teamB !== 1));
});

test('админка: отказ от подтверждения отменяет удаление', () => {
    const app = boot({ confirm: false });
    app.login();

    const firstRow = app.id('admin-teams-body').querySelector('tr');
    app.click(firstRow.querySelector('[data-action="team-delete"]'));
    assert.equal(app.storedData().teams.length, 4, 'данные не изменились');

    const matchRow = app.id('admin-matches-body').querySelector('tr');
    app.click(matchRow.querySelector('[data-action="match-delete"]'));
    assert.equal(app.storedData().matches.length, 4);
});

test('админка: добавление матча и понятные проверки формы', () => {
    const app = boot();
    app.login();

    const form = app.$('[data-form="match"]');
    assert.match(app.id('match-date').value, /^\d{4}-\d{2}-\d{2}$/, 'дата подставляется автоматически');

    // Пустая дата
    app.id('match-team-a').value = '1';
    app.id('match-team-b').value = '2';
    app.id('match-date').value = '';
    app.submit(form);
    assert.match(app.id('match-form-error').textContent, /Укажите дату/);

    // Одинаковые команды
    app.id('match-date').value = '2026-10-01';
    app.id('match-team-b').value = '1';
    app.submit(form);
    assert.match(app.id('match-form-error').textContent, /должны быть разными/);

    // Заполнен только один счёт — данные не должны молча теряться
    app.id('match-team-b').value = '2';
    app.id('match-score-a').value = '1';
    app.submit(form);
    assert.match(app.id('match-form-error').textContent, /счёт обеих команд/);
    assert.equal(app.storedData().matches.length, 4, 'ничего не сохранено');

    // Корректный предстоящий матч
    app.id('match-score-a').value = '';
    app.submit(form);
    assert.equal(app.storedData().matches.length, 5);
    assert.equal(app.id('match-form-error').textContent, '');
    assert.equal(app.id('match-score-a').value, '', 'форма очищена');
    assert.equal(app.id('match-score-b').value, '');

    const added = app.storedData().matches[4];
    assert.deepEqual(
        { teamA: added.teamA, teamB: added.teamB, date: added.date, finished: added.finished },
        { teamA: 1, teamB: 2, date: '2026-10-01', finished: false }
    );
    assert.equal(app.id('stat-matches').textContent, '5');
});

test('админка: ввод счёта, переоткрытие, правка и удаление матча влияют на таблицу', () => {
    const app = boot();
    app.login();

    assert.equal(app.storedData().matches.find((match) => match.id === 3).finished, false);

    const rowOf = (matchId) => app.id('score-a-' + matchId).closest('tr');

    // Победный счёт Спартака над Динамо
    app.id('score-a-3').value = '4';
    app.id('score-b-3').value = '0';
    app.click(rowOf(3).querySelector('[data-action="match-save-score"]'));

    const saved = app.storedData().matches.find((match) => match.id === 3);
    assert.deepEqual([saved.scoreA, saved.scoreB, saved.finished], [4, 0, true]);
    assert.equal(app.id('stat-finished').textContent, '3');
    assert.equal(app.id('latest-results').querySelectorAll('.match-card').length, 3, 'результат попал на главную');

    app.navigate('standings');
    const spartakCells = Array.from(app.id('standings-body').querySelector('tr').querySelectorAll('td'))
        .map((cell) => cell.textContent.trim());
    assert.equal(spartakCells[9], '6', 'Спартак: 3 + 3 очка');
    assert.equal(spartakCells[2], '2', 'сыграно два матча');

    // Переоткрытие матча убирает его из зачёта
    app.navigate('admin');
    app.click(rowOf(3).querySelector('[data-action="match-reopen"]'));
    assert.equal(app.storedData().matches.find((match) => match.id === 3).finished, false);

    app.navigate('standings');
    const afterReopen = Array.from(app.id('standings-body').querySelector('tr').querySelectorAll('td'))
        .map((cell) => cell.textContent.trim());
    assert.equal(afterReopen[9], '3');

    // Редактирование матча через форму
    app.navigate('admin');
    app.click(rowOf(3).querySelector('[data-action="match-edit"]'));
    assert.equal(app.id('match-form-title').textContent, 'Изменить матч');
    assert.equal(app.id('match-date').value, '2026-09-20');
    assert.equal(app.id('match-cancel').hidden, false, 'появилась кнопка отмены');
    assert.equal(app.id('match-score-a').value, '', 'у переоткрытого матча счёта ещё нет');

    // Форма подставляет данные уже завершённого матча
    app.click(rowOf(1).querySelector('[data-action="match-edit"]'));
    assert.deepEqual(
        [app.id('match-score-a').value, app.id('match-score-b').value, app.id('match-date').value],
        ['2', '1', '2026-09-10']
    );

    // Сохраняем изменения переоткрытого матча №3
    app.click(rowOf(3).querySelector('[data-action="match-edit"]'));
    app.id('match-date').value = '2026-11-11';
    app.id('match-score-a').value = '1';
    app.id('match-score-b').value = '1';
    app.submit(app.$('[data-form="match"]'));

    const edited = app.storedData().matches.find((match) => match.id === 3);
    assert.deepEqual([edited.date, edited.scoreA, edited.scoreB, edited.finished], ['2026-11-11', 1, 1, true]);
    assert.equal(app.id('match-form-title').textContent, 'Добавить матч', 'форма вернулась в режим добавления');
    assert.equal(app.id('match-cancel').hidden, true);

    // Отмена правки возвращает форму в исходное состояние
    app.click(rowOf(3).querySelector('[data-action="match-edit"]'));
    app.click(app.id('match-cancel'));
    assert.equal(app.id('match-form-title').textContent, 'Добавить матч');
    assert.equal(app.id('match-score-a').value, '');

    // Удаление матча
    app.click(rowOf(3).querySelector('[data-action="match-delete"]'));
    assert.equal(app.storedData().matches.length, 3);
    assert.equal(app.id('stat-matches').textContent, '3');
});

test('админка: игроки — добавление, проверки, переименование и удаление', () => {
    const app = boot();
    app.login();

    const select = app.id('player-team-select');
    select.value = '1';
    app.change(select);

    assert.match(app.id('admin-players-team').textContent, /Спартак/);
    assert.equal(app.id('admin-players-list').querySelectorAll('.admin-card').length, 3);

    // Добавление
    app.type(app.id('new-player-name'), 'Новый Игрок');
    app.submit(app.$('[data-form="add-player"]'));
    assert.equal(app.storedData().teams[0].players.length, 4);
    assert.equal(app.id('stat-players').textContent, '10');
    assert.equal(app.id('new-player-name').value, '');

    // Дубликат в другом регистре
    app.type(app.id('new-player-name'), 'новый игрок');
    app.submit(app.$('[data-form="add-player"]'));
    assert.match(app.id('player-form-error').textContent, /уже есть/);
    assert.equal(app.storedData().teams[0].players.length, 4);

    // Пустое имя
    app.type(app.id('new-player-name'), '');
    app.submit(app.$('[data-form="add-player"]'));
    assert.match(app.id('player-form-error').textContent, /Введите имя/);

    // Выбор команды сохраняется после перерисовки (раньше выделение сбрасывалось)
    assert.equal(app.id('player-team-select').value, '1');

    // Переименование
    app.click(app.id('admin-players-list').querySelector('[data-action="player-rename"]'));
    assert.ok(app.id('player-rename-input'));
    app.type(app.id('player-rename-input'), 'Иванов-старший');
    app.click(app.id('admin-players-list').querySelector('[data-action="player-save"]'));
    assert.equal(app.storedData().teams[0].players[0], 'Иванов-старший');

    // Удаление
    app.click(app.id('admin-players-list').querySelector('[data-action="player-delete"]'));
    assert.equal(app.storedData().teams[0].players.length, 3);
    assert.equal(app.id('stat-players').textContent, '9');
});

test('админка: импорт JSON, понятные ошибки и сброс к демо-данным', () => {
    const app = boot();
    app.login();

    app.type(app.id('new-team-name'), 'Временная');
    app.submit(app.$('[data-form="add-team"]'));
    assert.equal(app.storedData().teams.length, 5);

    const valid = JSON.stringify({
        teams: [{ id: 7, name: 'Импорт', players: ['Игрок И.'] }],
        matches: [
            { id: 1, teamA: 7, teamB: 7, scoreA: 1, scoreB: 0, finished: true, date: '2026-01-01' },
            { id: 2, teamA: 7, teamB: 7, scoreA: null, scoreB: null, finished: false, date: '2026-02-02' }
        ]
    });

    assert.equal(app.window.FTApp.importData(valid), true);
    assert.equal(app.storedData().teams.length, 1);
    assert.match(app.id('admin-teams-body').textContent, /Импорт/);
    assert.equal(app.storedData().matches.length, 0, 'матчи «команда сама с собой» отброшены');
    assert.equal(app.id('teams-grid').querySelectorAll('article').length, 1);

    assert.equal(app.window.FTApp.importData('{ это не json'), false);
    assert.match(app.id('toast-container').textContent, /корректным JSON/);
    assert.equal(app.storedData().teams.length, 1, 'данные не изменились');

    assert.equal(app.window.FTApp.importData(JSON.stringify({ foo: 1 })), false);
    assert.match(app.id('toast-container').textContent, /нет списков команд/);

    // Сброс к демонстрационным данным
    app.click(app.actionButton('reset-data'));
    assert.equal(app.storedData().teams.length, 4);
    assert.equal(app.storedData().matches.length, 4);
    assert.equal(app.id('stat-teams').textContent, '4');

    // Экспорт: даже если браузер не даёт сохранить файл, приложение сообщает об этом и не падает
    app.click(app.actionButton('export-data'));
    assert.ok(app.id('toast-container').textContent.length > 0, 'пользователь получает сообщение');
});

test('битые данные в хранилище: предупреждение и рабочий интерфейс', () => {
    const app = boot({ seed: { [DATA_KEY]: 'это не JSON' } });

    assert.equal(app.id('data-warning').hidden, false);
    assert.match(app.id('data-warning').textContent, /повреждены/);
    assert.equal(app.id('stat-teams').textContent, '4', 'показаны демонстрационные данные');
    assert.equal(app.id('standings-body').querySelectorAll('tr').length, 4);

    app.click(app.actionButton('hide-banner'));
    assert.equal(app.id('data-warning').hidden, true);
});

test('ввод пользователя экранируется: нет XSS и сломанной вёрстки', () => {
    const app = boot();
    app.login();

    app.type(app.id('new-team-name'), '<img src=x onerror=alert(1)>');
    app.submit(app.$('[data-form="add-team"]'));
    assert.equal(app.storedData().teams.length, 5);

    app.navigate('teams');
    assert.equal(app.id('teams-grid').querySelectorAll('img').length, 0, 'тег не стал элементом разметки');
    assert.match(app.id('teams-grid').textContent, /<img/);

    app.navigate('admin');
    assert.equal(app.id('admin-teams-body').querySelectorAll('img').length, 0);
    assert.match(app.id('admin-teams-body').textContent, /<img/);

    app.navigate('standings');
    assert.equal(app.id('standings-body').querySelectorAll('img').length, 0);
});

test('данные сохраняются между загрузками страницы', () => {
    const first = boot();
    first.login();
    first.type(first.id('new-team-name'), 'Постоянная');
    first.submit(first.$('[data-form="add-team"]'));

    const saved = first.window.localStorage.getItem(DATA_KEY);
    assert.ok(saved.includes('Постоянная'));

    const second = boot({ seed: { [DATA_KEY]: saved } });
    assert.equal(second.storedData().teams.length, 5);
    assert.match(second.id('teams-grid').textContent, /Постоянная/);
});

test('разметка: уникальные id, существующие иконки и обработанные действия', () => {
    const html = readSource('index.html');
    const document = new JSDOM(html).window.document;
    const appSource = readSource('assets/js/app.js');

    // Все id уникальны
    const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual(duplicates, [], 'найдены дублирующиеся id');

    // Каждая иконка из разметки есть в SVG-спрайте
    const symbols = new Set(Array.from(document.querySelectorAll('symbol')).map((symbol) => symbol.id));
    const usedIcons = Array.from(document.querySelectorAll('use')).map((use) => use.getAttribute('href'));

    assert.ok(usedIcons.length > 10, 'иконок в разметке: ' + usedIcons.length);
    usedIcons.forEach((href) => {
        assert.match(href, /^#i-/, 'ссылка на спрайт должна быть вида #i-name: ' + href);
        assert.ok(symbols.has(href.slice(1)), 'в спрайте нет иконки ' + href);
    });

    // Иконки, которые добавляет JavaScript, тоже должны существовать в спрайте
    const dynamicIcons = Array.from(appSource.matchAll(/icon\('([a-z-]+)'/g)).map((match) => match[1]);
    assert.ok(dynamicIcons.length > 0, 'динамические иконки найдены');
    dynamicIcons.forEach((name) => {
        assert.ok(symbols.has('i-' + name), 'в спрайте нет иконки i-' + name);
    });

    // Каждое действие из разметки обрабатывается в app.js
    const actions = new Set(Array.from(document.querySelectorAll('[data-action]'))
        .map((element) => element.getAttribute('data-action')));

    actions.forEach((action) => {
        assert.ok(appSource.includes("'" + action + "'"), 'действие «' + action + '» не обрабатывается в app.js');
    });

    // Каждый пункт меню ведёт на существующую секцию
    const routes = new Set(Array.from(document.querySelectorAll('[data-nav]'))
        .map((element) => element.getAttribute('data-nav')));

    routes.forEach((route) => {
        const sectionId = route === 'admin' ? 'page-admin-login' : 'page-' + route;
        assert.ok(document.getElementById(sectionId), 'для пункта «' + route + '» нет секции ' + sectionId);
    });

    // Хэш-роутинг и CSP описаны в разметке
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /script-src 'self'/);
});

/* ====================================================================== */
/* Синхронизация с репозиторием GitHub                                   */
/* ====================================================================== */

/** Данные «из репозитория»: время в прошлом, чтобы локальные правки оказывались новее. */
function remoteData(extraTeam) {
    const data = L.createDefaultData();
    data.updatedAt = '2026-09-10T09:15:00.000Z';
    data.revision = 4;

    if (extraTeam) {
        data.teams.push({ id: 50, name: extraTeam, players: [] });
    }

    return data;
}

test('посетитель видит данные из репозитория, а не только локальную копию', async () => {
    const mock = createMockRepository({ data: remoteData('Клуб из репозитория') });
    const app = boot({ mock });

    await app.settle();

    assert.equal(app.id('stat-teams').textContent, '5', 'статистика построена по данным репозитория');
    assert.match(app.id('teams-grid').textContent, /Клуб из репозитория/);
    assert.match(app.id('standings-body').textContent, /Клуб из репозитория/);
    assert.match(app.freshness(), /Данные обновлены: 10 сентября 2026/, 'в подвале указана версия данных');
    assert.equal(app.storedData().teams.length, 5, 'копия сохранена локально (для офлайна)');
    assert.equal(mock.state.requests.some((request) => request.url.includes('/mock-raw/')), true);
});

test('офлайн: показывается сохранённая копия, сайт продолжает работать', async () => {
    const local = remoteData('Офлайн-клуб');
    const app = boot({ seed: { [DATA_KEY]: JSON.stringify(local) } }); // сеть недоступна

    await app.settle();

    assert.equal(app.id('stat-teams').textContent, '5');
    assert.match(app.id('teams-grid').textContent, /Офлайн-клуб/);
    assert.match(app.freshness(), /нет связи с репозиторием/);
    assert.match(app.syncStatus(), /Чтение из репозитория/);
});

test('публикация: токен на устройстве, отправка данных и ссылка на коммит', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();
    app.login();

    // Без токена публиковать нельзя
    app.click(app.actionButton('github-publish'));
    await app.settle();
    assert.match(app.id('toast-container').textContent, /токен/i);

    app.saveToken('test-token');
    await app.settle();

    assert.equal(app.window.localStorage.getItem('ft.githubToken'), 'test-token');
    assert.equal(app.id('github-token').value, '', 'токен не остаётся в поле ввода');

    // Меняем данные и публикуем
    app.type(app.id('new-team-name'), 'Публикуемый клуб');
    app.submit(app.$('[data-form="add-team"]'));
    await app.settle();

    assert.match(app.syncStatus(), /неопубликованные изменения/);

    app.click(app.actionButton('github-publish'));
    await app.settle();

    assert.equal(mock.state.commits.length, 1);
    assert.match(mock.state.commits[0].message, /Публикуемый клуб/);
    assert.equal(mock.state.commits[0].data.teams.some((team) => team.name === 'Публикуемый клуб'), true);
    assert.equal(
        mock.state.requests.find((request) => request.method === 'PUT').headers.authorization,
        'Bearer test-token'
    );
    assert.match(app.syncStatus(), /Опубликовано/);
    assert.match(app.id('sync-status').innerHTML, /github\.com\/test\/test\/commit\/2/);
});

test('авто-публикация: правка уходит в репозиторий без нажатия кнопки', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 20 });

    await app.settle();
    app.login();
    app.saveToken('test-token');
    await app.settle();

    app.type(app.id('new-team-name'), 'Авто-клуб');
    app.submit(app.$('[data-form="add-team"]'));

    await app.wait(80);

    assert.equal(mock.state.commits.length, 1, 'коммит создан автоматически');
    assert.equal(mock.state.data.teams.some((team) => team.name === 'Авто-клуб'), true);
    assert.match(app.syncStatus(), /Опубликовано/);
});

test('более свежая версия из репозитория не затирается устаревшей копией', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();
    app.login();
    app.saveToken('test-token');
    await app.settle();

    app.type(app.id('new-team-name'), 'Локальный клуб');
    app.submit(app.$('[data-form="add-team"]'));

    // «Другое устройство» опубликовало более новую версию
    const external = JSON.parse(JSON.stringify(mock.state.data));
    external.updatedAt = new Date(Date.now() + 60000).toISOString();
    external.teams.push({ id: 90, name: 'Клуб другого устройства', players: [] });
    mock.changeExternally(external);

    app.click(app.actionButton('github-publish'));
    await app.settle();

    assert.match(app.id('toast-container').textContent, /Забрать из репозитория/);
    assert.equal(mock.state.commits.length, 0, 'публикация остановлена');
    assert.equal(mock.state.data.teams.some((team) => team.name === 'Локальный клуб'), false, 'данные не затёрты');
    assert.equal(mock.state.data.teams.some((team) => team.name === 'Клуб другого устройства'), true);
});

test('публикация без базовой версии не затирает появившийся файл', async () => {
    const mock = createMockRepository({}); // файла в репозитории ещё нет
    const app = boot({ mock, autoPublishDelayMs: 10000 });

    await app.settle();
    app.login();
    app.saveToken('test-token');
    await app.settle();

    assert.equal(app.window.localStorage.getItem('ft.publishedAt'), null, 'публикаций с этого устройства не было');

    // Пока администратор правил, файл появился (например, с другого устройства)
    const external = remoteData('Клуб из репозитория');
    external.updatedAt = new Date(Date.now() + 60000).toISOString();
    mock.changeExternally(external);

    app.type(app.id('new-team-name'), 'Мой клуб');
    app.submit(app.$('[data-form="add-team"]'));
    app.click(app.actionButton('github-publish'));
    await app.settle();

    assert.match(app.id('toast-container').textContent, /Забрать из репозитория/);
    assert.equal(mock.state.data.teams.some((team) => team.name === 'Мой клуб'), false);
});

test('«Забрать из репозитория» обновляет данные на устройстве', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock });

    await app.settle();
    app.login();

    const updated = remoteData('Новости с турнира');
    updated.updatedAt = new Date(Date.now() + 30000).toISOString();
    mock.changeExternally(updated);

    app.click(app.actionButton('github-pull'));
    await app.settle();

    assert.equal(app.id('stat-teams').textContent, '5');
    assert.match(app.id('teams-grid').textContent, /Новости с турнира/);
});

test('токен живёт только в браузере устройства и удаляется по кнопке', async () => {
    const app = boot({ mock: createMockRepository({ data: remoteData() }) });

    await app.settle();
    app.login();
    app.saveToken('секретный-токен-123');
    await app.settle();

    assert.equal(app.window.localStorage.getItem('ft.githubToken'), 'секретный-токен-123');
    assert.equal(readSource('index.html').includes('секретный-токен-123'), false, 'в разметке токена нет');
    assert.equal(readSource('assets/js/app.js').includes('секретный-токен-123'), false, 'в коде токена нет');
    assert.match(app.id('github-token').placeholder, /Токен сохранён/);

    app.click(app.actionButton('github-forget-token'));
    await app.settle();

    assert.equal(app.window.localStorage.getItem('ft.githubToken'), null);
    assert.equal(app.id('github-token').placeholder, 'github_pat_…');
});

test('кнопка «Обновить данные» подтягивает свежие результаты', async () => {
    const mock = createMockRepository({ data: remoteData() });
    const app = boot({ mock });

    await app.settle();

    const updated = remoteData();
    updated.updatedAt = new Date(Date.now() + 30000).toISOString();
    updated.matches.push({ id: 99, teamA: 1, teamB: 2, scoreA: 3, scoreB: 3, date: '2026-09-25', finished: true });
    mock.changeExternally(updated);

    app.click(app.actionButton('refresh-data'));
    await app.settle();

    assert.equal(app.id('stat-matches').textContent, '5');
    assert.equal(app.id('stat-finished').textContent, '3');
});
