"""DSPy MIPROv2 optimizer (Phase 14 — cold-start + ε-greedy mutation).

Тянет aegis_dspy_dataset из PostgreSQL, запускает Bayesian-оптимизацию
системного промпта и сохраняет результат в brain_state/compiled_writer.yaml.

Phase 14:
  • Cold-Start: если реальных строк < cold_start_min_rows — подмешивает
    seed'ы из aegis_py.app.dspy_seed (10–12 эталонных TOP-1 SEO-статей).
  • ε-greedy: в `epsilon_rate` (0..0.20) проценте случаев применяет
    мутацию к compiled prompt'у (Mode Collapse mitigation). Если мутация
    «выстрелит» (улучшит CTR-метрики GSC/Яндекса), она закрепится в следующем retrain'е.

Графейс-деградирует: если dspy-ai не установлен → is_available() == False.
"""

import datetime
import hashlib
import json
import os
import random
import shutil
import statistics
import textwrap
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
# но дающая модели «новую перспективу». Если в поиске неделей позже у
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
    "aio_first_paragraph",       # самодостаточный первый абзац для AI Overviews
    "entity_dense_list",         # списки с именованными сущностями и источниками
    "faq_schema_block",          # строгий Q/A-блок под FAQPage и Яндекс Нейро
    "contrast_semantics",        # отрицательные определения: X — это не Y, а Z
    "comparison_table_first",    # таблица сравнения в первой половине статьи
    "multimodal_placeholders",   # [IMAGE]/[VIDEO] после ключевых секций
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
        "available": is_available(),
        "ok": False,
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
    значимый CTR-сигнал (GSC/Яндекс).
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
        "aio_first_paragraph":
            "\n\n[MUTATION/ε-greedy] Первый абзац первой смысловой секции сделай "
            "самодостаточным ответом на 130–170 слов: главный вывод поставь в "
            "первое предложение, затем 2–3 проверяемых факта, границы применимости "
            "и citable insights для AI Overviews/Яндекс Нейро.",
        "entity_dense_list":
            "\n\n[MUTATION/ε-greedy] В ключевых <ul>-списках используй именованные "
            "сущности: стандарты, бренды, метрики, документы, инструменты и "
            "профильные источники. Каждый пункт должен связывать сущность с "
            "практическим выводом, а не просто перечислять термины.",
        "faq_schema_block":
            "\n\n[MUTATION/ε-greedy] Добавь строгий FAQ-блок под FAQPage: "
            "вопросы формулируй как реальные поисковые интенты, ответы — 40–70 "
            "слов, без вводных фраз, с прямым ответом в первом предложении.",
        "contrast_semantics":
            "\n\n[MUTATION/ε-greedy] Добавь блок контрастной семантики: объясни "
            "«X — это не Y, а Z», явно отдели продукт/услугу от похожих, но "
            "ошибочных трактовок и покажи, какой выбор следует из различия.",
        "comparison_table_first":
            "\n\n[MUTATION/ε-greedy] Если материал сравнивает варианты, размести "
            "таблицу <table> в первой половине статьи: критерии, кому подходит, "
            "ограничения, ориентиры цены/срока. После таблицы дай короткий вывод.",
        "multimodal_placeholders":
            "\n\n[MUTATION/ε-greedy] После ключевых секций добавь мультимодальные "
            "плейсхолдеры вида [IMAGE: конкретная схема/пример] и при уместности "
            "[VIDEO: интент ролика]. Описание должно помогать дизайнеру, не быть "
            "декоративным.",
    }
    return base + suffix_map.get(kind, "")


# ── Real DSPy compile/deploy helpers ──────────────────────────────────
COMPILED_WRITER_PATH = Path(os.environ.get('AEGIS_DSPY_WRITER_ARTIFACT', 'brain_state/compiled_writer.yaml'))
HISTORY_DIR = Path(os.environ.get('AEGIS_DSPY_HISTORY_DIR', str(COMPILED_WRITER_PATH.parent / 'history')))


def _dspy_lm_configure():
    if not _DSPY_OK:
        return False, 'dspy_missing'
    api_key = os.environ.get('DEEPSEEK_API_KEY') or os.environ.get('OPENAI_API_KEY')
    if not api_key:
        return False, 'dspy_lm_key_missing'
    try:
        model = os.environ.get('AEGIS_DSPY_MODEL', 'openai/deepseek-chat')
        if model.startswith('deepseek/'):
            model = 'openai/' + model.split('/', 1)[1]
        elif '/' not in model:
            model = 'openai/' + model
        kwargs = {'model': model, 'api_key': api_key}
        api_base = os.environ.get('DEEPSEEK_API_BASE') or os.environ.get('OPENAI_API_BASE')
        if api_base:
            kwargs['api_base'] = api_base.rstrip('/')
        lm = dspy.LM(**kwargs)
        if hasattr(dspy, 'configure'):
            dspy.configure(lm=lm)
        else:
            dspy.settings.configure(lm=lm)
        return True, model
    except Exception as exc:
        return False, f'dspy_lm_config_error:{exc.__class__.__name__}'


def _dspy_examples(rows):
    examples = []
    for row in rows or []:
        prompt = row.get('user_prompt') or ''
        context = row.get('ground_truth_context') or prompt
        output = row.get('html_output') or ''
        if prompt and output:
            examples.append(dspy.Example(
                user_prompt=str(prompt),
                ground_truth_context=str(context),
                draft_text=str(output),
            ).with_inputs('user_prompt', 'ground_truth_context'))
    return examples


def _metric(example, prediction, trace=None):
    import re
    expected = set(re.findall(r'[A-Za-zА-Яа-яЁё0-9]{3,}', str(getattr(example, 'draft_text', '')).lower()))
    actual_text = str(getattr(prediction, 'draft_text', '') or '')
    actual = set(re.findall(r'[A-Za-zА-Яа-яЁё0-9]{3,}', actual_text.lower()))
    if not actual:
        return 0.0
    overlap = len(expected & actual) / max(1, min(len(expected), 300))
    html = actual_text.lower()
    structure = sum(1 for marker in ('<h1', '<h2', '<p', '<ul', '<ol') if marker in html) / 5.0
    return max(0.0, min(1.0, 0.75 * min(1.0, overlap * 4.0) + 0.25 * structure))


def _compile_candidate(trainset, max_trials):
    class WriterSignature(dspy.Signature):
        'Generate grounded HTML from the supplied evidence; never invent facts.'
        user_prompt: str = dspy.InputField(desc='article task and structural constraints')
        ground_truth_context: str = dspy.InputField(desc='only allowed factual evidence')
        draft_text: str = dspy.OutputField(desc='valid grounded HTML article')

    class WriterProgram(dspy.Module):
        def __init__(self):
            super().__init__()
            self.generate = dspy.ChainOfThought(WriterSignature)

        def forward(self, user_prompt, ground_truth_context):
            return self.generate(user_prompt=user_prompt, ground_truth_context=ground_truth_context)

    program = WriterProgram()
    trials = max(1, min(50, int(max_trials or 1)))
    try:
        from dspy.teleprompt import MIPROv2
        import inspect
        params = inspect.signature(MIPROv2).parameters
        kwargs = {'metric': _metric}
        if 'auto' in params:
            kwargs['auto'] = 'light'
        if 'num_candidates' in params:
            kwargs['num_candidates'] = min(10, trials)
        optimizer = MIPROv2(**kwargs)
    except Exception:
        from dspy.teleprompt import BootstrapFewShotWithRandomSearch
        optimizer = BootstrapFewShotWithRandomSearch(
            metric=_metric,
            max_bootstrapped_demos=min(4, trials),
            max_labeled_demos=min(8, trials),
            num_candidate_programs=min(10, trials),
        )
    return optimizer.compile(program, trainset=trainset)


def _evaluate_candidate(program, holdout):
    if not holdout:
        return 0.0
    scores = []
    for example in holdout[:20]:
        try:
            prediction = program(
                user_prompt=example.user_prompt,
                ground_truth_context=example.ground_truth_context,
            )
            scores.append(_metric(example, prediction))
        except Exception:
            scores.append(0.0)
    return round(statistics.mean(scores), 4) if scores else 0.0


def _write_compiled_artifact(program, model, before, after, rows, mutation_kind):
    COMPILED_WRITER_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    if COMPILED_WRITER_PATH.exists():
        stamp = datetime.datetime.utcnow().strftime('%Y%m%dT%H%M%SZ')
        shutil.copy2(COMPILED_WRITER_PATH, HISTORY_DIR / ('compiled_writer.' + stamp + '.yaml'))
    generator = getattr(program, 'generate', program)
    signature = getattr(generator, 'signature', None)
    instructions = getattr(signature, 'instructions', '') if signature else ''
    prompt = '\\n\\n'.join([
        'Use the supplied article evidence as the only source of factual claims.',
        'Return valid HTML matching the active pipeline contract; never invent numbers, credentials, sources, URLs or guarantees.',
        str(instructions or '').strip(),
    ]).strip()
    if mutation_kind:
        prompt = apply_mutation(prompt, mutation_kind)
    content = '\\n'.join([
        'version: 2',
        'compiled_at: ' + datetime.datetime.utcnow().isoformat() + 'Z',
        'mean_spq_before: ' + str(round(before * 100, 3)),
        'mean_spq_after: ' + str(round(after * 100, 3)),
        'model: "' + str(model).replace('"', '') + '"',
        'writer:',
        '  system_prompt: |',
    ] + ['    ' + line for line in (prompt.splitlines() or [''])]) + '\\n'
    digest = hashlib.sha256(content.encode('utf-8')).hexdigest()
    fd, temp_name = __import__('tempfile').mkstemp(prefix='compiled_writer.', dir=str(COMPILED_WRITER_PATH.parent))
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, COMPILED_WRITER_PATH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    return {'artifact_path': str(COMPILED_WRITER_PATH), 'artifact_sha': digest, 'dataset_size': rows}


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
        # для всех задач недели → статистически сравнимая CTR-метрика.
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

    if not (real_rows or []):
        payload.update({'last_status': 'seed_only', 'reason': 'real_dataset_empty'})
        _save_status(payload)
        return payload
    if dry_run:
        payload.update({'last_status': 'planned', 'reason': 'dry_run'})
        _save_status(payload)
        return payload

    configured, model_or_reason = _dspy_lm_configure()
    if not configured:
        payload.update({'last_status': 'compile_unavailable', 'reason': model_or_reason})
        _save_status(payload)
        return payload

    examples = _dspy_examples(real_rows)
    if len(examples) < 4:
        payload.update({'last_status': 'holdout_too_small', 'reason': 'need_at_least_4_real_examples'})
        _save_status(payload)
        return payload
    holdout_size = max(2, min(len(examples) // 5, 20))
    trainset = examples[:-holdout_size]
    holdout = examples[-holdout_size:]
    baseline_values = []
    for row in (real_rows or [])[-holdout_size:]:
        try:
            baseline_values.append(max(0.0, min(1.0, float(row.get('spq_overall', 0)) / 100.0)))
        except Exception:
            baseline_values.append(0.0)
    baseline = round(statistics.mean(baseline_values), 4) if baseline_values else 0.0
    try:
        compiled = _compile_candidate(trainset, max_trials)
        candidate = _evaluate_candidate(compiled, holdout)
    except Exception as exc:
        payload.update({'last_status': 'compile_failed', 'reason': f'{exc.__class__.__name__}:{exc}'})
        _save_status(payload)
        return payload

    improvement_pct = ((candidate - baseline) / max(0.01, baseline)) * 100.0
    payload.update({
        'mean_spq_before': round(baseline * 100, 3),
        'mean_spq_after': round(candidate * 100, 3),
        'improvement_pct': round(improvement_pct, 3),
        'holdout_size': len(holdout),
        'last_status': 'candidate_rejected',
    })
    if candidate <= 0 or improvement_pct < float(min_improvement_pct or 0):
        payload['reason'] = 'holdout_improvement_below_threshold'
        _save_status(payload)
        return payload

    deployed = _write_compiled_artifact(
        compiled,
        model_or_reason,
        baseline,
        candidate,
        len(real_rows),
        mutation_kind,
    )
    payload.update(deployed)
    payload['last_status'] = 'deployed'
    payload['ok'] = True
    _save_status(payload)
    return payload
