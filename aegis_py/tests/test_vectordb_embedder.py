from aegis_py.app import vectordb


def test_normalize_embedder_aliases():
    assert vectordb._normalize_embedder("open-ai") == "openai"
    assert vectordb._normalize_embedder("local_bge") == "local-bge"
    assert vectordb._normalize_embedder("gemini") == "gemini"


def test_local_bge_fallback_is_deterministic():
    txt = ["seo оптимизация страницы", "seo оптимизация страницы"]
    v1 = vectordb._embed_local_bge(txt)
    v2 = vectordb._embed_local_bge(txt)
    assert len(v1) == 2
    assert len(v1[0]) == 384
    assert v1 == v2


def test_embed_unknown_provider_raises():
    try:
        vectordb._embed(["abc"], embedder="unknown-provider")
    except RuntimeError as e:
        assert "not supported" in str(e)
        return
    assert False, "expected RuntimeError for unknown provider"

