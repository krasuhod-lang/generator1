# =============================================================================
# A.E.G.I.S. Python microservice
# Stateless coordinator + GraphRAG/VectorDB/Ray/DSPy/Mutator wrappers.
# Все тяжёлые deps опциональны (см. requirements.txt).
# =============================================================================
FROM python:3.11-slim

ARG INSTALL_HEAVY=false

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential curl \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Опциональная установка тяжёлых зависимостей (Phase 1+).
RUN if [ "$INSTALL_HEAVY" = "true" ]; then \
        pip install --no-cache-dir neo4j==5.25.0 networkx==3.4.2 || echo "[aegis_py] graphrag deps failed"; \
        pip install --no-cache-dir qdrant-client==1.12.1 rank-bm25==0.2.2 || echo "[aegis_py] vectordb deps failed"; \
        pip install --no-cache-dir ray==2.39.0 || echo "[aegis_py] ray deps failed"; \
        pip install --no-cache-dir langgraph==0.2.50 || echo "[aegis_py] langgraph failed"; \
        pip install --no-cache-dir dspy-ai==2.5.41 || echo "[aegis_py] dspy failed"; \
    fi

COPY app /app/aegis_py/app
RUN touch /app/aegis_py/__init__.py

RUN useradd -m -u 1000 aegis && chown -R aegis:aegis /app
USER aegis

EXPOSE 8800

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8800/health || exit 1

CMD ["uvicorn", "aegis_py.app.main:app", "--host", "0.0.0.0", "--port", "8800", "--workers", "1"]
