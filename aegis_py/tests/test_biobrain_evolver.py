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
