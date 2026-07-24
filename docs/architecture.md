# Архитектура osnova-runtime

`osnova-runtime` — обязательный локальный backend Osnova Reborn. Desktop main process и headless CLI используют версионированный JSON-RPC 2.0 поверх Unix socket или named pipe.

## Сервисы

- Project Service — явное открытие, проверка и миграция проекта.
- Extension Manager — staging, проверка, активация, подключение и rollback.
- Operation Registry и Policy Engine — схемы, permissions и risk-policy.
- Job Manager — прогресс, отмена, журнал и crash recovery.
- Runtime Supervisor — builtin/process/OCI/remote drivers.
- Artifact Ingestor — единственная точка проверки и публикации extension outbox
  в проект. Привилегированные built-ins используют атомарные core API и обязаны
  вернуть `publishedArtifactIds` в тот же job/session/artifact contract.
- Session Store — переносимая история запросов, планов, вызовов и подтверждений.
- Context Broker — compact/expanded контекст с бюджетом и источниками.
- Connector Engine — возобновляемые project-scoped импорты.
- Model Manager — content-addressed cache и проверка зависимостей.
- Agent Orchestrator — видимый ограниченный план без доступа к shell.
- Diagnostics — проверка среды без требования AI или Docker.

## Безопасная деградация

Отсутствие Docker, модели или расширения отражается диагностикой и состоянием capability. Оно не мешает открыть проект, читать Markdown, импортировать файлы и выполнять доступные builtin-операции.

Если встроенный Node не предоставляет SQLite FTS5, Context Indexer атомарно
создаёт удаляемый portable-индекс в `.osnova/index/context.json`. Это более
простой поиск, но проект и контекст не перестают работать.

## Жизненный цикл инструментов

- `job` запускает отдельный process/container для одного вызова;
- `project` переиспользует process внутри одного проекта до `runtime.stop` или idle timeout;
- `shared` переиспользует process между проектами и по умолчанию останавливает его после 300 секунд простоя.

`node-process` и `native-process` поддерживают все три режима. OCI намеренно
ограничен `job`: каждый вызов получает новые read-only input/models mounts и
свой outbox, не раскрывая контейнеру папку проекта или данные соседнего запуска.
Supervisor контролирует заявленный writable disk budget во время вызова и
повторно проверяет его перед принятием результата, поэтому oversized work/outbox
отклоняется до публикации.

## Версии расширений и локальное доверие

Установленные версии расширения хранятся side-by-side. `osnova.json` задаёт
переносимое требование (точная версия, `^`, `~`, `*` или `latest`), а
`.osnova/extensions/lock.json` фиксирует выбранную на этом компьютере версию и
integrity пакета. Registry выбирает Operation, Runtime, Context Provider,
Connector и Model Provider по lock конкретного проекта: обновление одного
проекта не переключает реализацию в другом.

Lock является удаляемым производным состоянием и пересобирается только из
установленных совместимых версий. Grants и сохранённые policy rules намеренно
не читаются из папки проекта: они лежат в локальном runtime state, привязанном к
абсолютному пути проекта. Перенос проекта сохраняет audit trail, но требует
заново подтвердить доверие на новом компьютере.

При старте и активации Extension Manager заново хеширует файлы установленной
версии по immutable install record. Изменённая или неполная версия не
регистрируется и показывается `diagnostics.doctor`; остальные проекты и built-in
tools продолжают работать.

MCP adapter отображает Tools в Operations, `resources/read` в Context Envelope,
а экспериментальный MCP task — во внутреннее ожидание Osnova Job. Отмена и
таймаут принадлежат Job Manager Osnova; MCP task не становится источником истины.

Model Manager пишет локальные project-to-digest usage records при reconcile
extension lock. `model.remove` сам вычисляет dependents и не доверяет переданному
клиентом списку; повреждённый usage record консервативно блокирует удаление до
диагностики.
