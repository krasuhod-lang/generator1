# =============================================================================
# SEO Traffic Forecaster microservice (FastAPI + Prophet/SARIMA + sklearn)
# Stateless calculator. Called from Node-backend over the internal Docker network.
# =============================================================================
FROM python:3.11-slim

ARG INSTALL_HEAVY=false

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Системные зависимости для сборки пакетов
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential \
        curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Опциональная установка тяжёлых зависимостей
RUN if [ "$INSTALL_HEAVY" = "true" ]; then \
        pip install --no-cache-dir prophet==1.1.5 || echo "Prophet install failed, skipping"; \
        pip install --no-cache-dir kats==0.2.0 || echo "Kats install failed, skipping"; \
        pip install --no-cache-dir google-api-python-client==2.149.0 google-auth==2.35.0 || echo "GSC install failed, skipping"; \
    fi

COPY app /app/app

# Не root
RUN useradd -m -u 1000 forecaster && chown -R forecaster:forecaster /app
USER forecaster

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
