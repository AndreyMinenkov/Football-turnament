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
    var CONFIG = L.CONFIG;

    /** Состояние приложения (в хранилище попадает только state.data). */
    var state = {
        data: L.createDefaultData(),
        storage: null,
        storageAvailable: true,
        admin: false,
        route: 'home',
        matchesFilter: 'all',
        editingTeamId: null,
        editingMatchId: null,
        editingPlayer: null
    };

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

    /** Сохранение данных + полная перерисовка + необязательное уведомление. */
    function saveData(message) {
        var result = L.saveToStorage(state.storage, state.data);
        state.storageAvailable = result.ok;

        if (!result.ok && result.error) {
            toast(result.error, 'error');
        }

        renderAll();

        if (message) {
            toast(message, 'success');
        }

        return result.ok;
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
        state.storage = getStorage('local');

        var loaded = L.loadFromStorage(state.storage);

        state.data = loaded.data;
        state.admin = readAdminSession();
        state.storageAvailable = !!state.storage;

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
            render: renderAll
        };
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

