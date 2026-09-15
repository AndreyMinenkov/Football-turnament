#!/usr/bin/env node
/**
 * Мини-сервер для локального просмотра сайта и для тестов.
 * Никаких зависимостей — только стандартные модули Node.js.
 *
 * Запуск: npm run serve  (по умолчанию http://localhost:8080)
 * Тесты:  const { createServer } = require('./tools/serve.js')
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.toml': 'text/plain; charset=utf-8'
};

/** Безопасно превращает URL-путь в путь внутри корня сайта (защита от ../). */
function resolvePath(root, urlPath) {
    const decoded = decodeURIComponent(String(urlPath || '/').split('?')[0].split('#')[0]);
    const relative = decoded.replace(/^\/+/, '');
    const target = path.resolve(root, relative);

    if (target !== root && !target.startsWith(root + path.sep)) {
        return null;
    }

    return target;
}

function send(response, status, body, headers) {
    response.writeHead(status, Object.assign({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store'
    }, headers || {}));
    response.end(body);
}

function handleRequest(root) {
    return function (request, response) {
        const requested = resolvePath(root, request.url);

        if (!requested) {
            send(response, 403, 'Доступ запрещён');
            return;
        }

        const candidate = requested.endsWith(path.sep) ? path.join(requested, 'index.html') : requested;

        fs.stat(candidate, function (statError, stats) {
            const filePath = !statError && stats.isDirectory() ? path.join(candidate, 'index.html') : candidate;

            fs.readFile(filePath, function (readError, content) {
                if (readError) {
                    // Как на GitHub Pages / Netlify: для неизвестного адреса отдаём 404.html
                    fs.readFile(path.join(root, '404.html'), function (notFoundError, notFoundPage) {
                        if (notFoundError) {
                            send(response, 404, 'Страница не найдена');
                            return;
                        }

                        send(response, 404, notFoundPage, { 'Content-Type': CONTENT_TYPES['.html'] });
                    });
                    return;
                }

                send(response, 200, content, {
                    'Content-Type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
                });
            });
        });
    };
}

/** Создаёт HTTP-сервер, отдающий статические файлы из каталога root. */
function createServer(root) {
    return http.createServer(handleRequest(root ? path.resolve(root) : ROOT));
}

/** Запускает сервер на указанном порту (0 — любой свободный). */
function start(options) {
    const settings = options || {};
    const server = createServer(settings.root);
    const port = settings.port === undefined ? 8080 : settings.port;
    const host = settings.host || '127.0.0.1';

    server.listen(port, host, function () {
        const address = server.address();
        console.log('Сайт доступен по адресу: http://' + host + ':' + address.port + '/');
        console.log('Корень: ' + (settings.root || ROOT));
    });

    return server;
}

module.exports = { createServer, start, resolvePath, ROOT };

if (require.main === module) {
    start({ port: Number(process.env.PORT || 8080) });
}
