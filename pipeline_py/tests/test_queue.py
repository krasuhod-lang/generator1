"""Тесты Слоя 1 — персистентная очередь URL."""

import os

from app.models import TaskStatus
from app.queue import UrlQueue


def _q(tmp_path, **kw):
    kw.setdefault("ingest_dir", str(tmp_path))
    return UrlQueue(os.path.join(str(tmp_path), "q.sqlite3"), **kw)


def test_ingest_is_idempotent(tmp_path):
    q = _q(tmp_path)
    assert q.ingest_iterable(["https://a.example", "https://b.example"]) == 2
    # Повторный ингест того же URL не создаёт дубликат.
    assert q.ingest_iterable(["https://a.example", " ", ""]) == 0
    assert q.pending_count() == 2


def test_next_pending_marks_in_progress_and_is_exclusive(tmp_path):
    q = _q(tmp_path)
    q.ingest_iterable(["https://a.example", "https://b.example"])
    t1 = q.next_pending()
    assert t1 is not None
    assert q.get(t1.task_id).status == TaskStatus.IN_PROGRESS
    t2 = q.next_pending()
    assert t2.task_id != t1.task_id
    # Очередь опустела для in_progress-выборки.
    q.next_pending()
    assert q.next_pending() is None


def test_recover_stale_returns_in_progress_to_pending(tmp_path):
    path = os.path.join(str(tmp_path), "q.sqlite3")
    q = UrlQueue(path)
    q.ingest_iterable(["https://a.example"])
    q.next_pending()  # -> in_progress, потом «сбой сервера»
    q.close()

    # Возобновление после рестарта.
    q2 = UrlQueue(path)
    assert q2.recover_stale() == 1
    task = q2.next_pending()
    assert task is not None and task.url == "https://a.example"


def test_retry_then_fail_terminal(tmp_path):
    q = _q(tmp_path, max_retries=3)
    q.ingest_iterable(["https://a.example"])
    t = q.next_pending()

    # 1-й и 2-й сбой -> возврат в pending (retry).
    assert q.mark_failure(t.task_id, "boom") == TaskStatus.PENDING
    t = q.next_pending()
    assert q.mark_failure(t.task_id, "boom") == TaskStatus.PENDING
    t = q.next_pending()
    # 3-я попытка исчерпана -> terminal failed.
    assert q.mark_failure(t.task_id, "boom") == TaskStatus.FAILED
    assert q.get(t.task_id).retry_count == 3
    assert q.next_pending() is None


def test_mark_success_and_blocked(tmp_path):
    q = _q(tmp_path)
    q.ingest_iterable(["https://ok.example", "https://blocked.example"])
    t1 = q.next_pending()
    q.mark_success(t1.task_id, result='{"ok": true}')
    t2 = q.next_pending()
    q.mark_blocked(t2.task_id, error="captcha")
    counts = q.counts()
    assert counts.get("success") == 1
    assert counts.get("blocked") == 1


def test_ingest_csv(tmp_path):
    csv_path = os.path.join(str(tmp_path), "in.csv")
    with open(csv_path, "w", encoding="utf-8") as fh:
        fh.write("url,note\nhttps://a.example,x\nhttps://b.example,y\n")
    q = _q(tmp_path)
    assert q.ingest_csv(csv_path, url_column="url") == 2
    assert q.pending_count() == 2


def test_ingest_csv_rejects_path_traversal(tmp_path):
    import pytest

    # Файл-секрет вне разрешённого каталога ингеста.
    outside = tmp_path.parent / "secret.csv"
    outside.write_text("url\nhttps://leaked.example\n", encoding="utf-8")

    q = _q(tmp_path)  # ingest_dir = tmp_path
    # Обход каталога отбрасывается: компоненты пути игнорируются, читается
    # только базовое имя внутри ingest_dir — секрет снаружи не попадает в очередь.
    with pytest.raises((ValueError, FileNotFoundError, OSError)):
        q.ingest_csv("../secret.csv", url_column="url")
    assert q.pending_count() == 0


def test_google_sheet_url_validation_rejects_non_google():
    import pytest

    from app.queue import _validate_google_sheet_url

    with pytest.raises(ValueError):
        _validate_google_sheet_url("http://169.254.169.254/latest/meta-data")
    with pytest.raises(ValueError):
        _validate_google_sheet_url("file:///etc/passwd")
    with pytest.raises(ValueError):
        _validate_google_sheet_url("https://evil.example/export?format=csv")
