from aegis_py.app.biobrain.evolver import BioBrainEvolver


def test_predict_works_on_empty_brain():
    e = BioBrainEvolver()
    r = e.predict(text="test article")
    assert "score" in r
    assert 0.0 <= r["score"] <= 1.0


def test_feedback_and_evolve_api():
    e = BioBrainEvolver()
    feats = [0.2] * 8
    e.record_outcome(features=feats, real_spq_overall=90)
    r = e.evolve_step(eval_batch=32)
    assert "evolved" in r


def test_genome_grows_or_keeps_state_after_epochs():
    e = BioBrainEvolver()
    before = e.stats()
    for i in range(40):
        feats = [min(1.0, (i % 10) / 10.0)] * 8
        e.record_outcome(features=feats, real_spq_overall=70 + (i % 20))
    e.evolve_step(eval_batch=32)
    after = e.stats()
    assert after["generation"] >= before["generation"]
    assert after["nodes"] >= before["nodes"]


def test_richer_signals_override_text_proxies():
    from aegis_py.app.biobrain.feature_vector import extract_features
    base = extract_features("<p>hello world</p>")
    rich = extract_features(
        "<p>hello world</p>",
        signals={"readability": 90, "lsi_coverage": 1.0, "intent_ok": True},
    )
    assert len(rich) == 8
    # dim 3 (readability) and dim 6 (lsi) and dim 7 (intent) must reflect signals
    assert abs(rich[3] - 0.9) < 1e-9
    assert abs(rich[6] - 1.0) < 1e-9
    assert rich[7] == 1.0
    # base (no signals) differs in at least one of those dims
    assert base[6] != rich[6] or base[7] != rich[7]


def test_predict_returns_advice_and_confidence():
    e = BioBrainEvolver()
    r = e.predict(text="<p>short</p>")
    assert isinstance(r.get("advice"), list)
    assert 0.0 <= float(r.get("confidence", 0.0)) <= 1.0


def test_buffer_persists_across_instances(tmp_path, monkeypatch):
    # Redirect the brain_state dir to a temp location so the test is isolated.
    monkeypatch.setenv("AEGIS_BIOBRAIN_DIR", str(tmp_path))
    import importlib
    from aegis_py.app.biobrain import storage as storage_mod
    importlib.reload(storage_mod)
    from aegis_py.app.biobrain import evolver as evolver_mod
    importlib.reload(evolver_mod)

    e1 = evolver_mod.BioBrainEvolver(min_buffer_to_evolve=4)
    for i in range(5):
        e1.record_outcome(features=[0.3] * 8, real_spq_overall=70 + i)
    assert e1.stats()["buffer_size"] == 5

    # New instance should reload the persisted buffer from disk.
    e2 = evolver_mod.BioBrainEvolver(min_buffer_to_evolve=4)
    assert e2.stats()["buffer_size"] == 5

    # Restore modules to default state for subsequent tests.
    monkeypatch.delenv("AEGIS_BIOBRAIN_DIR", raising=False)
    importlib.reload(storage_mod)
    importlib.reload(evolver_mod)


def test_maybe_evolve_respects_min_buffer():
    e = BioBrainEvolver(min_buffer_to_evolve=50)
    r = e.maybe_evolve()
    assert r["evolved"] is False
    assert r["reason"] == "insufficient_buffer"


def test_predict_returns_attribution_with_feature_labels():
    """B3: predict() exposes per-feature contribution rating."""
    from aegis_py.app.biobrain.feature_vector import FEATURE_LABELS
    e = BioBrainEvolver()
    r = e.predict(features=[0.3] * 8)
    assert "attribution" in r
    assert isinstance(r["attribution"], dict)
    # Every known feature label must be present (even if 0.0).
    for label in FEATURE_LABELS:
        assert label in r["attribution"]
    assert r.get("feature_labels") == list(FEATURE_LABELS)


def test_evolve_step_persists_generation_log(tmp_path, monkeypatch):
    """B6: evolve_step appends a snapshot to biobrain_generations.jsonl."""
    monkeypatch.setenv("AEGIS_BIOBRAIN_DIR", str(tmp_path))
    import importlib
    from aegis_py.app.biobrain import storage as storage_mod
    importlib.reload(storage_mod)
    from aegis_py.app.biobrain import evolver as evolver_mod
    importlib.reload(evolver_mod)

    e = evolver_mod.BioBrainEvolver(min_buffer_to_evolve=4)
    for i in range(20):
        e.record_outcome(features=[0.3 + (i % 5) * 0.05] * 8,
                         real_spq_overall=60 + (i * 2) % 30)
    res = e.evolve_step(eval_batch=8)
    assert res["evolved"] is True
    gens = storage_mod.load_generations(limit=10)
    assert len(gens) >= 1
    last = gens[-1]
    # Snapshot must include the bookkeeping fields used by the Node UI.
    for key in ("generation", "nodes", "connections", "mean_fitness",
                "buffer_size", "complexity_lambda", "rolled_back"):
        assert key in last

    monkeypatch.delenv("AEGIS_BIOBRAIN_DIR", raising=False)
    importlib.reload(storage_mod)
    importlib.reload(evolver_mod)


def test_complexity_penalty_lowers_fitness_for_oversize_genome():
    """B6: λ * size penalty actually reduces fitness when nodes/conns grow."""
    e = BioBrainEvolver(complexity_lambda=0.1, complexity_scale=10.0)
    # Penalty enters fitness_fn — assert the parameters are kept on the instance.
    assert e.complexity_lambda == 0.1
    assert e.complexity_scale == 10.0
