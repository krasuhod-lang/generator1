from aegis_py.app import langgraph_runner as lg


def test_run_fast_reject_short_circuit():
    def bio_predictor(**_kwargs):
        return {"score": 0.01, "gate": "fast_reject"}

    out = lg.run(
        user_prompt="Тестовый запрос",
        niche="seo",
        max_iters=3,
        bio_predictor=bio_predictor,
    )
    assert out["passed"] is False
    assert out["iterations"] == 0
    assert out["article_html"] == ""
    assert any(t.get("reason") == "bio_fast_reject" for t in out["trace"])


def test_run_generates_non_stub_trace_and_html():
    out = lg.run(
        user_prompt="Как улучшить SEO-структуру страницы",
        niche="seo",
        max_iters=2,
        bio_predictor=None,
    )
    assert "stub" not in out
    assert out["iterations"] >= 1
    assert isinstance(out["final_score"], float)
    assert "<h1>" in out["article_html"]
    assert any(t.get("node") == "critic" for t in out["trace"])

