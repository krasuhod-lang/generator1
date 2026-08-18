"""pipeline_py — слоистый пайплайн парсинга по ТЗ.

Слои (каждый изолирован и обрабатывает свои классы ошибок):

    1. URL-очередь            -> app.queue      (персистентная, возобновляемая)
    2. Fetcher (HTTP/браузер) -> app.fetcher    (клиент к relevance_fetcher)
    3. Очиститель HTML        -> app.cleaner
    4. LLM-анализатор         -> app.orchestrator (pluggable analyzer)
    5. JSON-валидатор         -> app.orchestrator (pluggable validator)
    6. Retry / резерв         -> app.orchestrator
    7. Хранилище (Excel/БД)   -> app.orchestrator (pluggable sink)
    8. Журналирование         -> logging
"""
