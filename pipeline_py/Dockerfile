# =============================================================================
# pipeline_py — слоистый пайплайн парсинга (FastAPI)
# Внутренний сервис: ingest URL -> fetch (relevance_fetcher) -> clean -> ...
# =============================================================================
FROM python:3.11-slim

ARG INSTALL_HEAVY=false

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Опциональные зависимости (Excel-ингест/экспорт, ускоренная очистка HTML)
RUN if [ "$INSTALL_HEAVY" = "true" ]; then \
        pip install --no-cache-dir openpyxl==3.1.5 || echo "openpyxl install failed, skipping"; \
        pip install --no-cache-dir lxml==5.3.0 || echo "lxml install failed, skipping"; \
    fi

COPY app /app/app

# Не root
RUN useradd -m -u 1000 pipeline && chown -R pipeline:pipeline /app
USER pipeline

EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8010/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010", "--workers", "1"]
