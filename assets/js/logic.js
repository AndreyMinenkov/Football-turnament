/**
 * Чистая логика турнира — без DOM.
 *
 * Модуль используется двумя потребителями:
 *   1) браузером (подключается обычным <script>, доступ через window.FTLogic);
 *   2) юнит-тестами Node.js (tests/logic.test.js, через module.exports).
 *
 * Здесь собраны расчёт турнирной таблицы, валидация ввода, работа с датами,
 * нормализация данных и чтение/запись в localStorage.
 */
(function (root, factory) {
    'use strict';

    var api = factory();

    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }

    if (root) {
        root.FTLogic = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /** Настройки приложения. */
    var CONFIG = {
        storageKey: 'footballTournamentData',
        sessionKey: 'footballTournamentAdmin',
        dataVersion: 2,
        // Пароль администратора. Внимание: это демонстрационная защита,
        // на статическом хостинге реальную авторизацию без сервера сделать нельзя
        // (подробности — в README.md).
        adminPassword: 'admin',
        maxTeamNameLength: 30,
        maxPlayerNameLength: 40,
        maxScore: 99,
        formLength: 5,
        recentMatches: 3
    };

    /** Палитра бейджей команд (классы описаны в src/input.css). */
    var BADGE_COLORS = [
        'badge-color-1', 'badge-color-2', 'badge-color-3', 'badge-color-4',
        'badge-color-5', 'badge-color-6', 'badge-color-7', 'badge-color-8'
    ];

    /** Демонстрационный набор данных (первый запуск и сброс). */
    function createDefaultData() {
        return {
            version: CONFIG.dataVersion,
            revision: 1,
            updatedAt: new Date().toISOString(),
            teams: [
                { id: 1, name: 'Спартак', players: ['Иванов А.', 'Петров П.', 'Сидоров С.'] },
                { id: 2, name: 'Локомотив', players: ['Кузнецов К.', 'Попов П.'] },
                { id: 3, name: 'Динамо', players: ['Смирнов Д.', 'Волков В.'] },
                { id: 4, name: 'ЦСКА', players: ['Михайлов М.', 'Новиков Н.'] }
            ],
            matches: [
                { id: 1, teamA: 1, teamB: 2, scoreA: 2, scoreB: 1, date: '2026-09-10', finished: true },
                { id: 2, teamA: 3, teamB: 4, scoreA: 1, scoreB: 1, date: '2026-09-11', finished: true },
                { id: 3, teamA: 1, teamB: 3, scoreA: null, scoreB: null, date: '2026-09-20', finished: false },
                { id: 4, teamA: 2, teamB: 4, scoreA: null, scoreB: null, date: '2026-09-21', finished: false }
            ]
        };
    }

    /* ------------------------------------------------------------------ */
    /* Общие утилиты                                                       */
    /* ------------------------------------------------------------------ */

    /**
     * Экранирование пользовательского текста перед вставкой через innerHTML.
     * Защищает от «сломанной» вёрстки и XSS при вводе имён команд и игроков.
     */
    function escapeHtml(value) {
        if (value === null || value === undefined) {
            return '';
        }

        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function isPlainObject(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }

    /** Аккуратно приводит значение к целому числу, иначе возвращает null. */
    function toInt(value) {
        if (typeof value === 'number') {
            return Number.isFinite(value) ? Math.trunc(value) : null;
        }

        var parsed = parseInt(String(value === null || value === undefined ? '' : value).trim(), 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    /** Убирает лишние пробелы и обрезает строку до нужной длины. */
    function cleanText(value, maxLength) {
        var text = String(value === null || value === undefined ? '' : value)
            .replace(/\s+/g, ' ')
            .trim();

        if (maxLength && text.length > maxLength) {
            text = text.slice(0, maxLength).trim();
        }

        return text;
    }

    /** Следующий свободный идентификатор для новой записи. */
    function nextFreeId(items, idField) {
        var field = idField || 'id';
        var max = 0;

        (items || []).forEach(function (item) {
            var id = isPlainObject(item) || typeof item === 'object' ? toInt(item[field]) : null;
            if (id !== null && id > max) {
                max = id;
            }
        });

        return max + 1;
    }

    function deepCopy(value) {
        return JSON.parse(JSON.stringify(value));
    }

    /* ------------------------------------------------------------------ */
    /* Даты                                                                */
    /* ------------------------------------------------------------------ */

    /**
     * Разбирает дату формата ГГГГ-ММ-ДД как ЛОКАЛЬНУЮ дату.
     * Это исправляет старую проблему: new Date('2026-09-10') трактуется как
     * UTC-полночь, из-за чего в западных часовых поясах показывался предыдущий день.
     */
    function parseISODate(value) {
        if (typeof value !== 'string') {
            return null;
        }

        var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
        if (!match) {
            return null;
        }

        var year = parseInt(match[1], 10);
        var month = parseInt(match[2], 10);
        var day = parseInt(match[3], 10);
        var date = new Date(year, month - 1, day, 0, 0, 0, 0);

        // Отсекаем несуществующие даты вроде 31 февраля
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
            return null;
        }

        return date;
    }

    function pad2(value) {
        return value < 10 ? '0' + value : String(value);
    }

    /** Date → «ГГГГ-ММ-ДД» по локальному времени. */
    function toISODate(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
    }

    function todayISO() {
        return toISODate(new Date());
    }

    var MONTHS_SHORT = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];
    var MONTHS_LONG = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

    /**
     * Форматирование даты без зависимости от локали браузера.
     * style: 'short' → «10 сент.», 'long' → «10 сентября 2026», 'numeric' → «10.09.2026».
     */
    function formatDate(value, style) {
        var date = parseISODate(value);

        if (!date) {
            return 'Дата не указана';
        }

        var day = date.getDate();
        var month = date.getMonth();
        var year = date.getFullYear();

        if (style === 'long') {
            return day + ' ' + MONTHS_LONG[month] + ' ' + year;
        }

        if (style === 'numeric') {
            return pad2(day) + '.' + pad2(month + 1) + '.' + year;
        }

        return day + ' ' + MONTHS_SHORT[month];
    }

    /** «15 сентября 2026, 10:35» — для строки «данные обновлены …». */
    function formatDateTime(value) {
        var date = (value instanceof Date)
            ? value
            : new Date(String(value === null || value === undefined ? '' : value));

        if (Number.isNaN(date.getTime())) {
            return '';
        }

        return date.getDate() + ' ' + MONTHS_LONG[date.getMonth()] + ' ' + date.getFullYear() + ', ' +
            pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }

    /** Числовой ключ даты для сортировки (для дат без значения — «в конце» или «в начале»). */
    function dateKey(value, missingLast) {

        var date = parseISODate(value);

        if (!date) {
            return missingLast ? Number.MAX_SAFE_INTEGER : -1;
        }

        return date.getTime();
    }

    /* ------------------------------------------------------------------ */
    /* Команды: отображение                                               */
    /* ------------------------------------------------------------------ */

    function findTeam(teams, id) {
        var teamId = toInt(id);

        for (var i = 0; i < (teams || []).length; i++) {
            if (toInt(teams[i].id) === teamId) {
                return teams[i];
            }
        }

        return null;
    }

    function getTeamName(teams, id) {
        var team = findTeam(teams, id);
        return team ? team.name : 'Неизвестная команда';
    }

    /**
     * Инициалы для бейджа команды.
     * «Спартак» → «СП», «Реал Мадрид» → «РМ», «ЦСКА» → «ЦС».
     */
    function getTeamInitials(name) {
        var clean = cleanText(name);

        if (!clean) {
            return '?';
        }

        var words = clean.split(' ');

        if (words.length > 1) {
            return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
        }

        // Одно слово: берём первые две буквы (раньше для «ЦСКА» показывалась одна «Ц»)
        return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
    }

    /** Устойчивый цвет бейджа для команды (без inline-стилей — под строгую CSP). */
    function badgeColorForTeam(id) {
        var numeric = toInt(id);
        var index = Math.abs(numeric === null ? 0 : numeric) % BADGE_COLORS.length;
        return BADGE_COLORS[index];
    }

    /* ------------------------------------------------------------------ */
    /* Валидация ввода                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Проверяет название команды.
     * options.ignoreId — команда, которую сейчас переименовывают (чтобы не считать её дублем самой себя).
     */
    function validateTeamName(name, teams, options) {
        var value = cleanText(name, CONFIG.maxTeamNameLength);
        var ignoreId = options && options.ignoreId !== undefined ? toInt(options.ignoreId) : null;

        if (!value) {
            return { ok: false, error: 'Введите название команды' };
        }

        var duplicate = (teams || []).some(function (team) {
            return toInt(team.id) !== ignoreId && cleanText(team.name).toLowerCase() === value.toLowerCase();
        });

        if (duplicate) {
            return { ok: false, error: 'Команда с таким названием уже есть' };
        }

        return { ok: true, value: value };
    }

    /** Проверяет имя игрока (в рамках одной команды имена не должны повторяться). */
    function validatePlayerName(name, team, options) {
        var value = cleanText(name, CONFIG.maxPlayerNameLength);
        var ignoreIndex = options && options.ignoreIndex !== undefined ? toInt(options.ignoreIndex) : null;

        if (!value) {
            return { ok: false, error: 'Введите имя игрока' };
        }

        var players = (team && Array.isArray(team.players)) ? team.players : [];
        var duplicate = players.some(function (player, index) {
            return index !== ignoreIndex && cleanText(player).toLowerCase() === value.toLowerCase();
        });

        if (duplicate) {
            return { ok: false, error: 'Такой игрок уже есть в этой команде' };
        }

        return { ok: true, value: value };
    }

    /**
     * Разбор введённого счёта.
     * '' (пусто) → null, корректное целое 0…maxScore → число, иначе NaN (признак ошибки).
     */
    function normalizeScore(value) {
        if (value === null || value === undefined || String(value).trim() === '') {
            return null;
        }

        var text = String(value).trim();

        if (!/^\d+$/.test(text)) {
            return NaN;
        }

        var number = parseInt(text, 10);

        if (number > CONFIG.maxScore) {
            return NaN;
        }

        return number;
    }

    /**
     * Полная проверка данных матча (при добавлении, изменении и вводе счёта).
     * Возвращает нормализованный объект матча либо текст ошибки.
     */
    function validateMatchInput(input, teams) {
        var source = input || {};
        var teamIds = (teams || []).map(function (team) {
            return toInt(team.id);
        });
        var teamA = toInt(source.teamA);
        var teamB = toInt(source.teamB);
        var date = String(source.date === null || source.date === undefined ? '' : source.date).trim();

        if (teamA === null || teamIds.indexOf(teamA) === -1) {
            return { ok: false, error: 'Выберите первую команду' };
        }

        if (teamB === null || teamIds.indexOf(teamB) === -1) {
            return { ok: false, error: 'Выберите вторую команду' };
        }

        if (teamA === teamB) {
            return { ok: false, error: 'Команды должны быть разными' };
        }

        if (!parseISODate(date)) {
            return { ok: false, error: 'Укажите дату матча' };
        }

        var scoreA = normalizeScore(source.scoreA);
        var scoreB = normalizeScore(source.scoreB);

        if (Number.isNaN(scoreA) || Number.isNaN(scoreB)) {
            return { ok: false, error: 'Счёт — целое число от 0 до ' + CONFIG.maxScore };
        }

        // Раньше можно было ввести только один счёт: значение молча терялось.
        // Теперь требуется заполнить оба поля или ни одного.
        if ((scoreA === null) !== (scoreB === null)) {
            return { ok: false, error: 'Заполните счёт обеих команд или оставьте оба поля пустыми' };
        }

        var finished = scoreA !== null && scoreB !== null;

        return {
            ok: true,
            match: {
                teamA: teamA,
                teamB: teamB,
                date: date,
                scoreA: finished ? scoreA : null,
                scoreB: finished ? scoreB : null,
                finished: finished
            }
        };
    }

    /** Проверка пароля администратора. */
    function adminPasswordMatches(value) {
        return String(value === null || value === undefined ? '' : value) === CONFIG.adminPassword;
    }

    /* ------------------------------------------------------------------ */
    /* Турнирная таблица и статистика                                      */
    /* ------------------------------------------------------------------ */

    function isFinished(match) {
        return !!match && match.finished === true &&
            Number.isInteger(match.scoreA) && Number.isInteger(match.scoreB);
    }

    /** Сортировка матчей по дате. order: 'asc' | 'desc'; матчи без даты всегда в конце. */
    function sortMatches(matches, order) {
        var direction = order === 'asc' ? 1 : -1;

        return (matches || []).slice().sort(function (a, b) {
            var keyA = dateKey(a.date, false);
            var keyB = dateKey(b.date, false);
            var missingA = keyA < 0;
            var missingB = keyB < 0;

            // Матч без даты не должен «всплывать» наверх даже при обратной сортировке
            if (missingA !== missingB) {
                return missingA ? 1 : -1;
            }

            if (!missingA && keyA !== keyB) {
                return (keyA - keyB) * direction;
            }

            return toInt(a.id) - toInt(b.id);
        });
    }

    /** Фильтр матчей для публичного списка: 'all' | 'finished' | 'upcoming'. */
    function selectMatches(matches, filter) {
        var list = (matches || []).filter(function (match) {
            if (filter === 'finished') {
                return isFinished(match);
            }

            if (filter === 'upcoming') {
                return !isFinished(match);
            }

            return true;
        });

        return sortMatches(list, 'desc');
    }

    /**
     * Расчёт турнирной таблицы: победа — 3 очка, ничья — 1.
     * Сортировка: очки → разница мячей → забитые мячи → название (детерминированно).
     */
    function computeStandings(teams, matches) {
        var rows = new Map();

        (teams || []).forEach(function (team) {
            rows.set(toInt(team.id), {
                id: toInt(team.id),
                name: team.name,
                squadSize: Array.isArray(team.players) ? team.players.length : 0,
                played: 0,
                wins: 0,
                draws: 0,
                losses: 0,
                goalsFor: 0,
                goalsAgainst: 0,
                goalDiff: 0,
                points: 0,
                form: []
            });
        });

        // Для формы («последние матчи») важен хронологический порядок
        var finished = sortMatches((matches || []).filter(isFinished), 'asc');

        finished.forEach(function (match) {
            var teamA = rows.get(toInt(match.teamA));
            var teamB = rows.get(toInt(match.teamB));

            if (!teamA || !teamB) {
                return;
            }

            teamA.played += 1;
            teamB.played += 1;
            teamA.goalsFor += match.scoreA;
            teamA.goalsAgainst += match.scoreB;
            teamB.goalsFor += match.scoreB;
            teamB.goalsAgainst += match.scoreA;

            if (match.scoreA > match.scoreB) {
                teamA.wins += 1;
                teamA.points += 3;
                teamB.losses += 1;
                teamA.form.push('W');
                teamB.form.push('L');
            } else if (match.scoreA < match.scoreB) {
                teamB.wins += 1;
                teamB.points += 3;
                teamA.losses += 1;
                teamA.form.push('L');
                teamB.form.push('W');
            } else {
                teamA.draws += 1;
                teamB.draws += 1;
                teamA.points += 1;
                teamB.points += 1;
                teamA.form.push('D');
                teamB.form.push('D');
            }
        });

        var standings = Array.from(rows.values());

        standings.forEach(function (row) {
            row.goalDiff = row.goalsFor - row.goalsAgainst;
            row.form = row.form.slice(-CONFIG.formLength);
        });

        standings.sort(function (a, b) {
            return b.points - a.points ||
                b.goalDiff - a.goalDiff ||
                b.goalsFor - a.goalsFor ||
                String(a.name).localeCompare(String(b.name), 'ru');
        });

        standings.forEach(function (row, index) {
            row.place = index + 1;
        });

        return standings;
    }

    /** Сводная статистика для главной страницы. */
    function getStats(data) {
        var teams = (data && Array.isArray(data.teams)) ? data.teams : [];
        var matches = (data && Array.isArray(data.matches)) ? data.matches : [];

        return {
            teams: teams.length,
            matches: matches.length,
            players: teams.reduce(function (total, team) {
                return total + (Array.isArray(team.players) ? team.players.length : 0);
            }, 0),
            finished: matches.filter(isFinished).length,
            upcoming: matches.filter(function (match) {
                return !isFinished(match);
            }).length,
            goals: matches.filter(isFinished).reduce(function (total, match) {
                return total + match.scoreA + match.scoreB;
            }, 0)
        };
    }

    /* ------------------------------------------------------------------ */
    /* Нормализация данных и хранилище                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Приводит произвольные (в том числе повреждённые или устаревшие) данные
     * к корректной структуре. Возвращает { data, repaired, reason }.
     */
    function normalizeData(raw) {
        if (!isPlainObject(raw) || !Array.isArray(raw.teams) || !Array.isArray(raw.matches)) {
            return {
                data: createDefaultData(),
                repaired: true,
                reason: 'Данные не найдены или повреждены — загружены демонстрационные'
            };
        }

        var updatedAt = (typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)))
            ? raw.updatedAt
            : new Date().toISOString();
        var revision = toInt(raw.revision);

        if (revision === null || revision < 1) {
            revision = 1;
        }

        var repaired = false;
        var usedTeamIds = [];
        var usedTeamNames = [];
        var teams = [];

        raw.teams.forEach(function (team) {
            if (!isPlainObject(team)) {
                repaired = true;
                return;
            }

            var name = cleanText(team.name, CONFIG.maxTeamNameLength);

            if (!name || usedTeamNames.indexOf(name.toLowerCase()) !== -1) {
                repaired = true;
                return;
            }

            var id = toInt(team.id);

            if (id === null || id <= 0 || usedTeamIds.indexOf(id) !== -1) {
                id = nextFreeId(teams);
                repaired = true;
            }

            var players = [];
            var usedPlayerNames = [];

            (Array.isArray(team.players) ? team.players : []).forEach(function (player) {
                var playerName = cleanText(player, CONFIG.maxPlayerNameLength);

                if (!playerName || usedPlayerNames.indexOf(playerName.toLowerCase()) !== -1) {
                    repaired = true;
                    return;
                }

                usedPlayerNames.push(playerName.toLowerCase());
                players.push(playerName);
            });

            usedTeamIds.push(id);
            usedTeamNames.push(name.toLowerCase());
            teams.push({ id: id, name: name, players: players });
        });

        if (!teams.length) {
            // Пустой турнир — допустимое состояние (например, все команды удалили)
            return {
                data: {
                    version: CONFIG.dataVersion,
                    revision: revision,
                    updatedAt: updatedAt,
                    teams: [],
                    matches: []
                },
                repaired: repaired,
                reason: repaired ? 'Часть данных была исправлена автоматически' : ''
            };
        }

        var usedMatchIds = [];
        var matches = [];

        raw.matches.forEach(function (match) {
            if (!isPlainObject(match)) {
                repaired = true;
                return;
            }

            var teamA = toInt(match.teamA);
            var teamB = toInt(match.teamB);

            // Матч без существующих команд или «сам с собой» удаляем
            if (teamA === null || teamB === null || teamA === teamB ||
                usedTeamIds.indexOf(teamA) === -1 || usedTeamIds.indexOf(teamB) === -1) {
                repaired = true;
                return;
            }

            var id = toInt(match.id);

            if (id === null || id <= 0 || usedMatchIds.indexOf(id) !== -1) {
                id = nextFreeId(matches);
                repaired = true;
            }

            var date = typeof match.date === 'string' && parseISODate(match.date) ? match.date.trim() : '';
            if (!date) {
                repaired = true;
            }

            var scoreA = normalizeScore(match.scoreA);
            var scoreB = normalizeScore(match.scoreB);
            var bothScoresValid = Number.isInteger(scoreA) && Number.isInteger(scoreB);

            if (!bothScoresValid) {
                if (scoreA !== null || scoreB !== null) {
                    // Раньше такой матч сохранялся с одним счётом и значение терялось
                    repaired = true;
                }

                scoreA = null;
                scoreB = null;
            }

            usedMatchIds.push(id);
            matches.push({
                id: id,
                teamA: teamA,
                teamB: teamB,
                scoreA: scoreA,
                scoreB: scoreB,
                date: date,
                finished: bothScoresValid
            });
        });

        return {
            data: {
                version: CONFIG.dataVersion,
                revision: revision,
                updatedAt: updatedAt,
                teams: teams,
                matches: matches
            },
            repaired: repaired,
            reason: repaired ? 'Часть данных была исправлена автоматически' : ''
        };
    }

    /**
     * Помечает данные как изменённые: увеличивает revision и обновляет updatedAt.
     * Вызывается при каждом сохранении — синхронизация по этим полям понимает,
     * какая версия документа новее (локальная, в репозитории или у другого устройства).
     */
    function touchData(data, now) {
        if (!isPlainObject(data)) {
            return data;
        }

        data.revision = (toInt(data.revision) || 0) + 1;
        data.updatedAt = (now instanceof Date ? now : new Date()).toISOString();

        return data;
    }

    /** Чтение данных из localStorage. Всегда возвращает корректную структуру (даже при сбое). */
    function loadFromStorage(storage) {

        if (!storage) {
            return {
                data: createDefaultData(),
                repaired: true,
                reason: 'Локальное хранилище недоступно — изменения не сохранятся',
                fresh: false,
                error: 'storage-unavailable'
            };
        }

        var raw = null;

        try {
            raw = storage.getItem(CONFIG.storageKey);
        } catch (error) {
            return {
                data: createDefaultData(),
                repaired: true,
                reason: 'Нет доступа к локальному хранилищу — изменения не сохранятся',
                fresh: false,
                error: 'storage-denied'
            };
        }

        // Первый запуск: данных ещё нет — тихо показываем демонстрационный набор
        if (raw === null || raw === '') {
            return {
                data: createDefaultData(),
                repaired: false,
                reason: '',
                fresh: true,
                error: ''
            };
        }

        var parsed = null;

        try {
            parsed = JSON.parse(raw);
        } catch (error) {
            // Раньше здесь падал весь скрипт, и страница оставалась пустой
            return {
                data: createDefaultData(),
                repaired: true,
                reason: 'Сохранённые данные повреждены — загружены демонстрационные',
                fresh: false,
                error: 'invalid-json'
            };
        }

        var normalized = normalizeData(parsed);

        return {
            data: normalized.data,
            repaired: normalized.repaired,
            reason: normalized.reason,
            fresh: false,
            error: ''
        };
    }

    /** Запись данных в localStorage. */
    function saveToStorage(storage, data) {
        if (!storage) {
            return { ok: false, error: 'Локальное хранилище недоступно — изменения не сохранятся' };
        }

        try {
            storage.setItem(CONFIG.storageKey, JSON.stringify(data));
            return { ok: true };
        } catch (error) {
            return { ok: false, error: 'Не удалось сохранить данные (хранилище недоступно или переполнено)' };
        }
    }

    /** Данные → текст JSON для экспорта. */
    function serializeData(data) {
        return JSON.stringify({
            version: CONFIG.dataVersion,
            exportedAt: new Date().toISOString(),
            teams: (data && data.teams) || [],
            matches: (data && data.matches) || []
        }, null, 2);
    }

    /** Проверка и разбор импортируемого JSON. */
    function parseImport(text) {
        var parsed = null;

        try {
            parsed = JSON.parse(String(text));
        } catch (error) {
            return { ok: false, error: 'Файл не является корректным JSON' };
        }

        if (!isPlainObject(parsed) || !Array.isArray(parsed.teams) || !Array.isArray(parsed.matches)) {
            return { ok: false, error: 'В файле нет списков команд и матчей' };
        }

        var normalized = normalizeData(parsed);

        return { ok: true, data: normalized.data, repaired: normalized.repaired };
    }

    /* ------------------------------------------------------------------ */

    return {
        CONFIG: CONFIG,
        BADGE_COLORS: BADGE_COLORS,
        createDefaultData: createDefaultData,
        deepCopy: deepCopy,
        escapeHtml: escapeHtml,
        cleanText: cleanText,
        toInt: toInt,
        nextFreeId: nextFreeId,
        parseISODate: parseISODate,
        toISODate: toISODate,
        todayISO: todayISO,
        formatDate: formatDate,
        formatDateTime: formatDateTime,
        dateKey: dateKey,
        findTeam: findTeam,
        getTeamName: getTeamName,
        getTeamInitials: getTeamInitials,
        badgeColorForTeam: badgeColorForTeam,
        validateTeamName: validateTeamName,
        validatePlayerName: validatePlayerName,
        normalizeScore: normalizeScore,
        validateMatchInput: validateMatchInput,
        adminPasswordMatches: adminPasswordMatches,
        isFinished: isFinished,
        sortMatches: sortMatches,
        selectMatches: selectMatches,
        computeStandings: computeStandings,
        getStats: getStats,
        touchData: touchData,
        normalizeData: normalizeData,
        loadFromStorage: loadFromStorage,
        saveToStorage: saveToStorage,
        serializeData: serializeData,
        parseImport: parseImport
    };
});
