# Gemini VS Code Agent

Локальное расширение VS Code, которое подключает Gemini API к агенту с доступом к файлам прямо в native Chat UI VS Code.

## Что умеет

- native chat participant `@gemini` в Chat view VS Code;
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

5. Откройте Chat в VS Code и используйте `@gemini`, либо выполните команду `Gemini Agent: Open Chat`.

Если ключ не задан, расширение само покажет окно ввода и предложит вставить API key.

## Настройки

- `geminiAgent.apiKey`: API-ключ Gemini
- `geminiAgent.model`: модель Gemini, по умолчанию `gemini-2.5-flash`
- `geminiAgent.allowOutsideWorkspace`: разрешить абсолютные пути вне workspace
- `geminiAgent.confirmDangerousWrites`: включить или отключить подтверждение опасной записи
- `geminiAgent.maxFileBytes`: лимит на чтение одного файла

## Команды

- `Gemini Agent: Open Chat`
- `Gemini Agent: Set API Key`
- `Gemini Agent: Clear API Key`
- `Gemini Agent: Reset Session`

## Безопасность

По умолчанию агент работает только в пределах открытого workspace. Если включить `geminiAgent.allowOutsideWorkspace`, он сможет читать и писать абсолютные пути локальной машины через инструменты расширения.

Если `geminiAgent.confirmDangerousWrites` включен, расширение будет запрашивать подтверждение перед:

- перезаписью существующего файла;
- записью вне текущего workspace.
