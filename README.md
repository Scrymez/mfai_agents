# Gemini VS Code Agent

Локальное расширение VS Code, которое подключает Gemini API к агенту с доступом к файлам и отдельной чат-панелью в боковой панели, как отдельный интерфейс расширения.

## Что умеет

- отдельная кнопка `Gemini Agent` в Activity Bar;
- собственная чат-панель с инпутом, историей сообщений и кнопками `API Key`/`Reset`;
- optional native chat participant `@gemini` в Chat view VS Code;
- доступ к файлам через инструменты `list_files`, `read_file`, `write_file`, `search_text`;
- потоковый вывод ответа Gemini в чате;
- подтверждение опасных операций записи с возможностью отключить;
- ограничение доступа только рабочей папкой или разрешение на абсолютные пути через настройку.

## Быстрый старт

1. Установите зависимости:

```bash
npm install
```

2. Соберите расширение:

```bash
npm run compile
```

3. Откройте папку в VS Code и нажмите `F5`, чтобы запустить Extension Development Host.

4. Укажите API-ключ одним из способов:

- команда `Gemini Agent: Set API Key` и вставьте ключ в открывшийся input
- `Settings` -> `Gemini Agent: Api Key`
- переменная окружения `GEMINI_API_KEY`

5. Нажмите на иконку `Gemini Agent` в Activity Bar слева или выполните команду `Gemini Agent: Open Chat`.
6. Для встроенного чата VS Code по-прежнему доступен `@gemini` через команду `Gemini Agent: Open Native Chat`.

Если ключ не задан, расширение само покажет окно ввода и предложит вставить API key.

## Timeweb Cloud

Если у вас AI-агент Timeweb Cloud, используйте не `Access ID`, а:

- токен из блока `Токены авторизации` как `API Key`
- `OpenAI URL` как `Base URL`
- настройку `geminiAgent.apiStyle = openai-compatible`

После этого выполните:

- `Gemini Agent: Set Base URL`
- `Gemini Agent: Set API Key`

## Настройки

- `geminiAgent.apiKey`: API-ключ Gemini
- `geminiAgent.apiStyle`: `gemini` или `openai-compatible`
- `geminiAgent.baseUrl`: base URL для OpenAI-compatible провайдера
- `geminiAgent.model`: модель Gemini, по умолчанию `gemini-2.5-flash`
- `geminiAgent.allowOutsideWorkspace`: разрешить абсолютные пути вне workspace
- `geminiAgent.confirmDangerousWrites`: включить или отключить подтверждение опасной записи
- `geminiAgent.maxFileBytes`: лимит на чтение одного файла

## Команды

- `Gemini Agent: Open Chat`
- `Gemini Agent: Open Native Chat`
- `Gemini Agent: Set Base URL`
- `Gemini Agent: Set API Key`
- `Gemini Agent: Clear Base URL`
- `Gemini Agent: Clear API Key`
- `Gemini Agent: Reset Session`

## Безопасность

По умолчанию агент работает только в пределах открытого workspace. Если включить `geminiAgent.allowOutsideWorkspace`, он сможет читать и писать абсолютные пути локальной машины через инструменты расширения.

Если `geminiAgent.confirmDangerousWrites` включен, расширение будет запрашивать подтверждение перед:

- перезаписью существующего файла;
- записью вне текущего workspace.
