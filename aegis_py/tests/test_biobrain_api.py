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
