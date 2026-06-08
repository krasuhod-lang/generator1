# =============================================================================
# Relevance Headless Fetcher — FastAPI + Playwright (Chromium) + stealth.
#
# Назначение: «firecrawl-class» fallback для backend/src/services/relevance/
# pageFetcher.js. axios-проход не пробивает Cloudflare/Qrator/SPA — для таких
# URL Node-бэкенд POST'ит сюда `{url, timeout_ms}` и получает выгруженный
# `outerHTML` после гидратации.
#
# Не root, контейнер не торчит наружу (Docker сеть только), внутренний
# X-Internal-Token совпадает с RELEVANCE_INTERNAL_TOKEN (тот же,
# что у `relevance` — общий для внутренней сети).
# =============================================================================
FROM mcr.microsoft.com/playwright/python:v1.48.0-jammy

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app

# Образ playwright/python:v1.48.0-jammy уже содержит пользователя pwuser
# и preinstalled Chromium в /ms-playwright. Используем его как непривилегиро-
# ванный runtime — не нужно копировать бинари заново.
RUN chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:8001/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001", "--workers", "1"]
