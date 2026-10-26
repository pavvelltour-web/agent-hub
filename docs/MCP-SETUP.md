# Подключение Mobbin и shadcn MCP

> Статус: инструкция, ничего не установлено. Проверено 2026-10-22 по документации shadcn и описаниям официального сервера Mobbin. Команды запускаете вы.

## Что уже есть у вас

- **Codex:** в кэше плагинов есть официальное приложение **Mobbin** (автор Mobbin Pte. Ltd., `openai-curated-remote`). Его подключают в интерфейсе Codex, как приложение аккаунта ChatGPT, без правки конфига.
- **Claude Code:** ни Mobbin, ни shadcn в конфигах нет.
- **Ваш пайплайн** (`product-ui-workbench`, `references/tool-adapters.md`) уже описывает, как вызывать `search_screens`, `search_flows` и инструменты shadcn и как фиксировать квитанции. После подключения правила менять не нужно.

## Mobbin (официальный MCP)

- Адрес: `https://api.mobbin.com/mcp`, транспорт Streamable HTTP, вход через OAuth (ключ не нужен).
- Нужен платный план Mobbin (Pro, Team или Enterprise). Ограничение — 60 запросов в минуту на пользователя.
- Инструменты: `search_screens`, `search_flows`, `search_sections`.

**Claude Code** (на уровне пользователя, чтобы работало во всех проектах):

```bash
claude mcp add --transport http --scope user mobbin https://api.mobbin.com/mcp
```

Затем в Claude Code выполните `/mcp`, выберите `mobbin` и пройдите вход в браузере.

**Codex:** включите приложение Mobbin в настройках приложений Codex. Если нужен именно MCP в `config.toml`, добавьте:

```toml
[mcp_servers.mobbin]
url = "https://api.mobbin.com/mcp"
```

Затем `codex mcp login mobbin`. Формат `url` и команду `login` я не проверял на вашей версии Codex. Если не сработает, используйте приложение из интерфейса.

## shadcn MCP

Нужен проект с корректным `components.json`; для стандартного реестра дополнительная настройка не нужна.

**Claude Code**, в корне проекта:

```bash
npx shadcn@latest mcp init --client claude
```

Или вручную в `.mcp.json` проекта:

```json
{
  "mcpServers": {
    "shadcn": { "command": "npx", "args": ["shadcn@latest", "mcp"] }
  }
}
```

Перезапустите Claude Code и проверьте `/mcp`: сервер должен быть `Connected`.

**Codex**, вручную в `~/.codex/config.toml` (CLI shadcn его не правит):

```toml
[mcp_servers.shadcn]
command = "npx"
args = ["shadcn@latest", "mcp"]
```

Перезапустите Codex.

## Как это будет делать панель

`hub mcp add mobbin` и `hub mcp add shadcn` выполнят те же шаги: покажут адрес, права и лицензию, запишут в `.mcp.json` и `config.toml` после вашего подтверждения, а потом проверят подключение командой `hub mcp test`. Секреты в файлы не пишутся: OAuth проходит в самом агенте.

## Где нужны

- Этап дизайна в жизненном цикле (обязательные `product-ui-workbench` и `design-quality-loop`).
- Интерфейс самой панели (часть 5).
- Для сборки ядра (части 1–4) эти серверы не нужны. Подключайте их на уровне проекта, когда дойдёте до интерфейса, чтобы не платить за описания их инструментов раньше времени.
