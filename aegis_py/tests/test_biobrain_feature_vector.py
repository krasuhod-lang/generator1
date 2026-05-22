from aegis_py.app.biobrain.feature_vector import extract_features


def test_feature_vector_is_stable_and_bounded():
    text = "<h2>Тест</h2><p>SEO текст 2026 и FAQ</p><ul><li>one</li></ul>"
    a = extract_features(text, has_cover_image=True)
    b = extract_features(text, has_cover_image=True)
    assert a == b
    assert len(a) == 8
    assert all(0.0 <= x <= 1.0 for x in a)
