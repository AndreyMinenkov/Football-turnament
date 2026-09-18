/**
 * E2E-проверка в настоящем браузере (Chrome headless) через puppeteer-core.
 * Сайт отдаётся локальным сервером tools/serve.js — так же, как на хостинге (http, CSP, шрифты, 404).
 *
 * Запуск: npm run test:browser
 * Если Chrome не найден, тесты помечаются пропущенными (npm test их не затрагивает).
 */
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../tools/serve.js');
const { createMockRepository, createMockServer } = require('./helpers/mock-github.js');

const ROOT = path.resolve(__dirname, '..');

/** Ищет исполняемый файл Chrome: переменная окружения, кэш puppeteer, системные пути. */
function findChrome() {
    const candidates = [];

    if (process.env.CHROME_PATH) {
        candidates.push(process.env.CHROME_PATH);
    }

    const cacheDir = '/root/.cache/puppeteer/chrome-headless-shell';

    if (fs.existsSync(cacheDir)) {
        fs.readdirSync(cacheDir).forEach((version) => {
            candidates.push(path.join(cacheDir, version, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
        });
    }

    candidates.push(
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    );

    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const CHROME = findChrome();
const skip = CHROME ? false : 'Chrome не найден — установите Chrome или задайте CHROME_PATH';

/** Настройки, при которых сайт обращается к локальному макету GitHub, а не к настоящему. */
const SITE_CONFIG = {
    github: {
        owner: 'test',
        repo: 'test',
        branch: 'main',
        path: 'data.json',
        apiBase: '/mock-api',
        rawBase: '/mock-raw'
    },
    refreshIntervalMs: 0,
    autoPublishDelayMs: 50
};

let puppeteer = null;
let browser = null;
let mockServer = null;
let mockRepository = null;
let baseUrl = '';
let mockBaseUrl = '';

before(async () => {
    if (!CHROME) {
        return;
    }

    puppeteer = require('puppeteer-core');

    // Сервер-макет отдаёт сайт и одновременно играет роль GitHub (пути /mock-raw и /mock-api),
    // поэтому тесты автономны: интернет не нужен, настоящий GitHub не затрагивается.
    // В «репозитории» изначально лежит тот же data.json, что и в проекте.
    const mock = createMockServer(ROOT, createMockRepository({
        data: JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'))
    }));
    mockServer = mock.server;
    mockRepository = mock.repository;

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    mockBaseUrl = 'http://127.0.0.1:' + mockServer.address().port;
    baseUrl = mockBaseUrl;

    browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });
});

after(async () => {
    if (browser) {
        await browser.close();
    }

    if (mockServer) {
        await new Promise((resolve) => mockServer.close(resolve));
    }
});

/** Отдельный контекст браузера = «другое устройство»: своё хранилище localStorage. */
function createIsolatedContext() {
    return typeof browser.createBrowserContext === 'function'
        ? browser.createBrowserContext()
        : browser.createIncognitoBrowserContext();
}

/**
 * Клик по элементу с повтором: приложение перерисовывает части страницы,
 * и в редких случаях клик приходится на момент перерисовки.
 */
async function clickWhenReady(page, selector, attempts) {
    const tries = attempts || 6;

    for (let attempt = 1; attempt <= tries; attempt += 1) {
        try {
            await page.click(selector);
            return;
        } catch (error) {
            if (attempt === tries) {
                throw error;
            }

            await new Promise((resolve) => setTimeout(resolve, 150));
        }
    }
}

/**
 * Прокручивает элемент к центру экрана и кликает по нему.
 * Нужно для кнопок у самой границы окна: центр такой кнопки лежит вне вьюпорта,
 * и обычный клик по координатам не срабатывает. Прокрутка задаётся как «instant»,
 * а перед кликом проверяется, что под курсором именно эта кнопка (в проекте
 * включена плавная прокрутка, из-за неё координаты меняются не сразу).
 */
async function clickInView(page, selector) {
    await page.$eval(selector, (element) => {
        element.scrollIntoView({ block: 'center', behavior: 'instant' });
    });

    await page.waitForFunction((target) => {
        const element = document.querySelector(target);

        if (!element) {
            return false;
        }

        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);

        return Boolean(hit) && (hit === element || element.contains(hit));
    }, {}, selector);

    await clickWhenReady(page, selector);
}

/** Переходит по адресу и ждёт, пока приложение инициализируется и подтянет данные. */
async function gotoApp(page, url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.FTApp));
    await page.waitForFunction(() => window.FTApp.sync.state.pullCompleted);
}

/** Перезагрузка страницы с ожиданием повторной инициализации приложения. */
async function reloadApp(page) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => Boolean(window.FTApp));
    await page.waitForFunction(() => window.FTApp.sync.state.pullCompleted);
}

/** Открывает страницу и собирает ошибки консоли, сбои загрузки и нарушения CSP. */
async function openPage(options) {
    const settings = options || {};
    // isolated: true — своё хранилище localStorage (как на другом устройстве)
    const context = settings.isolated ? await createIsolatedContext() : null;
    const page = context ? await context.newPage() : await browser.newPage();
    const problems = [];

    await page.setViewport(settings.mobile
        ? { width: 390, height: 844, isMobile: true, hasTouch: true }
        : { width: 1280, height: 900 });

    await page.evaluateOnNewDocument(() => {
        window.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (event) => {
            window.__cspViolations.push(event.violatedDirective + ' → ' + event.blockedURI);
        });
    });

    // Настройки подставляются до запуска скриптов приложения.
    // По умолчанию используется макет GitHub, поэтому тесты не зависят от интернета.
    await page.evaluateOnNewDocument((config) => {
        window.FT_CONFIG = config;
    }, settings.config || SITE_CONFIG);

    page.on('pageerror', (error) => problems.push('Ошибка скрипта: ' + error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') {
            problems.push('Консоль: ' + message.text());
        }
    });
    page.on('requestfailed', (request) => problems.push('Не загрузилось: ' + request.url()));

    // Необработанное модальное окно блокирует страницу: любые запросы к ней «зависают».
    // Поэтому окна всегда закрываем, а сам факт их появления считаем проблемой теста.
    page.on('dialog', (dialog) => {
        problems.push('Диалог браузера (' + dialog.type() + '): ' + dialog.message());
        dialog.accept().catch(() => {});
    });

    await gotoApp(page, settings.url || baseUrl + '/');

    return {
        page,
        problems,
        /** Закрывает страницу вместе с её хранилищем */
        close: async () => {
            await page.close();

            if (context) {
                await context.close();
            }
        }
    };
}

/** Снимок данных страницы: сколько команд и матчей, очки команд в таблице. */
function dataSnapshot(page) {
    return page.evaluate(() => {
        const data = window.FTApp.getData();
        const rows = window.FTLogic.computeStandings(data.teams, data.matches);
        const points = {};

        rows.forEach((row) => {
            points[row.id] = row.points;
        });

        return {
            teams: data.teams.length,
            matches: data.matches.length,
            finished: data.matches.filter((match) => match.finished === true).length,
            points: points
        };
    });
}

/** Видима ли секция (учитывая display:none у неактивных страниц). */
function sectionVisible(page, sectionId) {
    return page.evaluate((id) => {
        const element = document.getElementById(id);
        return !!element && element.offsetParent !== null;
    }, sectionId);
}

function textOf(page, selector) {
    return page.$eval(selector, (element) => element.textContent.trim());
}

function clickAction(page, selector) {
    return page.click(selector);
}

test('страница открывается без ошибок: стили, локальные шрифты и CSP', { skip }, async () => {
    const { page, problems } = await openPage();

    const data = await dataSnapshot(page);
    assert.equal(await textOf(page, '#stat-teams'), String(data.teams));
    assert.equal(await textOf(page, '#stat-matches'), String(data.matches));

    // Стили из собранного Tailwind применились
    const background = await page.$eval('body', (element) => getComputedStyle(element).backgroundColor);
    assert.equal(background, 'rgb(248, 249, 250)');

    // Локальный шрифт Roboto подхватился (без Google Fonts)
    assert.equal(await page.evaluate(() => document.fonts.check('16px Roboto')), true);

    // Иконки из инлайнового спрайта отрисованы
    const icons = await page.$$eval('svg use', (list) => list.length);
    assert.ok(icons > 10, 'иконок на странице: ' + icons);

    assert.deepEqual(await page.evaluate(() => window.__cspViolations), [], 'CSP ничего не заблокировала');
    assert.deepEqual(problems, [], 'нет ошибок консоли и сбоев загрузки');

    await page.close();
});

test('все страницы открываются и по меню, и по прямой ссылке', { skip }, async () => {
    const { page, problems } = await openPage();

    // Ожидания считаются по данным сайта: содержимое data.json может меняться
    const data = await dataSnapshot(page);

    const routes = [
        ['standings', 'page-standings'],
        ['teams', 'page-teams'],
        ['matches', 'page-matches'],
        ['players', 'page-players'],
        ['home', 'page-home']
    ];

    for (const [route, sectionId] of routes) {
        await page.click('[data-nav="' + route + '"]');
        assert.equal(await sectionVisible(page, sectionId), true, 'страница ' + route);
        assert.equal(page.url(), baseUrl + '/#/' + route, 'адрес синхронизирован с хэшем');
    }

    // Админ без пароля показывает форму входа
    await page.click('[data-nav="admin"]');
    assert.equal(await sectionVisible(page, 'page-admin-login'), true);

    // Прямые ссылки работают так же, как навигация
    for (const [route, sectionId] of routes) {
        await gotoApp(page, baseUrl + '/#/' + route);
        assert.equal(await sectionVisible(page, sectionId), true, 'прямая ссылка #/' + route);
    }

    await gotoApp(page, baseUrl + '/#/standings');
    assert.equal(await page.$$eval('#standings-body tr', (rows) => rows.length), data.teams);

    // Первая строка таблицы — команда с наибольшим числом очков
    const leaderPoints = await page.$eval('#standings-body tr:first-child td:last-child', (cell) => Number(cell.textContent.trim()));
    assert.equal(leaderPoints, Math.max(...Object.values(data.points)), 'первая строка — лидер по очкам');

    await gotoApp(page, baseUrl + '/#/teams');
    assert.equal(await page.$$eval('#teams-grid article', (cards) => cards.length), data.teams);

    await gotoApp(page, baseUrl + '/#/matches');
    assert.equal(await page.$$eval('#matches-list .match-card', (cards) => cards.length), data.matches);
    await page.click('[data-filter="finished"]');
    assert.equal(await page.$$eval('#matches-list .match-card', (cards) => cards.length), data.finished);

    assert.deepEqual(problems, [], 'ошибок по пути не возникло');
    await page.close();
});

test('админ-панель целиком в браузере: вход, команда, матч, счёт и сохранение после перезагрузки', { skip }, async () => {
    const { page, problems } = await openPage();

    // Модальные окна (подтверждение удаления) закрывает общий обработчик из openPage

    // Начинаем с чистого хранилища
    await page.evaluate(() => window.localStorage.clear());
    await reloadApp(page);

    // Вход
    await page.click('[data-nav="admin"]');
    await page.type('#admin-password', 'admin');
    await page.click('[data-form="login"] button[type="submit"]');
    assert.equal(await sectionVisible(page, 'page-admin-dashboard'), true);
    assert.equal(await sectionVisible(page, 'page-admin-login'), false);

    // Админка разделена на разделы: открыт «Команды», раздел «Матчи» скрыт
    assert.equal(await sectionVisible(page, 'admin-panel-teams'), true);
    assert.equal(await sectionVisible(page, 'admin-panel-matches'), false);

    // Сессия администратора сохраняется при переходах по сайту
    await page.click('[data-nav="teams"]');
    await page.click('[data-nav="admin"]');
    assert.equal(await sectionVisible(page, 'page-admin-dashboard'), true);
    assert.equal(await sectionVisible(page, 'admin-panel-teams'), true, 'раздел «Команды» открыт по умолчанию');

    // Состояние данных до правок: ожидания ниже считаются от него,
    // чтобы тест не зависел от содержимого data.json
    const before = await dataSnapshot(page);

    // Добавляем команду (раздел «Команды»: список команд и форма под ним)
    await page.type('#new-team-name', 'Зенит');
    await clickInView(page, '[data-form="add-team"] button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll('#admin-teams-list [data-action="team-open"]').length === 5);
    assert.equal(await textOf(page, '#stat-teams'), String(before.teams + 1));

    // Дубликат отклоняется
    await page.type('#new-team-name', 'зенит');
    await clickInView(page, '[data-form="add-team"] button[type="submit"]');
    assert.match(await textOf(page, '#team-form-error'), /уже есть/);

    // Клик по названию открывает карточку команды: добавляем игрока
    await clickInView(page, '#admin-teams-list [data-action="team-open"][data-id="5"]');
    assert.equal(await sectionVisible(page, 'admin-team-view'), true, 'открылась карточка команды');
    assert.equal(await sectionVisible(page, 'admin-team-list-view'), false, 'список команд скрылся');

    await page.type('#new-player-name', 'Тестовый Игрок');
    await clickInView(page, '[data-form="add-player"] button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll('#admin-players-list .admin-card').length === 1);

    await clickInView(page, '[data-action="team-back"]');
    assert.equal(await sectionVisible(page, 'admin-team-list-view'), true, 'кнопка «Все команды» вернула список');

    // Переходим в раздел «Матчи»: список матчей и форма добавления находятся там
    await page.click('[data-admin-tab="matches"]');
    assert.equal(await sectionVisible(page, 'admin-panel-matches'), true);
    assert.equal(await sectionVisible(page, 'admin-panel-teams'), false, 'раздел «Команды» скрылся');

    // Добавляем матч без счёта
    await page.select('#match-team-a', '1');
    await page.select('#match-team-b', '5');
    await page.$eval('#match-date', (element) => {
        element.value = '2026-12-01';
    });
    await clickInView(page, '#match-submit');
    await page.waitForFunction(() => document.querySelectorAll('#admin-matches-list [data-action="match-open"]').length === 5);

    const newMatchId = await page.evaluate(() => {
        const stored = JSON.parse(window.localStorage.getItem('footballTournamentData'));
        return stored.matches[stored.matches.length - 1].id;
    });

    // Клик по матчу открывает его карточку: счёт, составы и отметки голов
    await clickWhenReady(page, '#admin-matches-list [data-action="match-open"][data-id="' + newMatchId + '"]');
    assert.equal(await sectionVisible(page, 'admin-match-view'), true, 'открылась карточка матча');
    assert.equal(await sectionVisible(page, 'admin-match-list-view'), false, 'список матчей скрылся');

    await page.$eval('#score-a-' + newMatchId, (element) => {
        element.value = '2';
    });
    await page.$eval('#score-b-' + newMatchId, (element) => {
        element.value = '2';
    });
    await clickInView(page, '[data-action="match-save-score"]');

    await page.waitForFunction((matchId) => {
        const stored = JSON.parse(window.localStorage.getItem('footballTournamentData'));
        return stored.matches.find((match) => match.id === matchId).finished === true;
    }, {}, newMatchId);

    // Отмечаем гол игрока новой команды: иконка мяча становится активной
    const goalButton = '.event-btn[data-action="match-event"][data-team="5"][data-player="Тестовый Игрок"][data-type="goal"]';
    await clickInView(page, goalButton);

    await page.waitForFunction((matchId) => {
        const stored = JSON.parse(window.localStorage.getItem('footballTournamentData'));
        return stored.matches.find((match) => match.id === matchId).events.length === 1;
    }, {}, newMatchId);

    assert.deepEqual(await page.$eval(goalButton, (element) => ({
        active: element.classList.contains('is-active'),
        count: element.textContent.trim(),
        pressed: element.getAttribute('aria-pressed')
    })), { active: true, count: '1', pressed: 'true' }, 'гол записан и виден на иконке');

    // Возврат к списку матчей кнопкой «Все матчи»
    await clickInView(page, '[data-action="match-back"]');
    assert.equal(await sectionVisible(page, 'admin-match-list-view'), true, 'список матчей вернулся');

    // Отмеченный гол сразу виден на публичной странице «Лучшие игроки»
    await page.click('[data-nav="players"]');
    assert.equal(await sectionVisible(page, 'page-players'), true, 'открылась страница лучших игроков');
    const bestPlayers = await page.$eval('#players-body tr', (row) =>
        Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent.trim()));
    assert.equal(bestPlayers.some((cell) => cell.includes('Тестовый Игрок')), true, 'игрок с голом попал в список');
    assert.deepEqual(bestPlayers.slice(3), ['1', '0'], 'в таблице: один гол, ноль передач');

    // Ничья 2:2 приносит по одному очку каждой команде
    const after = await dataSnapshot(page);
    assert.equal(after.points[1], before.points[1] + 1, 'очко первой команде');
    assert.equal(after.points[5], 1, 'очко новой команде');

    await page.click('[data-nav="standings"]');
    const zenitPoints = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('#standings-body tr'))
            .find((element) => element.textContent.includes('Зенит'));
        return row ? Number(row.querySelector('td:last-child').textContent.trim()) : null;
    });
    assert.equal(zenitPoints, after.points[5], 'очки новой команды видны в таблице');

    // Данные переживают перезагрузку страницы
    await reloadApp(page);
    assert.equal(await textOf(page, '#stat-teams'), String(before.teams + 1));
    assert.equal(await textOf(page, '#stat-finished'), String(before.finished + 1));

    // Выход из админки
    await page.click('[data-nav="admin"]');
    await page.click('[data-action="logout"]');
    await page.click('[data-nav="admin"]');
    assert.equal(await sectionVisible(page, 'page-admin-login'), true, 'после выхода нужен пароль снова');

    assert.deepEqual(problems, [], 'ошибок консоли нет');
    await page.close();
});

test('мобильное меню открывается и закрывается', { skip }, async () => {
    const { page, problems } = await openPage({ mobile: true });

    assert.equal(await page.$eval('#mobile-menu', (element) => element.classList.contains('hidden')), true);

    await page.click('[data-action="toggle-menu"]');
    assert.equal(await page.$eval('#mobile-menu', (element) => element.classList.contains('hidden')), false);
    assert.equal(await sectionVisible(page, 'page-home'), true, 'до перехода остаёмся на той же странице');

    await page.click('#mobile-menu [data-nav="teams"]');
    assert.equal(await sectionVisible(page, 'page-teams'), true);
    assert.equal(await page.$eval('#mobile-menu', (element) => element.classList.contains('hidden')), true, 'меню закрылось');

    const active = await page.$eval('#mobile-menu [data-nav="teams"]', (element) => element.classList.contains('active'));
    assert.equal(active, true, 'активный пункт подсвечен и в мобильном меню');

    assert.deepEqual(problems, []);
    await page.close();
});

test('сайт работает из подпапки — как на GitHub Pages для репозитория', { skip }, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-pages-'));
    fs.symlinkSync(ROOT, path.join(tempRoot, 'repo'), 'dir');

    const subServer = createServer(tempRoot);

    await new Promise((resolve) => subServer.listen(0, '127.0.0.1', resolve));

    const subUrl = 'http://127.0.0.1:' + subServer.address().port + '/repo/';

    // Этот тест идёт в отдельном браузере: так он не зависит от состояния,
    // которое накопили предыдущие тесты (страницы, контексты, кэш).
    const ownBrowser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    });

    const sharedBrowser = browser;
    browser = ownBrowser;

    try {
        const { page, problems } = await openPage({ url: subUrl });

        assert.equal(await textOf(page, '#stat-teams'), '4', 'данные загрузились из подпапки');
        assert.equal(await page.$$eval('#standings-body tr', (rows) => rows.length), 4);
        assert.equal(await page.$eval('body', (element) => getComputedStyle(element).backgroundColor), 'rgb(248, 249, 250)');

        // Файла данных по адресу макета в этой подпапке нет — браузер сообщает об этом в консоли,
        // это ожидаемо: приложение берёт data.json от самого сайта. Проверяем отсутствие других проблем.
        const meaningful = problems.filter((item) => !item.includes('Failed to load resource'));
        assert.deepEqual(meaningful, [], 'все ресурсы сайта найдены по относительным путям');

        await page.close();
    } finally {
        browser = sharedBrowser;
        await ownBrowser.close();
        await new Promise((resolve) => subServer.close(resolve));
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('статические файлы отдаются с нужными типами, неизвестный адрес — 404.html', { skip }, async () => {
    const resources = [
        ['/assets/css/tailwind.css', 'text/css'],
        ['/assets/js/logic.js', 'text/javascript'],
        ['/assets/js/app.js', 'text/javascript'],
        ['/assets/fonts/roboto-cyrillic.woff2', 'font/woff2'],
        ['/assets/favicon.svg', 'image/svg+xml'],
        ['/assets/favicon.ico', 'image/x-icon'],
        ['/assets/apple-touch-icon.png', 'image/png'],
        ['/assets/og-image.png', 'image/png'],
        ['/robots.txt', 'text/plain']
    ];

    for (const [url, expectedType] of resources) {
        const response = await fetch(baseUrl + url);
        const contentType = response.headers.get('content-type') || '';

        assert.equal(response.status, 200, 'код ответа для ' + url);
        assert.ok(contentType.includes(expectedType), 'тип для ' + url + ': получен ' + contentType);
    }

    const missing = await fetch(baseUrl + '/такой-страницы-нет/');
    assert.equal(missing.status, 404);
    assert.match(await missing.text(), /Страница не найдена/);

    const robots = await (await fetch(baseUrl + '/robots.txt')).text();
    assert.match(robots, /User-agent: \*/);
});

test('синхронизация: посетитель видит данные репозитория, администратор публикует для всех', { skip }, async () => {
    // Готовим «репозиторий»: данные турнира + один клуб из общего хранилища
    const remote = JSON.parse(fs.readFileSync(path.join(ROOT, 'data.json'), 'utf8'));
    remote.updatedAt = '2026-09-10T09:15:00.000Z';
    remote.revision = 4;
    remote.teams.push({ id: 42, name: 'Клуб из репозитория', players: [] });

    mockRepository.state.data = remote;
    mockRepository.state.sha = 'sha-1';
    mockRepository.state.commits.length = 0;

    // 1. Посетитель открывает сайт с другого устройства — данные приходят из репозитория
    const visitor = await openPage({ url: mockBaseUrl + '/', isolated: true });

    assert.equal(await textOf(visitor.page, '#stat-teams'), String(remote.teams.length));
    assert.match(await textOf(visitor.page, '#teams-grid'), /Клуб из репозитория/);
    assert.match(await textOf(visitor.page, '#data-freshness'), /Данные обновлены: 10 сентября 2026/);
    assert.deepEqual(visitor.problems, []);
    assert.deepEqual(await visitor.page.evaluate(() => window.__cspViolations), []);
    await visitor.close();

    // 2. Администратор публикует новый клуб
    const admin = await openPage({ url: mockBaseUrl + '/', isolated: true });

    await clickWhenReady(admin.page, '[data-nav="admin"]');
    await admin.page.type('#admin-password', 'admin');
    await clickWhenReady(admin.page, '[data-form="login"] button[type="submit"]');
    await admin.page.waitForFunction(() => window.FTApp && window.FTApp.isAdmin());

    // Блок «Настройки» скрыт по умолчанию — открываем его кнопкой в шапке панели
    await clickInView(admin.page, '[data-action="toggle-settings"]');
    await admin.page.type('#github-token', 'test-token');
    await clickInView(admin.page, '[data-action="github-save-token"]');
    await admin.page.waitForFunction(() => document.getElementById('github-token').placeholder.includes('сохранён'));

    await admin.page.type('#new-team-name', 'Опубликовано из админки');
    await clickInView(admin.page, '[data-form="add-team"] button[type="submit"]');
    await admin.page.waitForFunction((expected) => {
        return document.querySelectorAll('#admin-teams-list [data-action="team-open"]').length === expected;
    }, {}, remote.teams.length + 1);

    await clickInView(admin.page, '[data-action="github-publish"]');
    await admin.page.waitForFunction(() => document.getElementById('sync-status').textContent.includes('Опубликовано'));

    assert.equal(mockRepository.state.commits.length, 1, 'создан один коммит');
    assert.equal(mockRepository.state.data.teams.length, remote.teams.length + 1);
    assert.equal(mockRepository.state.data.teams.some((team) => team.name === 'Опубликовано из админки'), true);

    // Повторное нажатие «Опубликовать» без изменений не должно показывать ошибку
    // (раньше в такой ситуации появлялось тревожное сообщение про «версию из репозитория»)
    await clickInView(admin.page, '[data-action="github-publish"]');
    await admin.page.waitForFunction(
        () => !document.getElementById('sync-status').textContent.includes('Публикуем')
    );

    const repeatStatus = await textOf(admin.page, '#sync-status');
    assert.equal(repeatStatus.includes('Не удалось опубликовать'), false, 'ошибки нет');
    assert.match(repeatStatus, /Опубликовано/);
    assert.equal(mockRepository.state.commits.length, 1, 'лишний коммит не создан');

    assert.deepEqual(admin.problems, []);
    await admin.close();

    // 3. «Другое устройство»: чистое хранилище — данные должны прийти из репозитория
    const otherContext = await createIsolatedContext();
    const otherPage = await otherContext.newPage();

    await otherPage.evaluateOnNewDocument((config) => {
        window.FT_CONFIG = config;
    }, SITE_CONFIG);

    await gotoApp(otherPage, mockBaseUrl + '/');

    assert.equal(await textOf(otherPage, '#stat-teams'), String(remote.teams.length + 1), 'другое устройство получило опубликованные данные');
    assert.match(await textOf(otherPage, '#teams-grid'), /Опубликовано из админки/);
    assert.match(await textOf(otherPage, '#data-freshness'), /10 сентября 2026|сентября 2026/);

    await otherPage.close();
    await otherContext.close();
});
