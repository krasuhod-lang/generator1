from fastapi.testclient import TestClient

from aegis_py.app.main import app


client = TestClient(app)


def test_biobrain_status_endpoint():
    r = client.get("/biobrain/status")
    assert r.status_code == 200
    data = r.json()
    assert "available" in data


def test_biobrain_predict_and_feedback():
    p = client.post("/biobrain/predict", json={"text": "hello world"})
    assert p.status_code == 200
    pred = p.json()
    assert "score" in pred

    f = client.post("/biobrain/feedback", json={
        "features": pred.get("features") or [0.1] * 8,
        "predicted": pred.get("score"),
        "real_spq_overall": 85,
        "real_eeat": 80,
    })
    assert f.status_code == 200
    assert "stats" in f.json()


def test_biobrain_advice_endpoint():
    r = client.post("/biobrain/advice", json={"text": "<p>short</p>"})
    assert r.status_code == 200
    data = r.json()
    assert "advice" in data
    assert isinstance(data["advice"], list)


def test_biobrain_feedback_without_features_derives_them():
    # features omitted → server derives them from text+signals (loop closes).
    r = client.post("/biobrain/feedback", json={
        "text": "<h2>Title</h2><p>body 2024</p>",
        "signals": {"readability": 75, "lsi_coverage": 0.6},
        "real_spq_overall": 88,
    })
    assert r.status_code == 200
    assert r.json().get("stored") is True
