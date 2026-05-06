"""Tokenization, lemmatization and POS-tagging for Russian text via pymorphy3.

Используется и для словаря BM25 (леммы), и для n-грамм (леммы + POS-теги).
Стоп-слова — RU базовый набор + предлоги/союзы/частицы режем по POS.
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import List, Tuple

import pymorphy3

# Один глобальный анализатор — он thread-safe для read-only морф. словаря.
_MORPH = pymorphy3.MorphAnalyzer()

# Минимальный набор RU стоп-слов. Грамматические части речи (PREP/CONJ/PRCL/INTJ)
# отфильтровываются дополнительно через тег pymorphy — ловим даже редкие случаи.
RU_STOPWORDS = {
    # Местоимения и общие
    "я", "мы", "ты", "вы", "он", "она", "оно", "они", "его", "её", "их", "им",
    "мой", "моя", "моё", "мои", "наш", "наша", "наше", "наши", "ваш", "ваша",
    "ваше", "ваши", "свой", "своя", "своё", "свои", "этот", "эта", "это", "эти",
    "тот", "та", "то", "те", "такой", "такая", "такое", "такие",
    "себя", "себе", "собой",
    # Союзы / частицы / предлоги — на всякий случай (POS-фильтр их и так
    # выбросит, но пусть будут и в списке для скорости).
    "и", "в", "во", "не", "на", "с", "со", "а", "то", "за", "по", "от", "для",
    "о", "об", "у", "из", "к", "ко", "при", "под", "над", "без", "до", "про",
    "через", "между", "после", "перед", "что", "как", "так", "же", "ли", "бы",
    "был", "была", "было", "были", "быть", "есть", "нет", "да",
    "или", "но", "если", "когда", "потому", "поэтому", "чтобы", "чем",
    "там", "тут", "здесь", "уже", "ещё", "еще", "только", "тоже", "также",
    # Шум-частицы
    "вот", "ну", "просто", "очень", "более", "менее", "иногда", "всегда",
    "всё", "все", "весь", "вся", "каждый", "любой", "другой", "другая", "другое",
    # Веб-слова, не несущие смысла
    "далее", "перейти", "сайт", "страница", "ссылка", "ссылки",
    "подробнее", "ниже", "выше", "также",
}

# Грамматические POS pymorphy, которые мы НЕ берём ни в словарь, ни в n-граммы.
EXCLUDE_POS = {
    "PREP",   # предлог
    "CONJ",   # союз
    "PRCL",   # частица
    "INTJ",   # междометие
    "NPRO",   # местоимение-существительное (я, мы, кто, что …)
    "NUMR",   # числительное (типа «три», «двадцать») — даёт «3», «10» и т.п.
    "Apro",   # местоимение-прилагательное (мой, наш …)
    "PRED",   # предикатив (нельзя, можно)
    "COMP",   # компаратив
}

# POS-теги, разрешённые в n-граммах (содержательные части речи).
ALLOWED_POS_FOR_NGRAMS = {"NOUN", "ADJF", "ADJS", "VERB", "INFN", "PRTF", "PRTS"}

# Простой токенизатор: только русские буквы (с дефисом для составных слов).
_TOKEN_RE = re.compile(r"[а-яёА-ЯЁ]+(?:-[а-яёА-ЯЁ]+)?")


def tokenize(text: str) -> List[str]:
    """Разбиение текста на сырые токены (lower-case, только кириллица)."""
    if not text:
        return []
    return [m.group(0).lower() for m in _TOKEN_RE.finditer(text)]


@lru_cache(maxsize=200_000)
def _parse_token(token: str):
    """Кэшированный pymorphy.parse — морф. разбор одного слова."""
    parses = _MORPH.parse(token)
    return parses[0] if parses else None


def lemmatize_with_pos(token: str) -> Tuple[str, str]:
    """Возвращает (лемму, POS-тег) или ('', '') если токен мусорный."""
    if len(token) < 3:
        return "", ""
    p = _parse_token(token)
    if p is None:
        return "", ""
    pos = (p.tag.POS or "")
    if pos in EXCLUDE_POS:
        return "", ""
    lemma = (p.normal_form or "").strip().lower()
    if not lemma or lemma in RU_STOPWORDS:
        return "", ""
    if not _TOKEN_RE.fullmatch(lemma):
        return "", ""
    return lemma, pos


def normalize_document(text: str) -> Tuple[List[str], List[Tuple[str, str]]]:
    """Возвращает (lemmas_only, lemmas_with_pos).

    * lemmas_only — для BM25 (порядок не важен, но мы его сохраняем).
    * lemmas_with_pos — для n-грамм (порядок важен; пустые токены вставляем
      как ('', ''), чтобы не сшивать разорванные предлогом фразы).
    """
    if not text:
        return [], []
    raw_tokens = tokenize(text)
    lemmas: List[str] = []
    seq: List[Tuple[str, str]] = []
    for t in raw_tokens:
        lemma, pos = lemmatize_with_pos(t)
        if lemma:
            lemmas.append(lemma)
            seq.append((lemma, pos))
        else:
            # маркер «разрыва» — n-граммы через него не строятся
            seq.append(("", ""))
    return lemmas, seq
