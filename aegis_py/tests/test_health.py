"""Smoke-тесты health endpoint. Все тяжёлые deps должны быть в graceful-mode."""

from fastapi.testclient import TestClient

from aegis_py.app.main import app

client = TestClient(app)


def test_health_ok():
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "version" in data
    assert "subsystems" in data
    # Все подсистемы должны быть disabled на чистом окружении (без heavy deps + env).
    for k in ("graphrag", "vectordb", "ray", "langgraph", "dspy", "ga4", "mutator"):
        assert k in data["subsystems"], f"missing subsystem '{k}'"


def test_shannon_endpoint():
    r = client.post("/shannon", json={"text": "abcdefgh" * 100})
    assert r.status_code == 200
    data = r.json()
    assert abs(data["entropy"] - 3.0) < 1e-6


def test_graphrag_disabled_returns_empty():
    r = client.post("/graphrag/retrieve_lsi", json={"niche": "okna", "query": "пвх", "top_k": 5})
    assert r.status_code == 200
    assert r.json()["items"] == []


def test_vectordb_disabled_returns_empty():
    r = client.post("/vectordb/search", json={"niche": "okna", "query": "цены"})
    assert r.status_code == 200
    assert r.json()["hits"] == []


def test_dspy_status_safe_when_disabled():
    r = client.get("/dspy/status")
    assert r.status_code == 200
    # Должен возвращать структуру и не падать.
    assert "available" in r.json()


def test_ray_submit_503_when_disabled():
    r = client.post("/ray/submit", json={"kind": "noop", "payload": {}})
    assert r.status_code == 503
