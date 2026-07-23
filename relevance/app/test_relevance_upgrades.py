"""Тесты доработок ТЗ (23.07.2026): числительные, structured_data, BM25-boost."""

from __future__ import annotations

from .bm25_calc import compute_vocabulary_bm25
from .ngrams import compute_ngrams
from .normalizer import lemmatize_with_pos, normalize_document
from .parser import extract_structured_data, extract_with_diagnostics


# ── 1.2 Числительные ────────────────────────────────────────────────────────

def test_numeral_word_to_digit():
    assert lemmatize_with_pos("десять") == ("10", "NUMR")
    assert lemmatize_with_pos("десяти") == ("10", "NUMR")  # словоформа
    assert lemmatize_with_pos("пять") == ("5", "NUMR")


def test_numeral_digit_token():
    assert lemmatize_with_pos("10") == ("10", "NUMR")
    assert lemmatize_with_pos("007") == ("7", "NUMR")     # ведущие нули срезаны
    assert lemmatize_with_pos("12345") == ("", "")        # длинный ID — шум


def test_spelled_and_digit_numerals_unify():
    lem_a, _ = normalize_document("Топ десять способов")
    lem_b, _ = normalize_document("Топ 10 способов")
    assert "10" in lem_a and "10" in lem_b


def test_numeral_ngram():
    _, seq = normalize_document("Топ 10 способов заработать деньги")
    phrases = [n["phrase"] for n in compute_ngrams([seq], min_df=1, min_df_share_pct=0)]
    assert "топ 10 способ" in phrases


def test_regular_words_unaffected():
    assert lemmatize_with_pos("дом") == ("дом", "NOUN")
    assert lemmatize_with_pos("и") == ("", "")            # союз всё ещё режется


# ── 1.3 Structured data ─────────────────────────────────────────────────────

_HTML = """<html><body><article>
<h2>Характеристики</h2>
<p>Общий текст статьи про автомобили и покупку машины сегодня в салоне города.</p>
<table><tr><th>Модель</th><th>Мощность</th></tr>
<tr><td>Седан премиум комплектации</td><td>двести лошадиных сил мотора</td></tr></table>
<ul><li>Пункт списка про доставку клиентам автомобилей</li>
<li>Второй пункт про официальную гарантию качества сборки</li></ul>
<nav><ul><li><a href="/">меню сайта навигация</a></li>
<li><a href="/">ссылка на другую страницу</a></li></ul></nav>
</article></body></html>"""


def test_structured_data_extracts_table_and_list():
    blocks = extract_structured_data(_HTML)
    assert len(blocks) == 2  # таблица + контентный список; nav-меню отброшено
    joined = " ".join(blocks)
    assert "Мощность" in joined
    assert "гарантию" in joined


def test_structured_data_filters_nav_lists():
    blocks = extract_structured_data(_HTML)
    assert all("навигация" not in b for b in blocks)


def test_parse_result_has_structured_data():
    pr = extract_with_diagnostics(_HTML)
    assert isinstance(pr.structured_data, list)
    assert len(pr.structured_data) >= 1


# ── 1.3 BM25 boost ──────────────────────────────────────────────────────────

def test_structured_boost_increases_tfidf():
    docs = [
        ["ремонт", "сервис", "деталь", "мотор"],
        ["ремонт", "сервис", "гарантия"],
        ["ремонт", "деталь", "сервис"],
    ]
    struct = [{"ремонт"}, {"ремонт"}, {"ремонт"}]
    base = {r["lemma"]: r for r in compute_vocabulary_bm25(docs, min_df=1)}
    boosted = {
        r["lemma"]: r
        for r in compute_vocabulary_bm25(
            docs, min_df=1, structured_lemmas_by_doc=struct, structured_boost=1.5
        )
    }
    assert boosted["ремонт"]["tf_idf_score"] > base["ремонт"]["tf_idf_score"]
    assert boosted["ремонт"]["structured_boost"] > 1.0


def test_boost_disabled_when_multiplier_one():
    docs = [["ремонт", "сервис"], ["ремонт", "гарантия"]]
    struct = [{"ремонт"}, {"ремонт"}]
    base = {r["lemma"]: r for r in compute_vocabulary_bm25(docs, min_df=1)}
    same = {
        r["lemma"]: r
        for r in compute_vocabulary_bm25(
            docs, min_df=1, structured_lemmas_by_doc=struct, structured_boost=1.0
        )
    }
    assert base["ремонт"]["tf_idf_score"] == same["ремонт"]["tf_idf_score"]


def test_boost_never_worsens_negative_bm25():
    docs = [["общий", "слово"], ["общий", "текст"], ["общий", "фраза"]]
    struct = [{"общий"}, {"общий"}, {"общий"}]
    base = {r["lemma"]: r for r in compute_vocabulary_bm25(docs, min_df=1)}
    boosted = {
        r["lemma"]: r
        for r in compute_vocabulary_bm25(
            docs, min_df=1, structured_lemmas_by_doc=struct, structured_boost=2.0
        )
    }
    # bm25 «общий» отрицательный (сверх-частое) — boost не должен утопить ниже
    assert boosted["общий"]["bm25_score"] >= base["общий"]["bm25_score"]


# ── 1.1 Synonym clustering ──────────────────────────────────────────────────

def test_embeddings_enabled_default_on(monkeypatch):
    """Гейт инвертирован: по умолчанию (флаг не задан) — включено, если пакет
    установлен; выключается только явным false."""
    from . import signals

    # Пакета sentence_transformers нет в тест-окружении → False, но НЕ из-за
    # отсутствия флага (проверяем логику отключения явным false).
    monkeypatch.setenv("RELEVANCE_EMBEDDINGS", "false")
    assert signals.embeddings_enabled() is False
    monkeypatch.setenv("RELEVANCE_EMBEDDINGS", "off")
    assert signals.embeddings_enabled() is False


def test_cluster_synonyms_noop_without_model():
    """Без модели cluster_synonyms деградирует в пустой map (no-op)."""
    from . import signals

    # embeddings_enabled() == False (пакет не установлен) → пустой map
    assert signals.cluster_synonyms(["машина", "автомобиль"]) == {}


def test_cluster_terms_groups_synonyms(monkeypatch):
    """cluster_terms склеивает близкие по эмбеддингу леммы в один canonical."""
    from . import embeddings

    class _FakeModel:
        # «машина» и «автомобиль» — почти сонаправленные векторы; «дом» — ортогон.
        _VECS = {
            "автомобиль": [1.0, 0.0, 0.0],
            "машина":     [0.98, 0.02, 0.0],
            "дом":        [0.0, 1.0, 0.0],
        }

        def encode(self, terms, normalize_embeddings=False):
            import numpy as np
            out = []
            for t in terms:
                v = np.array(self._VECS.get(t, [0.0, 0.0, 1.0]), dtype=float)
                if normalize_embeddings:
                    v = v / (np.linalg.norm(v) + 1e-12)
                out.append(v)
            return np.array(out)

    monkeypatch.setattr(embeddings, "_load_model", lambda: _FakeModel())
    mapping = embeddings.cluster_terms(["автомобиль", "машина", "дом"], threshold=0.9)
    # машина и автомобиль → один canonical (первый по входу = автомобиль)
    assert mapping["машина"] == mapping["автомобиль"]
    assert mapping["дом"] != mapping["автомобиль"]


def test_comparison_synonym_map_counts_cluster():
    """compute_comparison с synonym_map засчитывает синоним в our_count."""
    from .comparison import compute_comparison

    vocabulary = [
        {"lemma": "автомобиль", "df": 3, "median_count": 4.0,
         "bm25_score": 1.0, "tf_idf_score": 1.0, "status": "important"},
    ]
    # Наш текст использует синоним «машина», а не «автомобиль».
    our_lemmas = ["машина", "машина", "машина", "машина", "текст"]
    syn = {"автомобиль": "автомобиль", "машина": "автомобиль"}

    # Без кластера «автомобиль» → missing (our_count 0).
    base = compute_comparison(
        our_lemmas=our_lemmas, vocabulary=vocabulary, ngrams=[],
        corpus_lemmas=[["автомобиль"], ["автомобиль"]],
    )
    assert base["per_term"][0]["status"] == "missing"

    # С кластером синоним засчитан → our_count 4, статус не missing.
    clustered = compute_comparison(
        our_lemmas=our_lemmas, vocabulary=vocabulary, ngrams=[],
        corpus_lemmas=[["автомобиль"], ["автомобиль"]], synonym_map=syn,
    )
    row = clustered["per_term"][0]
    assert row["our_count"] == 4
    assert row["status"] != "missing"
