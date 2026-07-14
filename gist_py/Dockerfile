# =============================================================================
# GIST + LinguaForensic DSPy pipeline microservice (FastAPI)
# Внутренний сервис: Node-бэкенд ходит на http://gist:8003 c X-Internal-Token.
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

# Опциональная установка тяжёлых зависимостей (DSPy, embeddings, PG)
RUN if [ "$INSTALL_HEAVY" = "true" ]; then \
        pip install --no-cache-dir dspy-ai==2.5.41 || echo "dspy install failed, skipping"; \
        pip install --no-cache-dir psycopg2-binary==2.9.10 || echo "psycopg2 install failed, skipping"; \
        pip install --no-cache-dir sentence-transformers==3.2.1 || echo "sentence-transformers install failed, skipping"; \
    fi

COPY app /app/app

# Не root
RUN useradd -m -u 1000 gist && chown -R gist:gist /app
USER gist

EXPOSE 8003

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8003/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8003", "--workers", "1"]
