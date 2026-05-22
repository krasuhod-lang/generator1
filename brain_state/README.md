# A.E.G.I.S. Brain State

Каталог хранит **скомпилированные веса** мозга A.E.G.I.S. после
weekly DSPy retrain (см. `.github/workflows/aegis-dspy-retrain.yml`).

## Файлы

- `compiled_writer.yaml` — оптимизированный системный промпт +
  few-shot примеры для писателя (Gemini 3.1 Pro / 3.5 Flash).
- `compiled_critic.yaml` — оптимизированный системный промпт для
  критика-аудитора (DeepSeek-V4-Pro).
- `history/` — git-history снапшотов yaml-файлов перед каждым retrain'ом.

## Когда обновляются

1. Weekly cron (Sunday 02:00 UTC) → `aegis-dspy-retrain.yml`
2. Вручную: `POST /api/aegis/dspy/retrain` (admin only)

Workflow:
1. DSPy MIPROv2 берёт `aegis_dspy_dataset` из PostgreSQL.
2. Запускает Bayesian-оптимизацию (≤ AEGIS_DSPY_MAX_TRIALS итераций).
3. Если `mean_spq_after − mean_spq_before ≥ AEGIS_DSPY_MIN_IMPROVEMENT_PCT %`
   → перезаписывает `compiled_writer.yaml`, коммитит и пушит.
4. Иначе — пропускает (записывает попытку в `aegis_brain_versions` с
   `rolled_back_at = NOW()`).

## Откат

```bash
git log brain_state/compiled_writer.yaml
git checkout <good-sha> -- brain_state/compiled_writer.yaml
git commit -m "aegis: rollback writer to <sha>"
```

После следующего рестарта backend'а `brainStateRegistry.loadBrainState()`
подхватит откатанную версию автоматически.

## Формат yaml

См. `compiled_writer.yaml` — мини-подмножество YAML, читается собственным
парсером `backend/src/services/aegis/brainStateRegistry.js::_parseSimpleYaml`
без `js-yaml` зависимости.
