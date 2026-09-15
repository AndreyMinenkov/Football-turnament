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

let puppeteer = null;
let browser = null;
let server = null;
let baseUrl = '';

before(async () => {
    if (!CHROME) {
        return;
    }

    puppeteer = require('puppeteer-core');

    server = createServer(ROOT);

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = 'http://127.0.0.1:' + server.address().port;

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

    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
});

/** Открывает страницу и собирает ошибки консоли, сбои загрузки и нарушения CSP. */
async function openPage(options) {
    const settings = options || {};
    const page = await browser.newPage();
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

    page.on('pageerror', (error) => problems.push('Ошибка скрипта: ' + error.message));
    page.on('console', (message) => {
        if (message.type() === 'error') {
            problems.push('Консоль: ' + message.text());
        }
    });
    page.on('requestfailed', (request) => problems.push('Не загрузилось: ' + request.url()));

    await page.goto(settings.url || baseUrl + '/', { waitUntil: 'networkidle0' });

    return { page, problems };
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

    assert.equal(await textOf(page, '#stat-teams'), '4');
    assert.equal(await textOf(page, '#stat-matches'), '4');

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

    const routes = [
        ['standings', 'page-standings'],
        ['teams', 'page-teams'],
        ['matches', 'page-matches'],
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
        await page.goto(baseUrl + '/#/' + route, { waitUntil: 'networkidle0' });
        assert.equal(await sectionVisible(page, sectionId), true, 'прямая ссылка #/' + route);
    }

    await page.goto(baseUrl + '/#/standings', { waitUntil: 'networkidle0' });
    assert.equal(await page.$$eval('#standings-body tr', (rows) => rows.length), 4);
    assert.match(await textOf(page, '#standings-body tr:first-child'), /Спартак/);

    await page.goto(baseUrl + '/#/teams', { waitUntil: 'networkidle0' });
    assert.equal(await page.$$eval('#teams-grid article', (cards) => cards.length), 4);

    await page.goto(baseUrl + '/#/matches', { waitUntil: 'networkidle0' });
    assert.equal(await page.$$eval('#matches-list .match-card', (cards) => cards.length), 4);
    await page.click('[data-filter="finished"]');
    assert.equal(await page.$$eval('#matches-list .match-card', (cards) => cards.length), 2);

    assert.deepEqual(problems, [], 'ошибок по пути не возникло');
    await page.close();
});

test('админ-панель целиком в браузере: вход, команда, матч, счёт и сохранение после перезагрузки', { skip }, async () => {
    const { page, problems } = await openPage();

    page.on('dialog', (dialog) => dialog.accept());

    // Начинаем с чистого хранилища
    await page.evaluate(() => window.localStorage.clear());
    await page.reload({ waitUntil: 'networkidle0' });

    // Вход
    await page.click('[data-nav="admin"]');
    await page.type('#admin-password', 'admin');
    await page.click('[data-form="login"] button[type="submit"]');
    assert.equal(await sectionVisible(page, 'page-admin-dashboard'), true);
    assert.equal(await sectionVisible(page, 'page-admin-login'), false);

    // Сессия администратора сохраняется при переходах по сайту
    await page.click('[data-nav="teams"]');
    await page.click('[data-nav="admin"]');
    assert.equal(await sectionVisible(page, 'page-admin-dashboard'), true);

    // Добавляем команду
    await page.type('#new-team-name', 'Зенит');
    await page.click('[data-form="add-team"] button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll('#admin-teams-body tr').length === 5);
    assert.equal(await textOf(page, '#stat-teams'), '5');

    // Дубликат отклоняется
    await page.type('#new-team-name', 'зенит');
    await page.click('[data-form="add-team"] button[type="submit"]');
    assert.match(await textOf(page, '#team-form-error'), /уже есть/);

    // Добавляем матч без счёта
    await page.select('#match-team-a', '1');
    await page.select('#match-team-b', '5');
    await page.$eval('#match-date', (element) => {
        element.value = '2026-12-01';
    });
    await page.click('#match-submit');
    await page.waitForFunction(() => document.querySelectorAll('#admin-matches-body tr').length === 5);

    const newMatchId = await page.evaluate(() => {
        const stored = JSON.parse(window.localStorage.getItem('footballTournamentData'));
        return stored.matches[stored.matches.length - 1].id;
    });

    // Вводим счёт прямо в строке таблицы матчей
    await page.$eval('#score-a-' + newMatchId, (element) => {
        element.value = '2';
    });
    await page.$eval('#score-b-' + newMatchId, (element) => {
        element.value = '2';
    });
    await page.evaluate((matchId) => {
        document.getElementById('score-a-' + matchId).closest('tr')
            .querySelector('[data-action="match-save-score"]').click();
    }, newMatchId);

    await page.waitForFunction((matchId) => {
        const stored = JSON.parse(window.localStorage.getItem('footballTournamentData'));
        return stored.matches.find((match) => match.id === matchId).finished === true;
    }, {}, newMatchId);

    // Ничья 2:2 приносит по одному очку
    await page.click('[data-nav="standings"]');
    const zenitRow = await page.evaluate(() => {
        const row = Array.from(document.querySelectorAll('#standings-body tr'))
            .find((element) => element.textContent.includes('Зенит'));
        return Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent.trim());
    });
    assert.equal(zenitRow[9], '1', 'очки Зенита в таблице');

    const spartakRow = await page.evaluate(() => {
        const row = document.querySelector('#standings-body tr');
        return Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent.trim());
    });
    assert.equal(spartakRow[9], '4', 'Спартак: победа и ничья');

    // Данные переживают перезагрузку страницы
    await page.reload({ waitUntil: 'networkidle0' });
    assert.equal(await textOf(page, '#stat-teams'), '5');
    assert.equal(await textOf(page, '#stat-finished'), '3');

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

test('экспорт данных запускается в реальном браузере', { skip }, async () => {
    const { page } = await openPage();

    await page.click('[data-nav="admin"]');
    await page.type('#admin-password', 'admin');
    await page.click('[data-form="login"] button[type="submit"]');

    await page.click('[data-action="export-data"]');
    await page.waitForFunction(() => document.querySelector('#toast-container').textContent.includes('выгружен'));
    assert.match(await textOf(page, '#toast-container'), /выгружен/);

    await page.close();
});

test('сайт работает из подпапки — как на GitHub Pages для репозитория', { skip }, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-pages-'));
    fs.symlinkSync(ROOT, path.join(tempRoot, 'repo'), 'dir');

    const subServer = createServer(tempRoot);

    await new Promise((resolve) => subServer.listen(0, '127.0.0.1', resolve));

    const subUrl = 'http://127.0.0.1:' + subServer.address().port + '/repo/';
    const { page, problems } = await openPage({ url: subUrl });

    assert.equal(await textOf(page, '#stat-teams'), '4', 'данные загрузились из подпапки');
    assert.equal(await page.$$eval('#standings-body tr', (rows) => rows.length), 4);
    assert.equal(await page.$eval('body', (element) => getComputedStyle(element).backgroundColor), 'rgb(248, 249, 250)');
    assert.deepEqual(problems, [], 'все ресурсы нашлись по относительным путям');

    await page.close();
    await new Promise((resolve) => subServer.close(resolve));
    fs.rmSync(tempRoot, { recursive: true, force: true });
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
