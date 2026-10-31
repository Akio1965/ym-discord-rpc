**English:** a Linux-only daemon that shows the track playing in the Yandex Music desktop app as a Discord Rich Presence "Listening" card (cover, links, live progress bar), without modifying the app.
Unofficial project, not affiliated with or endorsed by Yandex or Discord. "Yandex Music" and "Discord" are trademarks of their respective owners; the images in `assets/` are original drawings, not the Yandex Music logo.

# ym-discord-rpc

Демон на Node.js/TypeScript, который показывает трек из десктопной Яндекс Музыки как Discord Rich Presence. Друзья видят карточку «Слушает Яндекс Музыка» с обложкой, названием, артистом, полосой прогресса и кнопкой «Слушать в Яндекс Музыке».

Приложение Яндекс Музыки **не модифицируется** и не перезапускается. Демон только читает его состояние через стандартный MPRIS (D-Bus), как это делает виджет плеера в панели. Токены и вход в аккаунт не нужны.

> [!WARNING]
> **⚠️ Только Linux.** Плеер читается через MPRIS (D-Bus), который есть только в Linux. Для Windows (SMTC) и macOS источника пока нет, поэтому они не поддерживаются. Планов не обещаю, но PR приветствуются.
>
> Что нужно:
> - Linux-десктоп с сессионной шиной D-Bus (GNOME, KDE, Hyprland, Sway и другие современные окружения);
> - **официальное десктопное приложение Яндекс Музыки для Linux** (deb-пакет; на Arch, например, `yandex-music-bin` из AUR). **Веб-версия в браузере не поддерживается:** демон ищет плеер с MPRIS Identity `YandexMusic`, а браузер представляется своим именем;
> - **десктопный Discord.** С нативным Discord проверено. Пути к сокетам Flatpak, Snap и Vesktop (arRPC) демон тоже перебирает: должно работать, но не проверялось;
> - **Node.js 24 или новее.** Node исполняет `.ts` напрямую, сборка не нужна.

## Что увидят друзья

- **Карточка в профиле:**
  - заголовок «Слушает Яндекс Музыка» (поле `name` в конфиге);
  - обложка альбома; при наведении видно название альбома (если оно отличается от названия трека), клик открывает альбом;
  - название трека со ссылкой на трек и артист со ссылкой на артиста (если трек найден в каталоге Яндекса);
  - полоса прогресса «1:10 ━━━━──── 3:43», которая движется сама;
  - кнопка «Слушать в Яндекс Музыке». Если трек не найден в каталоге, она ведёт на поиск.
- **Строка под ником** в списке участников и в личных сообщениях: «Слушает PinkPantheress» (настраивается через `statusDisplayType`).
- **Пауза:** полоса исчезает, в углу обложки появляется значок «На паузе». Через `afkMinutes` минут (по умолчанию 10) карточка убирается и возвращается, когда музыка снова играет.
- **Яндекс Музыка закрыта или демон остановлен:** карточка исчезает сразу.
- **Кнопки не видны вам самим.** Discord не показывает кнопки в вашем собственном профиле, это нормально. Проверяйте со второго аккаунта или попросите друга.
- **Игра важнее.** Если запущена игра, Discord показывает её выше и в строке под ником. Изменить этот приоритет нельзя.

## Как это работает

```
Яндекс Музыка (как есть, без модов)
   │  MPRIS / D-Bus: название, артисты, альбом, длительность, позиция, play/pause
   ▼
ym-discord-rpc ── новый трек ──► поиск в каталоге api.music.yandex.net: id, ссылки, обложка
   │                             └─ обложки нет → iTunes Search (только обложка)
   │  ◄── TrackInfo
   ▼
Discord IPC ($XDG_RUNTIME_DIR/discord-ipc-0) ──► Discord ──► друзья видят карточку
```

- **Полоса прогресса держится сама.** Демон отправляет абсолютные `start`/`end`, и клиент каждого зрителя двигает полосу без новых сообщений. Повторная отправка нужна только при смене трека, паузе, перемотке или смене скорости.
- **Наружу уходит только поисковый запрос** «артист + название» на `api.music.yandex.net` и `itunes.apple.com`. Картинку обложки Discord забирает сам.

Подробности: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Установка

```bash
git clone https://github.com/Akio1965/ym-discord-rpc.git
cd ym-discord-rpc
npm ci
```

1. **Создайте Discord-приложение и загрузите картинки.** Это несколько минут, пошагово в таблице [«Что нужно поменять»](#что-нужно-поменять).
2. **Создайте конфиг** и впишите в него `clientId`:
   ```bash
   mkdir -p ~/.config/ym-discord-rpc
   cp config.example.json ~/.config/ym-discord-rpc/config.json
   ${EDITOR:-nano} ~/.config/ym-discord-rpc/config.json
   ```
3. **Пробный запуск без Discord.** Включите трек в Яндекс Музыке и выполните:
   ```bash
   npm run dump          # 30 секунд; или: node scripts/dump.ts 60
   ```
   Скрипт печатает снимки плеера (`SNAPSHOT`), найденный в каталоге трек (`TRACK_INFO`) и activity, которая ушла бы в Discord (`SET_ACTIVITY`). В Discord он ничего не отправляет.
4. **Запуск по-настоящему:**
   ```bash
   npm start             # Ctrl+C очищает карточку и завершает процесс
   ```
   Если `clientId` пустой, демон работает в режиме dry run: печатает activity в консоль вместо отправки.
5. **Автозапуск** при входе в систему: см. [«Автозапуск (systemd)»](#автозапуск-systemd).

## Что нужно поменять

В репозитории нет ничьих личных значений: всё, что зависит от вас, оставлено пустым или заглушкой. Вот полный список.

| Файл | Поле | Что вписать | Где взять |
|---|---|---|---|
| `~/.config/ym-discord-rpc/config.json` (копия `config.example.json`) | `clientId` | **Обязательно.** Application ID вашего Discord-приложения: строка из цифр, например `"123456789012345678"`. Пустая строка означает dry run | https://discord.com/developers/applications → **New Application** → назовите, например, «Яндекс Музыка» → **General Information** → **Application ID** → Copy. Secret, OAuth2 и Redirect не нужны |
| там же | `assets.logo` | `"logo"` (по умолчанию), то есть ключ ассета. Или ссылка на эмодзи, см. ниже | В приложении на портале: **Rich Presence → Art Assets** → загрузите `assets/logo.png` с именем `logo`. Показывается вместо обложки, если её не нашли |
| там же | `assets.paused` | `"paused"` (по умолчанию). Или ссылка на эмодзи | Там же загрузите `assets/paused.png` с именем `paused`. Это маленький значок «На паузе» в углу обложки |
| там же | `name`, `statusDisplayType`, `buttons`, `afkMinutes`, `search` | По желанию, значения по умолчанию разумные | См. [«Конфигурация»](#конфигурация) |
| `packaging/ym-discord-rpc.service`, установленный в `~/.config/systemd/user/ym-discord-rpc.service` | `/ПУТЬ/К/node` в `ExecStart` | Абсолютный путь к node 24+ | `node -p process.execPath` |
| там же | `/ПУТЬ/К/ym-discord-rpc` в `WorkingDirectory` и `ExecStart` | Абсолютный путь к вашему клону репозитория | `pwd` в каталоге проекта |

Обе строки юнита за вас заполняет `scripts/install-service.sh` (см. «Автозапуск»).

**Про картинки:**
- Ассеты можно не загружать. Тогда без найденной обложки картинки в карточке не будет, а на паузе не будет значка.
- Имена ассетов могут быть любыми, главное, чтобы они совпадали с `assets.logo` и `assets.paused`.
- Discord подхватывает новые ассеты не мгновенно: если картинка не появилась сразу, подождите.
- **Альтернатива: эмодзи приложения.** Если ассеты не появляются, загрузите те же `assets/logo.png` и `assets/paused.png` в раздел **Emojis** вашего приложения на портале, скопируйте ID каждого эмодзи и впишите ссылки:
  ```json
  "assets": {
    "logo": "https://cdn.discordapp.com/emojis/<ID логотипа>.png",
    "paused": "https://cdn.discordapp.com/emojis/<ID значка паузы>.png"
  }
  ```
  Discord хранит эмодзи в размере 128×128, поэтому крупный логотип будет немного мягче. Для маленького значка паузы этого хватает.

## Конфигурация

Файл `~/.config/ym-discord-rpc/config.json` (или `$XDG_CONFIG_HOME/ym-discord-rpc/config.json`). Все поля необязательны: отсутствующие берутся из значений по умолчанию. Конфиг читается при старте, после правки перезапустите демон.

| Поле | По умолчанию | Что делает |
|---|---|---|
| `clientId` | `""` | Application ID Discord-приложения. Пустой означает dry run: activity печатается в stdout. |
| `name` | `"Яндекс Музыка"` | Имя активности, то есть заголовок «Слушает …» в карточке. Отправляется вместо имени Discord-приложения; надёжнее всего назвать само приложение на портале так же. |
| `statusDisplayType` | `1` | Что писать в строке под ником: `0` — имя (`name`), `1` — артист («Слушает PinkPantheress»), `2` — название трека. |
| `buttons` | `["web"]` | `"web"` добавляет кнопку «Слушать в Яндекс Музыке» со ссылкой на трек (или на поиск, если трек не найден в каталоге). `[]` убирает кнопку. |
| `afkMinutes` | `10` | Сколько минут держать карточку на паузе. `0` убирает её сразу. Значения больше 35 791 (24,8 суток, предел таймеров Node) ограничиваются им, так что большое число означает «не убирать». |
| `search.yandex` | `true` | Искать трек в каталоге Яндекса: обложка и ссылки на трек, альбом и артиста. |
| `search.itunes` | `true` | Запасной источник обложки, если Яндекс недоступен или не нашёл обложку. Ссылок не даёт. |
| `dryRun` | `false` | Печатать activity вместо отправки в Discord. |
| `assets.logo` | `"logo"` | Ключ ассета (или https-ссылка) для картинки, когда обложки нет. |
| `assets.paused` | `"paused"` | Ключ ассета (или https-ссылка) для значка паузы. |

Переменные окружения:
- `YM_RPC_CLIENT_ID` перекрывает `clientId`;
- `YM_RPC_DRY_RUN=1` включает dry run;
- `LOG_LEVEL=debug|info|warn|error` задаёт уровень логов (по умолчанию `info`). Логи пишутся в stderr; под systemd они попадают в journald.

## Автозапуск (systemd)

Юнит запускается от вашего пользователя (`systemctl --user`) вместе с графической сессией и при остановке очищает карточку.

**Скриптом** (подставит пути к node и к репозиторию, включит и запустит сервис):
```bash
scripts/install-service.sh              # установить или обновить и (пере)запустить
scripts/install-service.sh --no-start   # только записать юнит и показать команды systemctl
NODE=/usr/bin/node scripts/install-service.sh   # взять конкретный node
```

**Вручную:**
```bash
mkdir -p ~/.config/systemd/user
cp packaging/ym-discord-rpc.service ~/.config/systemd/user/
${EDITOR:-nano} ~/.config/systemd/user/ym-discord-rpc.service   # замените /ПУТЬ/К/... (таблица выше)
systemctl --user daemon-reload
systemctl --user enable --now ym-discord-rpc
```

Путь к node нужен абсолютный: systemd не видит `PATH` из вашего shell, а шимы менеджеров версий (nvm, fnm, mise, asdf) без shell могут не работать. Скрипт сам находит настоящий бинарник через `process.execPath`.

**Управление:**
```bash
journalctl --user -u ym-discord-rpc -f          # логи
systemctl --user restart ym-discord-rpc         # после правки config.json
systemctl --user stop ym-discord-rpc            # остановить (карточка очищается)
systemctl --user disable --now ym-discord-rpc   # выключить автозапуск
```

**Сервис не стартует при входе.** Юнит привязан к `graphical-session.target`. Проверьте `systemctl --user is-active graphical-session.target`: если ответ не `active` (так бывает с оконными менеджерами, запущенными без интеграции с systemd), замените в установленном юните `WantedBy=graphical-session.target` на `WantedBy=default.target` и выполните `systemctl --user reenable ym-discord-rpc`. Повторный запуск `install-service.sh` вернёт строку из шаблона.

**`status=203/EXEC` в `systemctl --user status ym-discord-rpc`.** Путь к node устарел (например, после обновления node через nvm) или репозиторий переехал. Запустите `scripts/install-service.sh` ещё раз.

## Решение проблем

**Логи.** Под systemd: `journalctl --user -u ym-discord-rpc -f`. Подробности видны при `LOG_LEVEL=debug npm start` или если добавить переменную в сервис через `systemctl --user edit ym-discord-rpc`:
```ini
[Service]
Environment=LOG_LEVEL=debug
```

**Обложки нет, в логе `yandex: HTTP 451; skipping yandex for 600 s`.** Поиск Яндекса отвечает 451 (гео-блокировка), если трафик идёт через VPN, например Cloudflare WARP. Демон 10 минут не ходит в Яндекс и берёт обложку из iTunes, но тогда нет ссылок на трек и артиста, а кнопка ведёт на поиск. Варианты:
- выключить VPN;
- исключить `api.music.yandex.net` из туннеля (split tunnel). Для WARP в новых версиях `warp-cli` это `warp-cli tunnel host add api.music.yandex.net`; синтаксис зависит от версии.

**Карточки нет совсем.**
1. Запущен ли Discord? Сообщение `no Discord IPC socket accepted a connection (is Discord running?)` значит, что сокет не найден. Демон сам пробует снова каждые 5–30 с, перезапускать его не нужно.
2. Включён ли показ активности: в настройках Discord, раздел «Конфиденциальность действий» (Activity Privacy), должен быть включён показ текущей активности.
3. Не запущена ли игра: она вытесняет карточку (см. выше).
4. Задан ли `clientId`? Без него при старте в логе будет `no clientId in …: dry run`.
5. `Discord rejected client id "…"` (`CLOSE 4000`) означает неверный `clientId`: нужен именно Application ID, а не Public Key или Client Secret.
6. Если `npm run dump` не печатает ни одного `SNAPSHOT`, демон не видит Яндекс Музыку. Убедитесь, что приложение запущено и что-то играет, и проверьте MPRIS:
   ```bash
   busctl --user list | grep mpris
   busctl --user get-property org.mpris.MediaPlayer2.chromium.instance<PID> /org/mpris/MediaPlayer2 org.mpris.MediaPlayer2 Identity   # "YandexMusic"
   ```

**Discord из Flatpak, Snap или Vesktop.** Сокеты ищутся в `$XDG_RUNTIME_DIR`, `$TMPDIR`, `$TMP`, `$TEMP`, `/run/user/$UID` и `/tmp`, включая подкаталоги ниже. Эти варианты не проверялись.

| Клиент | Путь к сокету |
|---|---|
| Discord (нативный) | `$XDG_RUNTIME_DIR/discord-ipc-0` |
| Discord Flatpak (Stable, PTB, Canary) | `$XDG_RUNTIME_DIR/app/com.discordapp.Discord/discord-ipc-0` (`…DiscordPTB`, `…DiscordCanary`) |
| Vesktop Flatpak | `$XDG_RUNTIME_DIR/.flatpak/dev.vencord.Vesktop/xdg-run/discord-ipc-0` или `$XDG_RUNTIME_DIR/app/dev.vencord.Vesktop/discord-ipc-0` |
| Discord Snap | `$XDG_RUNTIME_DIR/snap.discord/discord-ipc-0` |

Проверить, есть ли сокет: `ls -la $XDG_RUNTIME_DIR/discord-ipc-* $XDG_RUNTIME_DIR/app/*/discord-ipc-* 2>/dev/null`. В Vesktop нужно включить arRPC в настройках. arRPC может не поддерживать новые поля (`status_display_type`, ссылки `details_url`/`state_url`), тогда карточка будет проще.

**Вместо обложки логотип.** Возможные причины:
- трек не найден в каталоге: UGC, подкасты, локальные файлы, сильно отличающееся название;
- поиск выключен или недоступен. После сетевой ошибки демон повторяет поиск один раз через минуту, а также когда трек снова появляется после перезапуска Яндекс Музыки;
- Discord не смог загрузить внешнюю картинку. Тогда в логе есть `Discord rejected cover … retrying with the logo`.

**Полоса прогресса расходится с плеером.** Зрители считают время по своим часам относительно абсолютных timestamps, поэтому системные часы должны быть синхронизированы (`timedatectl` → `System clock synchronized: yes`).

## Ограничения

- **Только Linux** и только десктопное приложение (MPRIS). Музыка с телефона или из веб-версии не показывается.
- **Обложка и ссылки зависят от поиска по каталогу.** MPRIS не отдаёт id трека и https-обложку, поэтому демон ищет трек по «артист + название» и строго сверяет артистов и длительность. Подкасты, аудиокниги, UGC и локальные файлы часто не находятся, тогда карточка показывается с логотипом. Без артиста поиск не выполняется.
- **Версия трека не видна.** В MPRIS-названии нет версии («Remix», «Slowed»), поэтому оригинал и ремикс похожей длины различаются только по альбому. При равенстве выигрывает оригинал.
- **Скорость воспроизведения оценивается.** Яндекс Музыка не сообщает её через MPRIS (`Rate` всегда 1), демон вычисляет её по движению позиции. После смены скорости полоса может быть неточной около 10 секунд.
- Перемотка меньше чем на ~1,5 с без сигнала `Seeked` не отражается.
- С плавными переходами (crossfade) смена трека появляется с задержкой на длину перехода.
- **Неофициальное API.** Поиск Яндекса не документирован, лимиты неизвестны, он может измениться или перестать отвечать без предупреждения.

## Разработка

```bash
npm test                        # node --test 'test/**/*.test.ts'
npm run typecheck               # tsc --noEmit
node scripts/live-mpris.ts 20   # только снимки MPRIS, по одной JSON-строке
```

Тесты не трогают ни настоящий Discord, ни вашу сессионную шину: IPC проверяется на фейковом сервере во временном сокете, MPRIS на отдельном `dbus-daemon` (если его нет в системе, эти тесты пропускаются).

Node исполняет `.ts` через type stripping, поэтому годятся только стираемые конструкции TypeScript: без `enum`, `namespace`, parameter properties и декораторов. Импорты пишутся с расширением `.ts`. Устройство модулей описано в [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Благодарности

- [PulseSync](https://github.com/PulseSync-LLC): вдохновение и образец карточки (ссылки на трек, артиста и альбом, значок паузы, очистка после простоя). PulseSync встраивается в само приложение Яндекс Музыки; здесь другой подход, и код PulseSync не использовался.
- [FozerG/WinYandexMusicRPC](https://github.com/FozerG/WinYandexMusicRPC): подход к сопоставлению трека с каталогом без токена (нормализация названий, сверка артистов и длительности). `src/enrich/matcher.ts` написан заново на TypeScript со своей системой оценок, код не копировался.
- [MarshalX/yandex-music-api](https://github.com/MarshalX/yandex-music-api): неофициальная документация API Яндекс Музыки.
- [@jellybrick/dbus-next](https://github.com/JellyBrick/node-dbus-next) (MIT): клиент D-Bus.

«Яндекс Музыка» и Discord — товарные знаки своих владельцев. Проект неофициальный и не связан ни с Яндексом, ни с Discord. Картинки в `assets/` нарисованы для этого проекта и не являются логотипом Яндекс Музыки.

## Лицензия

[MIT](LICENSE)
