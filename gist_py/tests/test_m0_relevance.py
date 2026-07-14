"""Тесты M0 Relevance Scanner: regex-группы (§3) и парсинг GSC CSV."""

from app.modules.m0_relevance import classify_query, parse_gsc_csv, scan


def test_howto():
    res = classify_query("как настроить роутер tp-link")
    assert res["trigger_group"] == "howto"
    assert res["content_type"] == "HOW-TO"
    assert res["needs_steps"] is True
    assert res["zero_click_risk"] == "HIGH"


def test_comparison():
    res = classify_query("iphone 15 vs samsung s24 сравнение")
    assert res["trigger_group"] == "comparison"
    assert res["content_type"] == "COMPARISON"
    assert res["needs_table"] is True


def test_best_top_list():
    res = classify_query("топ 10 лучших ноутбуков")
    assert res["trigger_group"] == "best_top_list"
    assert res["content_type"] == "LIST"


def test_definition():
    res = classify_query("что такое канонический url")
    assert res["trigger_group"] == "definition"
    assert res["content_type"] == "DEFINITION"
    assert res["trigger_rate"] >= 0.85


def test_freshness():
    res = classify_query("тренды seo 2025")
    assert res["trigger_group"] == "freshness"


def test_commercial():
    res = classify_query("купить котёл недорого")
    assert res["trigger_group"] == "commercial"
    assert res["content_type"] == "COMMERCIAL"
    assert res["zero_click_risk"] == "LOW"
    assert res["trigger_rate"] <= 0.3


def test_troubleshooting():
    res = classify_query("ошибка 500 nginx")
    assert res["trigger_group"] == "troubleshooting"
    assert res["content_type"] == "TROUBLESHOOT"


def test_question():
    res = classify_query("почему желтеют листья у огурцов")
    assert res["trigger_group"] == "question"
    assert res["content_type"] == "FAQ"


def test_conversational_9_words():
    res = classify_query(
        "подскажите пожалуйста какой недорогой пылесос лучше взять для квартиры с котом"
    )
    assert res["trigger_rate"] > 0.3
    assert res["zero_click_risk"] in ("MEDIUM", "HIGH")


def test_other_fallback():
    res = classify_query("газовый котёл висман")
    assert res["trigger_group"] == "other"
    assert res["content_type"] == "DEEP-DIVE"


def test_parse_gsc_csv():
    csv_text = (
        "query,clicks,impressions,ctr,position\n"
        "как выбрать котёл,10,1000,1%,5.2\n"
        ",1,1,1,1\n"
        "купить котёл,20,500,4%,3.1\n"
    )
    rows = parse_gsc_csv(csv_text)
    assert len(rows) == 2
    assert rows[0]["query"] == "как выбрать котёл"
    assert rows[0]["impressions"] == 1000.0
    assert rows[1]["position"] == 3.1


def test_scan_without_llm_falls_back_to_regex():
    # Без LLM (нет ключей) scan должен вернуть regex-результаты, не падая
    results = scan(["как настроить роутер", "купить котёл"])
    assert len(results) == 2
    assert results[0]["content_type"] == "HOW-TO"
    assert results[1]["content_type"] == "COMMERCIAL"
