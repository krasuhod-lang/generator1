"""Тесты GIST Score (§6) и дедупликации claims (§5)."""

from app.embeddings import cosine_similarity, dedup_claims
from app.modules.m3_gap import gist_score


def test_gist_score_zero_for_empty():
    assert gist_score("", ["тезис"]) == 0.0
    assert gist_score("# Заголовок", ["тезис"]) == 0.0


def test_gist_score_full_coverage():
    delta = ["датчик протечки срабатывает при влажности выше нормы"]
    article = "Датчик протечки срабатывает, когда влажность поднимается выше нормы."
    assert gist_score(article, delta) == 100.0


def test_gist_score_partial():
    delta = ["морозостойкость бетона маркируется классом F200"]
    article = (
        "Морозостойкость бетона напрямую зависит от класса F200 маркировки.\n\n"
        "Совершенно другой абзац про погоду и настроение садовода весной."
    )
    score = gist_score(article, delta)
    assert 0 < score < 100
    assert score == 50.0


def test_gist_score_ignores_headings():
    delta = ["уникальный тезис про кавитацию насоса"]
    article = "## Кавитация насоса уникальный тезис\n\nПро другое."
    assert gist_score(article, delta) == 0.0


def test_cosine_similarity_identical():
    assert cosine_similarity("газовый котёл мощность", "газовый котёл мощность") > 0.99


def test_cosine_similarity_different():
    assert cosine_similarity("газовый котёл", "рецепт борща со сметаной") < 0.3


def test_dedup_claims_removes_near_duplicates():
    claims = [
        "Мощность котла рассчитывается как 1 кВт на 10 м² площади",
        "Мощность котла рассчитывают как 1 кВт на 10 м² площади дома",
        "Двухконтурные котлы греют и отопление, и горячую воду",
    ]
    kept = dedup_claims(claims)
    assert len(kept) == 2
    assert kept[0].startswith("Мощность")
    assert kept[1].startswith("Двухконтурные")


def test_dedup_claims_skips_empty():
    assert dedup_claims(["", "  ", "тезис"]) == ["тезис"]
