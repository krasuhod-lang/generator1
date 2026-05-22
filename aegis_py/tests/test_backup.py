"""Smoke-тесты backup module — без сети и без реальных qdrant/neo4j/boto3."""

import os
import tempfile
import pathlib

from fastapi.testclient import TestClient

from aegis_py.app.main import app
from aegis_py.app import backup as backup_mod

client = TestClient(app)


def test_health_includes_backup_subsystem():
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert "backup" in data["subsystems"]
    assert isinstance(data["subsystems"]["backup"], dict)
    for k in ("httpx", "boto3", "neo4j"):
        assert k in data["subsystems"]["backup"]


def test_backup_health_endpoint():
    r = client.get("/backup/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "deps" in body


def test_qdrant_backup_skipped_without_env(monkeypatch):
    monkeypatch.delenv("AEGIS_QDRANT_URL", raising=False)
    with tempfile.TemporaryDirectory() as tmp:
        r = backup_mod.backup_qdrant(tmp)
        assert r["target"] == "qdrant"
        assert r["status"] == "skipped"
        assert "AEGIS_QDRANT_URL" in r["reason"]


def test_neo4j_backup_skipped_without_env(monkeypatch):
    monkeypatch.delenv("AEGIS_NEO4J_URI", raising=False)
    with tempfile.TemporaryDirectory() as tmp:
        r = backup_mod.backup_neo4j(tmp)
        assert r["target"] == "neo4j"
        assert r["status"] == "skipped"


def test_s3_upload_skipped_no_bucket():
    with tempfile.TemporaryDirectory() as tmp:
        r = backup_mod.upload_to_s3(tmp, "", "prefix", "eu-central-1")
        assert r["status"] == "skipped"


def test_cleanup_old_deletes_only_old_files():
    with tempfile.TemporaryDirectory() as tmp:
        # Создадим старый и новый файлы.
        old = pathlib.Path(tmp) / "old.txt"
        new = pathlib.Path(tmp) / "new.txt"
        old.write_text("x")
        new.write_text("y")
        # «состарим» один файл руками.
        import os as _os
        _os.utime(old, (1000000, 1000000))  # 1970-ish
        r = backup_mod.cleanup_old(tmp, retain_days=1)
        assert r["deleted"] == 1
        assert not old.exists()
        assert new.exists()


def test_list_backups_handles_missing_dir():
    r = backup_mod.list_backups(local_dir="/tmp/does-not-exist-aegis-test-xyz")
    assert r["exists"] is False
    assert r["items"] == []


def test_run_backup_graceful_when_nothing_configured(monkeypatch):
    monkeypatch.delenv("AEGIS_QDRANT_URL", raising=False)
    monkeypatch.delenv("AEGIS_NEO4J_URI", raising=False)
    with tempfile.TemporaryDirectory() as tmp:
        r = backup_mod.run_backup(local_dir=tmp, s3_bucket="", retain_days=30)
        # Все шаги вернули skipped → общий ok=True.
        assert r["ok"] is True
        assert isinstance(r["results"], list)
        assert all(item["status"] == "skipped" for item in r["results"])
        assert r["s3"] is None
        assert r["cleanup"]["deleted"] == 0


def test_backup_run_endpoint_graceful(monkeypatch):
    monkeypatch.delenv("AEGIS_QDRANT_URL", raising=False)
    monkeypatch.delenv("AEGIS_NEO4J_URI", raising=False)
    with tempfile.TemporaryDirectory() as tmp:
        r = client.post("/backup/run", json={
            "targets": ["qdrant", "neo4j"],
            "s3_bucket": "",
            "local_dir": tmp,
            "retain_days": 30,
        })
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True


def test_backup_rejects_path_injection():
    # Любая попытка вылезти из белого списка _SAFE_ROOTS → 400.
    for bad in ("/etc/passwd", "/root/.ssh", "/home/runner/work/secret",
                "../etc", "/var/lib/aegis/../../etc"):
        r = client.post("/backup/run", json={
            "targets": ["qdrant"], "s3_bucket": "",
            "local_dir": bad, "retain_days": 1,
        })
        assert r.status_code == 400, f"expected 400 for {bad}, got {r.status_code}"


def test_safe_dir_accepts_allowed_roots():
    from aegis_py.app.backup import _safe_dir
    # Эти пути допустимы (или абсолютные внутри SAFE_ROOTS).
    p = _safe_dir("/tmp/aegis-test-xyz")
    assert str(p).startswith("/tmp")
    p = _safe_dir("/var/lib/aegis/backups/qdrant")
    assert str(p).startswith("/var/lib/aegis")


def test_safe_dir_rejects_traversal():
    from aegis_py.app.backup import _safe_dir
    import pytest as _pt
    for bad in ("", "/etc/passwd", "/root", "/home/user/secret",
                "/tmp/../etc/passwd", "../etc", "tmp/aegis"):
        with _pt.raises(ValueError):
            _safe_dir(bad)
