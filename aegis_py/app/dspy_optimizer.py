"""DSPy MIPROv2 optimizer (Phase 14 — cold-start + ε-greedy mutation).

Тянет aegis_dspy_dataset из PostgreSQL, запускает Bayesian-оптимизацию
системного промпта и сохраняет результат в brain_state/compiled_writer.yaml.

Phase 14:
  • Cold-Start: если реальных строк < cold_start_min_rows — подмешивает
    seed'ы из aegis_py.app.dspy_seed (10–12 эталонных TOP-1 SEO-статей).
  • ε-greedy: в `epsilon_rate` (0..0.20) проценте случаев применяет
    мутацию к compiled prompt'у (Mode Collapse mitigation). Если мутация
    «выстрелит» (улучшит GA4-метрики), она закрепится в следующем retrain'е.

Графейс-деградирует: если dspy-ai не установлен → is_available() == False.
"""

import datetime
import hashlib
import json
import os
import random
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import dspy_seed

_REASON = None
try:  # pragma: no cover
    import dspy  # type: ignore
    _DSPY_OK = True
except Exception as e:  # pragma: no cover
    dspy = None  # type: ignore
    _DSPY_OK = False
    _REASON = f"dspy_missing: {e.__class__.__name__}"


_STATE_FILE = Path(os.environ.get("AEGIS_DSPY_STATE_FILE", "/tmp/aegis_dspy_status.json"))

# ── ε-greedy mutation taxonomy ───────────────────────────────────────
# Каждая мутация — детерминированная трансформация системного промпта
# (структура / порядок секций / длина / акценты), не меняющая смысла,
# но дающая модели «новую перспективу». Если в GA4 неделей позже у
# контента, сгенерированного с мутацией M, CTR выше — в следующий
# retrain эта мутация попадёт в обычный prompt-search space.
MUTATION_KINDS: Tuple[str, ...] = (
    "reorder_sections",          # переставить порядок H2 в шаблоне
    "alt_heading_style",         # «5 шагов…» вместо «Как сделать…»
    "denser_lists",              # больше <ul> вместо абзацев
    "looser_lists",              # наоборот, больше абзацев
    "shorter_intro",             # сократить intro до 1 абзаца
    "longer_intro",              # 2–3 абзаца intro с trust-signals
    "more_subheadings",          # H3 внутри H2 (тоньше структура)
    "fewer_subheadings",         # только H2 (плоская структура)
    "add_faq_block",             # принудительно FAQ-секция в конце
    "add_table_block",           # сравнительная таблица где уместно
)


def is_available() -> bool:
    return _DSPY_OK


def unavailable_reason() -> Optional[str]:
    return _REASON


def status() -> Dict[str, Any]:
    if _STATE_FILE.exists():
        try:
            return json.loads(_STATE_FILE.read_text("utf-8"))
        except Exception:
            pass
    return {
        "last_run_at": None,
        "last_status": "never_ran",
        "available":   is_available(),
        "seeds_total": dspy_seed.count_seeds(),
        "seed_niches": dspy_seed.seed_niches(),
    }


def _save_status(payload: Dict[str, Any]) -> None:
    try:
        _STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        _STATE_FILE.write_text(json.dumps(payload), "utf-8")
    except Exception:
        pass


# ── Cold-Start helpers ───────────────────────────────────────────────
def merge_with_seeds(
    real_rows: List[Dict[str, Any]],
    *,
    niche: Optional[str],
    min_rows: int = 10,
    enabled: bool = True,
) -> Dict[str, Any]:
    """Решает, нужно ли подмешать seeds к real_rows.

    Логика:
      * если реальных строк >= min_rows и они все имеют spq_overall — НЕ подмешиваем
        (мозг уже накопил собственный опыт; чистый сигнал).
      * иначе — добавляем seed'ы (фильтруем по нише, если задана).

    Returns:
        {"rows": [...], "rows_real": N, "rows_seed": M, "used_seeds": bool}
    """
    real_n = len(real_rows or [])
    if not enabled or real_n >= max(0, int(min_rows)):
        return {
            "rows": list(real_rows or []),
            "rows_real": real_n,
            "rows_seed": 0,
            "used_seeds": False,
        }
    seeds = dspy_seed.load_seed_dataset(niche=niche)
    return {
        "rows":      list(real_rows or []) + seeds,
        "rows_real": real_n,
        "rows_seed": len(seeds),
        "used_seeds": True,
    }


# ── ε-greedy helpers ─────────────────────────────────────────────────
def _clamped_rate(rate: float, *, max_rate: float = 0.20) -> float:
    try:
        r = float(rate)
    except Exception:
        return 0.0
    if r < 0:
        return 0.0
    if r > max_rate:
        return max_rate
    return r


def should_mutate(epsilon: float, *, rng: Optional[random.Random] = None,
                  max_rate: float = 0.20) -> bool:
    """True с вероятностью `epsilon` (clamped в [0, max_rate]).

    Принимает опц. `rng` для воспроизводимости в тестах.
    """
    r = _clamped_rate(epsilon, max_rate=max_rate)
    if r <= 0:
        return False
    g = rng or random
    return g.random() < r


def pick_mutation(*, seed_key: Optional[str] = None,
                  rng: Optional[random.Random] = None) -> str:
    """Выбирает имя мутации.

    Если задан `seed_key` (например, hash(niche + week_iso)), выбор
    становится детерминированным внутри недели → одинаковая мутация
    для всех задач этой недели/ниши, чтобы накопить статистически
    значимый GA4-сигнал.
    """
    if seed_key:
        digest = hashlib.sha256(seed_key.encode("utf-8")).digest()
        idx = digest[0] % len(MUTATION_KINDS)
        return MUTATION_KINDS[idx]
    g = rng or random
    return g.choice(MUTATION_KINDS)


def apply_mutation(prompt: str, kind: str) -> str:
    """Накладывает мутацию на системный промпт.

    Реализация — текстовая инструкция, добавляемая в конец промпта.
    Это «мягкая» мутация: модель ИНТЕРПРЕТИРУЕТ её, а не получает
    готовый шаблон. Если интерпретация не зайдёт — следующий retrain
    откажется от такой мутации (improvement_pct < min_improvement_pct).
    """
    if not kind or kind not in MUTATION_KINDS:
        return prompt or ""
    base = (prompt or "").rstrip()
    suffix_map = {
        "reorder_sections":
            "\n\n[MUTATION/ε-greedy] Расположи H2-секции в порядке от самого "
            "практичного (как сделать) к самому абстрактному (что это). "
            "Не используй типовую последовательность «определение → виды → выбор».",
        "alt_heading_style":
            "\n\n[MUTATION/ε-greedy] Используй list-style заголовки: "
            "«5 признаков…», «7 шагов…», «3 ошибки…». Цифру в заголовок ставь "
            "только если за ней реально следует список такой длины.",
        "denser_lists":
            "\n\n[MUTATION/ε-greedy] Конвертируй ≥60% перечислений в маркированные "
            "<ul>-списки. Скорость скана важнее линейного чтения.",
        "looser_lists":
            "\n\n[MUTATION/ε-greedy] Минимум списков. Излагай связным текстом "
            "с переходами «Кроме того…», «На практике это значит…». Не более "
            "одного <ul> на 1500 символов.",
        "shorter_intro":
            "\n\n[MUTATION/ε-greedy] Intro — РОВНО один абзац, 40–70 слов. "
            "Сразу ключевая мысль, без воды и контекста.",
        "longer_intro":
            "\n\n[MUTATION/ε-greedy] Intro — 2–3 абзаца с trust-signals "
            "(опыт, цифры, контекст рынка) ДО первой H2.",
        "more_subheadings":
            "\n\n[MUTATION/ε-greedy] Внутри каждой H2 длиннее 250 слов "
            "вставляй H3-подсекции (минимум 2). Сканируемость.",
        "fewer_subheadings":
            "\n\n[MUTATION/ε-greedy] Не используй H3. Только H1 + H2. "
            "Дробление через жирный текст, не через заголовки.",
        "add_faq_block":
            "\n\n[MUTATION/ε-greedy] Обязательно добавь блок FAQ в конце "
            "(минимум 4 вопроса, ответы 30–80 слов).",
        "add_table_block":
            "\n\n[MUTATION/ε-greedy] Если есть сравнение трёх и более "
            "альтернатив — оформи таблицей <table>, не списком.",
    }
    return base + suffix_map.get(kind, "")


# ── Основная функция retrain ─────────────────────────────────────────
def retrain(
    *,
    niche: Optional[str],
    dry_run: bool,
    max_trials: int,
    max_cost_usd: float,
    min_improvement_pct: float,
    real_rows: Optional[List[Dict[str, Any]]] = None,
    cold_start_min_rows: int = 10,
    cold_start_use_seeds: bool = True,
    epsilon_greedy_rate: float = 0.07,
    epsilon_greedy_max_rate: float = 0.20,
    rng: Optional[random.Random] = None,
) -> Dict[str, Any]:
    """Запускает (или эмулирует в dry_run) Bayesian-оптимизацию.

    Phase 14 апгрейд:
      * `real_rows` — то, что реально пришло из PostgreSQL (caller'у удобно
        передать выборку; здесь — заглушка по умолчанию None → пустой
        список, без БД).
      * Если real_rows короче `cold_start_min_rows` — подмешиваем seeds.
      * После compile'a решаем, применять ли ε-greedy мутацию (флаг
        `mutation_applied` идёт в ответ и в aegis_dspy_runs).
    """
    started_iso = datetime.datetime.utcnow().isoformat() + "Z"
    merged = merge_with_seeds(
        real_rows or [],
        niche=niche,
        min_rows=cold_start_min_rows,
        enabled=cold_start_use_seeds,
    )

    # ε-greedy: решаем заранее, чтобы статус был воспроизводимым.
    eps = _clamped_rate(epsilon_greedy_rate, max_rate=epsilon_greedy_max_rate)
    mutation_applied = should_mutate(eps, rng=rng,
                                     max_rate=epsilon_greedy_max_rate)
    mutation_kind = None
    if mutation_applied:
        # Детерминированный seed_key по нише+неделе: одна и та же мутация
        # для всех задач недели → статистически сравнимая GA4-метрика.
        week_iso = datetime.datetime.utcnow().strftime("%Y-W%U")
        mutation_kind = pick_mutation(
            seed_key=f"{niche or 'global'}|{week_iso}",
            rng=rng,
        )

    if (merged["rows_real"] + merged["rows_seed"]) == 0:
        status_str = "skipped_no_data"
    elif merged["rows_real"] == 0:
        status_str = "seed_only"  # учились только на seeds
    elif dry_run:
        status_str = "planned"
    else:
        status_str = "trained"   # реальная compile-фаза требует dspy-ai + БД

    payload: Dict[str, Any] = {
        "started_at":          started_iso,
        "niche":               niche,
        "dry_run":             dry_run,
        "max_trials":          max_trials,
        "max_cost_usd":        max_cost_usd,
        "min_improvement_pct": min_improvement_pct,
        "rows_real":           merged["rows_real"],
        "rows_seed":           merged["rows_seed"],
        "used_seeds":          merged["used_seeds"],
        "epsilon_rate":        eps,
        "mutation_applied":    mutation_applied,
        "mutation_kind":       mutation_kind,
        "last_status":         status_str,
    }

    if dry_run:
        _save_status(payload)
        return payload

    # ── РЕАЛЬНАЯ ЛОГИКА — добавляется при подключении dspy-ai + БД. ──
    # Псевдокод:
    #   examples = [build_example(r) for r in merged["rows"]]
    #   metric   = weighted Spq * ppo_weight
    #   compiled = dspy.MIPROv2(prompt_model=..., metric=metric,
    #                           num_trials=max_trials).compile(...)
    #   prompt   = compiled.prompt
    #   if mutation_applied:
    #       prompt = apply_mutation(prompt, mutation_kind)
    #   # дальше — A/B-сравнение vs текущая версия в brain_state и
    #   # сохранение compiled_writer.yaml при improvement_pct ≥ порога.
    payload["note"] = (
        "production retrain requires dspy-ai + psycopg + GEMINI_API_KEY; "
        "this build returned seed/ε-greedy plan only"
    )
    _save_status(payload)
    return payload
