# =============================================================================
# Relevance Analyzer microservice (FastAPI + readability-lxml + pymorphy3 + BM25)
# Stateless calculator. Called from Node-backend over the internal Docker network.
# =============================================================================
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Системные зависимости для lxml (libxml2/libxslt) и pymorphy3 (build-essential
# на случай wheel-fallback для DAWG-Python). slim-base их не несёт.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential \
        libxml2-dev \
        libxslt-dev \
        curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY app /app/app

# Не root
RUN useradd -m -u 1000 relevance && chown -R relevance:relevance /app
USER relevance

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8000/health || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
