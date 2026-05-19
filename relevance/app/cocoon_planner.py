"""Семантический кокон (cocoon sémantique) — иерархия страниц
Page Cible → Pages Mères → Pages Filles, как описано в классической
методике Laurent Bourrelly.

Это **не** LSA-кластеризация чужих документов (та живёт в `cocoons.py`).
Здесь мы строим **скелет нашего будущего сайта** под коммерческий ВЧ-запрос:
вершина (Cible), 3–8 материнских подтем (СЧ) и под каждой 4–12 дочерних
long-tail-страниц (НЧ), плюс граф перелинковки строго по золотым правилам:

  • Mère → все свои Filles (полный набор) — формирует «зонтик»;
  • каждая Fille → её Mère (одна ссылка, желательно в начале текста);
  • Filles одного уровня могут ссылаться друг на друга **только**
    последовательно (Шаг 1 → Шаг 2 → Шаг 3) — иначе sister-link запрещён;
  • кросс-cocoon-ссылки запрещены (Mère/Fille одного кокона не ссылается
    на страницы другого кокона) — стена между коконами.

На вход: query (ВЧ), vocabulary (для определения важных лемм),
ngrams (СЧ/НЧ-фразы), headings_intersection (общие H2 топа), опц. our_url.
На выход: jsonable-дерево, готовое к отображению на UI и экспорту в
markdown-чеклист для копирайтера.

Алгоритм детерминированный (никаких внешних эмбеддингов / LLM) и дешёвый —
работает за O(n_docs * n_phrases). Используется char-bigram cosine для
кластеризации фраз вокруг материнских подтем — этого достаточно для
русского/английского контента; точность можно поднять, подключив позже
семантические эмбеддинги.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from typing import Dict, List, Optional, Sequence, Tuple

# Параметры по умолчанию — согласованы с типичным размером кокона из
# методики LB: 3–8 материнских, 4–12 дочерних на каждую. Все пороги
# хранятся как константы (а не env — см. memories: env configuration).
DEFAULT_MAX_MOTHERS         = 8
DEFAULT_MIN_MOTHERS         = 3
DEFAULT_MAX_CHILDREN_PER_M  = 12
DEFAULT_MIN_CHILDREN_PER_M  = 4
# Минимальная косинусная близость child→mother. Ниже — child уходит в orphans.
DEFAULT_MIN_COSINE          = 0.18
# Триггер «сестринских ссылок» — обнаружение последовательных шагов
# («Шаг 1», «Этап 2», «Step 3»). Если в title найден ШАГ/STEP+номер —
# Filles сортируются по номеру и связываются последовательно.
_STEP_RE = re.compile(
    # Жёстко ограничиваем повторения пробелов, чтобы избежать polynomial-ReDoS
    # (два соседних \s* через опциональный [№#]? CodeQL детектит как
    # уязвимость py/polynomial-redos). 8 пробелов — заведомо избыточный
    # запас для реальных заголовков «Шаг 3», «Step #2», «Часть № 5» и т.п.
    r"^\s{0,8}(?:шаг|этап|step|часть|part)\s{0,8}[№#]?\s{0,8}(\d+)\b",
    re.IGNORECASE,
)
# Question-маркеры — определяют тип Fille (информационная "вопрос")
_QUESTION_STARTS_RE = re.compile(
    r"^(?:как|почему|зачем|какой|какая|какие|что|где|когда|сколько|кто|чем|how|why|what|where|when|which)\b",
    re.IGNORECASE,
)
_WORD_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9]+", re.UNICODE)


# ── Вспомогательные функции ─────────────────────────────────────────────────

def _normalize(text: str) -> str:
    if not text:
        return ""
    return " ".join(_WORD_RE.findall(text.lower()))


def _char_bigrams(text: str) -> Counter:
    """Char-bigram bag для cosine. Для коротких фраз быстро и устойчиво
    к словоформам (берём в учёт уже нормализованные леммы из vocabulary).
    """
    t = _normalize(text)
    if len(t) < 2:
        return Counter()
    return Counter(t[i:i + 2] for i in range(len(t) - 1))


def _cosine(a: Counter, b: Counter) -> float:
    if not a or not b:
        return 0.0
    common = set(a.keys()) & set(b.keys())
    if not common:
        return 0.0
    dot = sum(a[k] * b[k] for k in common)
    na = math.sqrt(sum(v * v for v in a.values()))
    nb = math.sqrt(sum(v * v for v in b.values()))
    if na == 0 or nb == 0:
        return 0.0
    return float(dot) / (na * nb)


def _slugify(text: str, max_len: int = 60) -> str:
    """Простой кириллический slug: транслит → ascii, пробелы → дефис."""
    if not text:
        return ""
    translit_map = {
        "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
        "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
        "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
        "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sch",
        "ы": "y", "э": "e", "ю": "yu", "я": "ya", "ъ": "", "ь": "",
    }
    out = []
    for ch in text.lower():
        if ch.isalnum() and ord(ch) < 128:
            out.append(ch)
        elif ch in translit_map:
            out.append(translit_map[ch])
        elif ch.isspace() or ch in "-_":
            out.append("-")
    slug = re.sub(r"-+", "-", "".join(out)).strip("-")
    return slug[:max_len]


def _phrase_signature(phrase: str, important_lemmas_set: set) -> int:
    """Доля важных лемм во фразе (0..N). Чем больше — тем «коммерчески»
    значимей фраза, тем выше шанс стать матерью."""
    if not phrase:
        return 0
    words = _normalize(phrase).split()
    return sum(1 for w in words if w in important_lemmas_set)


def _intent_of(phrase: str) -> str:
    """Простейшая эвристика интента — нужна, чтобы Mère и Fille не
    конкурировали по типу (Mère = info/guide, Fille = info/long-tail или
    question)."""
    if _QUESTION_STARTS_RE.match(phrase or ""):
        return "question"
    if re.search(r"\b(купить|цена|стоимость|заказать|buy|price|order)\b", phrase or "", re.IGNORECASE):
        return "commercial"
    if re.search(r"\b(рейтинг|обзор|сравнение|лучш|топ-|top\b|review|vs)\b", phrase or "", re.IGNORECASE):
        return "comparison"
    if re.search(r"\b(как|инструкция|пошагово|how|guide|tutorial)\b", phrase or "", re.IGNORECASE):
        return "guide"
    return "info"


def _detect_step_number(title: str) -> Optional[int]:
    """Если title начинается с «Шаг N» / «Step N» — возвращает N, иначе None.
    Используется для sister-sequential ссылок (правило перелинковки ТЗ)."""
    if not title:
        return None
    m = _STEP_RE.match(title)
    if not m:
        return None
    try:
        return int(m.group(1))
    except (ValueError, TypeError):
        return None


# ── Основная функция ───────────────────────────────────────────────────────

def build_cocoon_plan(
    *,
    query: str,
    vocabulary: Sequence[dict],
    ngrams: Sequence[dict],
    headings_intersection: Optional[Sequence[dict]] = None,
    our_url: str = "",
    region: str = "",
    max_mothers: int = DEFAULT_MAX_MOTHERS,
    max_children_per_mother: int = DEFAULT_MAX_CHILDREN_PER_M,
    min_cosine: float = DEFAULT_MIN_COSINE,
) -> dict:
    """Строит план семантического кокона.

    Args:
        query: исходный ВЧ-запрос (страница-цель = Page Cible).
        vocabulary: список словаря из BM25-этапа (каждая запись с
            полями lemma, df_share_pct, status).
        ngrams: 2–4-граммы с df, df_share_pct, phrase.
        headings_intersection: общие H2/H3 у топа (опц.) — отличный
            источник для материнских подтем.
        our_url: наш домен (для slug Cible и для разделения «есть/нет у нас»).
        region: для контекста (rendering only).
        max_mothers / max_children_per_mother / min_cosine: см. константы.

    Returns:
        dict с ключами: page_cible, mothers (каждая с children и links_out),
        rules, stats.
    """
    vocab = list(vocabulary or [])
    ngs   = list(ngrams or [])
    heads = list(headings_intersection or [])

    important_lemmas = {
        v.get("lemma") for v in vocab
        if v.get("status") == "important" and v.get("lemma")
    }

    # ── 1) Определяем материнские подтемы ─────────────────────────────────
    # Кандидаты на Mère:
    #   • headings_intersection (≥40% топа) — реальные H2/H3 со скелетом;
    #   • topical bi-/tri-граммы (df_share ≥ 40%) — широкие подтемы.
    # Сортируем по «весу» (df_share + важные леммы внутри). Дедуплицируем
    # по нормализованному тексту (canon), берём top-N.
    mother_candidates: List[Tuple[float, str, dict]] = []  # (weight, canon, raw)

    for h in heads:
        canon = _normalize(h.get("text") or h.get("sample") or "")
        if not canon or len(canon.split()) < 2:
            continue
        sig = _phrase_signature(canon, important_lemmas)
        weight = float(h.get("df_share_pct", 0)) + sig * 3.0
        mother_candidates.append((weight, canon, {
            "label": (h.get("sample") or h.get("text") or "").strip(),
            "source": "heading_intersection",
            "df_share_pct": float(h.get("df_share_pct", 0)),
        }))

    for ng in ngs:
        phrase = ng.get("phrase") or ""
        canon = _normalize(phrase)
        if not canon:
            continue
        words = canon.split()
        # На Mère берём только 2–3-словные фразы (СЧ-кластеры).
        if len(words) < 2 or len(words) > 3:
            continue
        share = float(ng.get("df_share_pct", 0))
        if share < 30.0:
            continue
        sig = _phrase_signature(canon, important_lemmas)
        weight = share + sig * 2.0
        mother_candidates.append((weight, canon, {
            "label": phrase.strip(),
            "source": "ngram",
            "df_share_pct": share,
        }))

    # Дедуп по canon (если фраза уже есть как heading) и сортировка.
    seen_canons = set()
    mother_candidates.sort(key=lambda x: x[0], reverse=True)
    mothers_raw: List[dict] = []
    mother_canons: List[str] = []
    for weight, canon, raw in mother_candidates:
        if canon in seen_canons:
            continue
        # Также skip если совпадает с самим ВЧ-запросом (это Cible, не Mère).
        if canon == _normalize(query):
            continue
        seen_canons.add(canon)
        raw["weight"] = round(weight, 2)
        raw["canon"]  = canon
        mothers_raw.append(raw)
        mother_canons.append(canon)
        if len(mothers_raw) >= max_mothers:
            break

    # Если материнских кандидатов слишком мало — fallback на топ-лемм
    # (одиночные важные слова как мини-подтемы).
    if len(mothers_raw) < DEFAULT_MIN_MOTHERS:
        for v in sorted(vocab, key=lambda v: float(v.get("df_share_pct", 0)), reverse=True):
            if v.get("status") != "important":
                continue
            lemma = v.get("lemma") or ""
            canon = _normalize(lemma)
            if not canon or canon in seen_canons:
                continue
            seen_canons.add(canon)
            mothers_raw.append({
                "label":         lemma,
                "source":        "important_lemma_fallback",
                "df_share_pct":  float(v.get("df_share_pct", 0)),
                "weight":        float(v.get("df_share_pct", 0)),
                "canon":         canon,
            })
            mother_canons.append(canon)
            if len(mothers_raw) >= max_mothers:
                break

    # ── 2) Кандидаты на Filles (НЧ / long-tail / вопросы) ──────────────
    # Дочерние страницы — long-tail (3+ слова) и question-фразы. Берём
    # n-граммы 3–4-словные с df_share ≥ 20% (доп-LSI порог), плюс все
    # question-headings из headings_intersection.
    child_candidates: List[dict] = []
    seen_child_canons = set()
    # 2a) ngrams (long-tail)
    for ng in ngs:
        phrase = (ng.get("phrase") or "").strip()
        canon = _normalize(phrase)
        if not canon or canon in seen_child_canons or canon in seen_canons:
            continue
        words = canon.split()
        if len(words) < 3 or len(words) > 6:
            continue
        share = float(ng.get("df_share_pct", 0))
        if share < 20.0:
            continue
        seen_child_canons.add(canon)
        child_candidates.append({
            "phrase":       phrase,
            "canon":        canon,
            "df_share_pct": share,
            "intent":       _intent_of(phrase),
            "source":       "ngram",
        })
    # 2b) question-headings — если они длиннее матерей (например «Как
    # выбрать X для Y»), идут в Filles.
    for h in heads:
        text = (h.get("sample") or h.get("text") or "").strip()
        canon = _normalize(text)
        if not canon or canon in seen_child_canons or canon in seen_canons:
            continue
        words = canon.split()
        if len(words) < 3:
            continue
        if not _QUESTION_STARTS_RE.match(text):
            continue
        seen_child_canons.add(canon)
        child_candidates.append({
            "phrase":       text,
            "canon":        canon,
            "df_share_pct": float(h.get("df_share_pct", 0)),
            "intent":       "question",
            "source":       "heading_question",
        })

    # ── 3) Кластеризация Filles вокруг Mères по char-bigram cosine ────
    mother_bigrams: List[Counter] = [_char_bigrams(m["canon"]) for m in mothers_raw]
    mother_children: List[List[dict]] = [[] for _ in mothers_raw]
    orphans: List[dict] = []
    for child in child_candidates:
        cb = _char_bigrams(child["canon"])
        best_idx = -1
        best_cos = 0.0
        for idx, mb in enumerate(mother_bigrams):
            cos = _cosine(cb, mb)
            if cos > best_cos:
                best_cos = cos
                best_idx = idx
        if best_idx >= 0 and best_cos >= min_cosine:
            # Не выходим за лимит детей на одну мать (иначе orphan).
            if len(mother_children[best_idx]) < max_children_per_mother:
                child["match_cosine"] = round(best_cos, 3)
                mother_children[best_idx].append(child)
                continue
        child["match_cosine"] = round(best_cos, 3)
        orphans.append(child)

    # ── 4) Сборка JSON-плана с графом перелинковки ────────────────────
    page_cible = {
        "id":    "cible",
        "query": query.strip(),
        "intent": _intent_of(query),
        "suggested_url_slug": _slugify(query),
        "region": region or None,
        "our_url": our_url or None,
        # Cible ссылается на все матери (зонтик)
        "links_out": [
            {
                "target":   f"m{idx + 1}",
                "anchor":   _generate_anchors(m["label"]),
                "position": "body",
                "reason":   "umbrella",
            }
            for idx, m in enumerate(mothers_raw)
        ],
    }

    mothers_out: List[dict] = []
    for idx, m in enumerate(mothers_raw):
        m_id = f"m{idx + 1}"
        children_list = mother_children[idx]
        # Sister-sequential: если в children есть «Шаг N» / «Step N» —
        # сортируем по номеру и связываем последовательно.
        # Иначе sister-ссылок не делаем (правило ТЗ: «только если идут
        # друг за другом по логике чтения пользователя»).
        steps = []
        non_steps = []
        for c in children_list:
            num = _detect_step_number(c["phrase"])
            if num is not None:
                steps.append((num, c))
            else:
                non_steps.append(c)
        steps.sort(key=lambda x: x[0])
        ordered_children = [c for _, c in steps] + non_steps

        # Mère links_out: ссылка на Cible (как «родитель») + на ВСЕ Filles
        mother_links_out = [
            {
                "target":   "cible",
                "anchor":   _generate_anchors(query),
                "position": "intro",
                "reason":   "back_to_cible",
            }
        ]
        # ссылки на все Filles
        children_out: List[dict] = []
        for ci, c in enumerate(ordered_children):
            c_id = f"{m_id}c{ci + 1}"
            # Fille links_out: всегда обратно на Mère (в начале), плюс
            # sister-sequential если это шаг.
            fille_links_out = [
                {
                    "target":   m_id,
                    "anchor":   _generate_anchors(m["label"]),
                    "position": "intro",
                    "reason":   "required_back_to_mother",
                }
            ]
            # sister-sequential: только если этот ребёнок — шаг N, и есть
            # шаг N+1 в той же матери.
            this_step = _detect_step_number(c["phrase"])
            if this_step is not None:
                for cj, c2 in enumerate(ordered_children):
                    if cj == ci:
                        continue
                    that_step = _detect_step_number(c2["phrase"])
                    if that_step == this_step + 1:
                        fille_links_out.append({
                            "target":   f"{m_id}c{cj + 1}",
                            "anchor":   _generate_anchors(c2["phrase"]),
                            "position": "outro",
                            "reason":   "sister_sequential_next",
                        })
                    elif that_step == this_step - 1:
                        fille_links_out.append({
                            "target":   f"{m_id}c{cj + 1}",
                            "anchor":   _generate_anchors(c2["phrase"]),
                            "position": "intro",
                            "reason":   "sister_sequential_prev",
                        })

            children_out.append({
                "id":           c_id,
                "title":        c["phrase"],
                "query":        c["phrase"],
                "intent":       c.get("intent", "info"),
                "df_share_pct": c.get("df_share_pct", 0),
                "suggested_url_slug": _slugify(c["phrase"]),
                "match_cosine": c.get("match_cosine", 0),
                "links_out":    fille_links_out,
            })
            mother_links_out.append({
                "target":   c_id,
                "anchor":   _generate_anchors(c["phrase"]),
                "position": "body",
                "reason":   "mother_to_child",
            })

        mothers_out.append({
            "id":           m_id,
            "label":        m["label"],
            "canon":        m["canon"],
            "intent":       _intent_of(m["label"]),
            "df_share_pct": m.get("df_share_pct", 0),
            "weight":       m.get("weight", 0),
            "source":       m.get("source", "ngram"),
            "suggested_url_slug": _slugify(m["label"]),
            "children":     children_out,
            "links_out":    mother_links_out,
        })

    plan = {
        "page_cible": page_cible,
        "mothers":    mothers_out,
        "orphans":    orphans[:30],   # отрезаем длинный хвост
        "rules": {
            "mother_to_children":  "all",                  # Mère ↔ все Filles
            "child_to_mother":     "required_in_intro",    # Fille → Mère (всегда, в начале)
            "sister_links":        "sequential_only",      # только последовательные шаги
            "cross_cocoon":        "forbidden",            # запрет ссылок между коконами
            "link_juice":          "internal_only",        # вес циркулирует только внутри
        },
        "stats": {
            "mothers_count":         len(mothers_out),
            "children_total":        sum(len(m["children"]) for m in mothers_out),
            "orphans_count":         len(orphans),
            "vocabulary_size":       len(vocab),
            "important_lemmas":      len(important_lemmas),
            "ngrams_considered":     len(ngs),
            "headings_considered":   len(heads),
            "max_mothers":           max_mothers,
            "max_children_per_mother": max_children_per_mother,
            "min_cosine":            min_cosine,
        },
    }
    return plan


def _generate_anchors(text: str, n: int = 3) -> List[str]:
    """3 варианта якоря для ссылки. Делаем варианты максимально
    естественными: 1) точная фраза; 2) короткий вариант (главные 2-3 слова);
    3) перифраз с глаголом-индикатором («подробнее о …», «как …»)."""
    if not text:
        return []
    base = text.strip()
    short = " ".join(base.split()[:3])
    paraphrases = [
        base,
        f"подробнее о {short.lower()}" if len(short) > 0 else base,
        f"что важно знать про {short.lower()}" if len(short) > 0 else base,
    ]
    # Дедуп
    seen = set()
    out = []
    for a in paraphrases:
        a = a.strip()
        if not a or a.lower() in seen:
            continue
        seen.add(a.lower())
        out.append(a[:120])
        if len(out) >= n:
            break
    return out


def render_cocoon_markdown(plan: dict) -> str:
    """Рендерит план кокона в markdown-чеклист для копирайтера.
    Используется кнопкой «Скопировать структуру» в UI и для prefill
    задачи info-article."""
    if not plan:
        return ""
    out: List[str] = []
    cible = plan.get("page_cible", {})
    out.append(f"# Семантический кокон: «{cible.get('query', '')}»")
    out.append("")
    out.append(f"**Page Cible** (вершина, ВЧ-запрос): `{cible.get('query', '')}`")
    out.append(f"- URL-slug: `{cible.get('suggested_url_slug', '')}`")
    out.append(f"- Intent: {cible.get('intent', 'info')}")
    out.append("")
    out.append("## Правила перелинковки (золотые правила Bourrelly)")
    rules = plan.get("rules", {})
    out.append(f"- Mère → все Filles: **{rules.get('mother_to_children', '')}**")
    out.append(f"- Fille → Mère: **{rules.get('child_to_mother', '')}**")
    out.append(f"- Sister-ссылки: **{rules.get('sister_links', '')}** (только последовательные шаги)")
    out.append(f"- Кросс-cocoon-ссылки: **{rules.get('cross_cocoon', '')}** — стена между коконами")
    out.append("")
    for m in plan.get("mothers", []):
        out.append(f"## 🟦 Материнская: {m.get('label', '')}")
        out.append(f"- URL-slug: `{m.get('suggested_url_slug', '')}` · Intent: {m.get('intent', '')} · df_share={m.get('df_share_pct', 0)}%")
        out.append(f"- Ссылается на: Cible + {len(m.get('children', []))} Filles")
        for c in m.get("children", []):
            out.append(f"  - 🟢 **{c.get('title', '')}**")
            out.append(f"    - URL-slug: `{c.get('suggested_url_slug', '')}` · Intent: {c.get('intent', '')} · cosine→Mère={c.get('match_cosine', 0)}")
            sister = [l for l in c.get("links_out", []) if l.get("reason", "").startswith("sister_")]
            if sister:
                links_desc = ", ".join(
                    f"{l['reason'].replace('sister_sequential_', '')}={l['target']}"
                    for l in sister
                )
                out.append(f"    - Sister-ссылки: {links_desc}")
        out.append("")
    orphans = plan.get("orphans", [])
    if orphans:
        out.append("## ⚪ Orphans (не привязались ни к одной матери)")
        for o in orphans[:15]:
            out.append(f"- {o.get('phrase', '')} (cosine={o.get('match_cosine', 0)})")
        out.append("")
        out.append("_Рекомендация: либо создайте новую материнскую под эти темы, либо включите их как H3 внутри ближайшей по смыслу Mère._")
    stats = plan.get("stats", {})
    out.append("")
    out.append(f"_Статистика: матерей={stats.get('mothers_count', 0)}, "
               f"дочерних={stats.get('children_total', 0)}, "
               f"orphans={stats.get('orphans_count', 0)}._")
    return "\n".join(out)
