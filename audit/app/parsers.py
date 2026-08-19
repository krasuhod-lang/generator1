import asyncio
import logging
import json
import hashlib
import os
import re
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse
import dspy
from bs4 import BeautifulSoup
import aiohttp

from .page_parser import _clean_text, _same_domain, base_hostname
from .fetcher import fetch_page
from .store import _redis

logger = logging.getLogger("audit.parsers")

# Модель DeepSeek для парсера. По умолчанию — глубокая deepseek-v4-pro,
# как заявлено в UI. Переопределяется через окружение.
DEEPSEEK_PARSER_MODEL = os.getenv("DEEPSEEK_PARSER_MODEL") or os.getenv("DEEPSEEK_MODEL") or "deepseek-v4-pro"
DEEPSEEK_API_BASE = os.getenv("DEEPSEEK_BASE_URL") or "https://api.deepseek.com"
DEEPSEEK_API_KEY = (os.getenv("DEEPSEEK_API_KEY") or "").strip()

# Максимум внутренних подстраниц, докачиваемых сверх главной. Поднят, чтобы
# успевали попасть страницы клиентов/кейсов/портфолио без взрыва задержки.
MAX_SUBPAGES = int(os.getenv("PARSER_MAX_SUBPAGES") or 8)

# Глубина мини-краула внутри одного сайта. Парсер контента — не полный SEO-аудит,
# но должен вести себя как ограниченный паук, а не читать только главную.
PARSER_MAX_DEPTH = int(os.getenv("PARSER_MAX_DEPTH") or 2)

# Верхний предел очереди обнаруженных URL, чтобы случайный сайт с мегаменю не
# раздувал память и не превращал извлечение одного сайта в полноценный краул.
DISCOVERY_CANDIDATE_LIMIT = int(os.getenv("PARSER_DISCOVERY_CANDIDATE_LIMIT") or 80)

# Сколько подстраниц качаем параллельно (asyncio.gather с ограничением).
SUBPAGE_CONCURRENCY = int(os.getenv("PARSER_SUBPAGE_CONCURRENCY") or 4)

# TTL кэша результатов парсинга (по умолчанию 3 дня).
CACHE_TTL_SECONDS = int(os.getenv("PARSER_CACHE_TTL_SECONDS") or 259200)

# Паттерны внутренних ссылок, по которым ищем подстраницы с доказательной базой
# (услуги/о компании/контакты + клиенты/кейсы/портфолио/проекты/партнёры/отзывы).
LINK_PATTERNS = [
    "/about", "/contact", "/service", "/услуги", "/контакты", "/о-компании",
    "/clients", "/клиенты", "/cases", "/кейсы", "/portfolio", "/портфолио",
    "/projects", "/проекты", "/partners", "/партнеры", "/reviews", "/otzyvy", "/отзывы",
]

AUDIENCE_LINK_HINTS = [
    "client", "customer", "case", "portfolio", "project", "partner", "review",
    "industry", "industries", "solution", "solutions", "segment", "audience",
    "for-", "/for/", "для-", "/для/", "клиент", "заказчик", "кейс", "проект",
    "портфолио", "партнер", "партнёр", "отзыв", "отрасл", "решени", "кому",
]

NOISY_LINK_HINTS = [
    "/login", "/register", "/cart", "/basket", "/checkout", "/privacy",
    "/policy", "/terms", "/user", "/account", "/wp-admin", "/tag/", "/feed",
    "utm_", "print=", "sort=", "filter=", "add-to-cart",
]

# Ссылки, которые заведомо не являются навигацией по сайту.
_SKIP_HREF_PREFIXES = ("mailto:", "tel:", "javascript:", "#", "data:")

_NON_HTML_EXTENSIONS = (
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".zip",
    ".rar", ".7z", ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg",
    ".css", ".js", ".mp4", ".mp3", ".avi", ".mov",
)


def _normalize_internal_link(base_url: str, raw_href: str, base_host: str) -> Optional[str]:
    href = (raw_href or "").strip()
    if not href or href.lower().startswith(_SKIP_HREF_PREFIXES):
        return None
    full_url = urljoin(base_url, href).split("#")[0].strip()
    if not full_url.startswith(("http://", "https://")):
        return None
    if urlparse(full_url).path.lower().endswith(_NON_HTML_EXTENSIONS):
        return None
    if not _same_domain(full_url, base_host):
        return None
    return full_url


def _link_score(url: str, anchor_text: str = "") -> int:
    haystack = f"{url} {anchor_text}".lower()
    if any(noise in haystack for noise in NOISY_LINK_HINTS):
        return -50
    score = 0
    if any(pattern in haystack for pattern in LINK_PATTERNS):
        score += 100
    if any(hint in haystack for hint in AUDIENCE_LINK_HINTS):
        score += 80
    if len(url) < 120:
        score += 5
    return score


def _extract_internal_links(html: str, page_url: str, base_host: str) -> List[Tuple[str, int]]:
    soup = BeautifulSoup(html or "", "lxml")
    found: Dict[str, int] = {}
    for a in soup.find_all("a", href=True):
        full_url = _normalize_internal_link(page_url, a.get("href") or "", base_host)
        if not full_url:
            continue
        score = _link_score(full_url, a.get_text(" ", strip=True))
        if score < 0:
            continue
        found[full_url] = max(score, found.get(full_url, -999))
    return sorted(found.items(), key=lambda item: item[1], reverse=True)


def _coerce_to_list(value) -> list:
    """DSPy OutputField возвращает строку, а не массив. Приводим ответ модели
    к списку строк: поддерживаем JSON-массив, а также перечисления через
    перевод строки / точку с запятой с маркерами списка."""
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if value is None:
        return []
    text = str(value).strip()
    if not text:
        return []
    # JSON-массив (модель часто возвращает именно его).
    if text.startswith("["):
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(v).strip() for v in parsed if str(v).strip()]
        except Exception:
            pass
    # Иначе разбиваем по строкам / «;», убирая маркеры списка.
    items = []
    for raw in re.split(r"[\n;]+", text):
        item = raw.strip().lstrip("-•*").strip()
        item = re.sub(r"^\d+[.)]\s*", "", item).strip()
        if item:
            items.append(item)
    return items or [text]


_AI_FIELD_ALIASES = {
    "contacts summary": "contacts_summary",
    "contacts": "contacts_summary",
    "контакты": "contacts_summary",
    "contacts_summary": "contacts_summary",
    "about summary": "about_summary",
    "about": "about_summary",
    "о компании": "about_summary",
    "about_summary": "about_summary",
    "services list": "services_list",
    "services": "services_list",
    "список услуг": "services_list",
    "услуги": "services_list",
    "services_list": "services_list",
    "main focus": "main_focus",
    "focus": "main_focus",
    "фокус": "main_focus",
    "ключевой упор": "main_focus",
    "main_focus": "main_focus",
    "client segments": "client_segments",
    "client_segments": "client_segments",
    "категории клиентов": "client_segments",
    "works with": "works_with",
    "works_with": "works_with",
    "с кем работает": "works_with",
}


def _canonical_ai_field(name: Any) -> str:
    key = re.sub(r"[*`]+", "", str(name or "")).strip().lower()
    key = re.sub(r"[_\s-]+", " ", key)
    return _AI_FIELD_ALIASES.get(key) or _AI_FIELD_ALIASES.get(key.replace(" ", "_"), "")


def _strip_json_fence(text: str) -> str:
    text = (text or "").strip()
    m = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, flags=re.IGNORECASE | re.DOTALL)
    return m.group(1).strip() if m else text


def _normalize_ai_fields(data: Dict[Any, Any]) -> Dict[str, Any]:
    if not isinstance(data, dict):
        return {}
    out: Dict[str, Any] = {}
    for k, v in (data or {}).items():
        canon = _canonical_ai_field(k)
        if canon:
            out[canon] = v
    return out


def _parse_json_ai_output(text: str) -> Dict[str, Any]:
    raw = _strip_json_fence(text)
    candidates = [raw]
    start, end = raw.find("{"), raw.rfind("}")
    if 0 <= start < end:
        candidates.append(raw[start:end + 1])

    for candidate in candidates:
        current = candidate
        for _ in range(2):
            try:
                parsed = json.loads(current)
            except Exception:
                break
            if isinstance(parsed, dict):
                return _normalize_ai_fields(parsed)
            if isinstance(parsed, str):
                current = _strip_json_fence(parsed)
                continue
            break
    return {}


def _parse_labeled_ai_output(text: str) -> Dict[str, Any]:
    fields: Dict[str, str] = {}
    current: Optional[str] = None
    buf: List[str] = []

    def flush():
        if current:
            value = "\n".join(buf).strip()
            if value:
                fields[current] = value

    for line in (text or "").splitlines():
        stripped = line.strip()
        marker = re.match(r"^\[\[\s*##\s*([\w_]+)\s*##\s*\]\]$", stripped)
        if marker:
            flush()
            current = _canonical_ai_field(marker.group(1))
            buf = []
            continue

        label_match = re.match(r"^[-*•\s]*([^:：]{2,60})[:：]\s*(.*)$", stripped)
        if label_match:
            canon = _canonical_ai_field(label_match.group(1))
            if canon:
                flush()
                current = canon
                buf = [label_match.group(2).strip()] if label_match.group(2).strip() else []
                continue

        if current:
            buf.append(line)

    flush()
    return fields


def _parse_ai_output(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return _normalize_ai_fields(value)
    if value is None:
        return {}
    text = str(value).strip()
    if not text:
        return {}
    return _parse_json_ai_output(text) or _parse_labeled_ai_output(text)


def _ai_field(pred: Any, name: str) -> Any:
    if isinstance(pred, dict):
        return pred.get(name, "")
    return getattr(pred, name, "")


def _prediction_fields(pred: Any) -> Dict[str, Any]:
    parsed = _parse_ai_output(pred)
    if parsed:
        return parsed

    for method_name in ("toDict", "to_dict", "model_dump", "dict"):
        method = getattr(pred, method_name, None)
        if callable(method):
            try:
                parsed = _parse_ai_output(method())
                if parsed:
                    return parsed
            except Exception:
                pass

    fields: Dict[str, Any] = {}
    for name in (
        "contacts_summary", "about_summary", "services_list", "main_focus",
        "client_segments", "works_with",
    ):
        value = getattr(pred, name, None)
        if value not in (None, "", [], {}):
            fields[name] = value
    return fields


def _coerce_to_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return "\n".join(str(v).strip() for v in value if str(v).strip())
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


def _iter_lm_history_outputs(value: Any):
    if value is None:
        return
    if isinstance(value, str):
        yield value
        return
    if isinstance(value, dict):
        for key in ("outputs", "output", "response", "content", "text", "message", "choices"):
            if key in value:
                yield from _iter_lm_history_outputs(value.get(key))
        return
    if isinstance(value, (list, tuple)):
        for item in value:
            yield from _iter_lm_history_outputs(item)
        return
    content = getattr(value, "content", None) or getattr(value, "text", None)
    if content:
        yield from _iter_lm_history_outputs(content)


def _latest_lm_fields(lm: Any) -> Dict[str, Any]:
    """DSPy 2.5 may fail while parsing a valid-but-string response.
    Recover fields from raw LM history so the parser task is not marked failed."""
    for entry in reversed(getattr(lm, "history", []) or []):
        outputs = list(_iter_lm_history_outputs(entry))
        for output in reversed(outputs):
            fields = _parse_ai_output(output)
            if fields:
                return fields
    return {}


def _apply_ai_fields(
    result: Dict[str, Any],
    pred: Any,
    *,
    extract_contacts: bool,
    extract_about: bool,
    extract_services: bool,
    extract_clients: bool,
) -> None:
    pred = _prediction_fields(pred)
    if extract_contacts:
        result["contacts"] = _coerce_to_text(_ai_field(pred, "contacts_summary"))
    if extract_about:
        result["about"] = _coerce_to_text(_ai_field(pred, "about_summary"))
    if extract_services:
        result["services"] = _coerce_to_list(_ai_field(pred, "services_list"))
        result["focus"] = _coerce_to_text(_ai_field(pred, "main_focus"))
    if extract_clients:
        result["client_segments"] = _coerce_to_list(_ai_field(pred, "client_segments"))
        result["works_with"] = _coerce_to_text(_ai_field(pred, "works_with"))


class ExtractCompanyServices(dspy.Signature):
    """
    Ты — строгий бизнес-аналитик, который сегментирует аудиторию компании по её сайту.
    Твоя задача — погрузиться в текст сайта и понять: что компания делает, на чём
    делает упор, И — главное — КТО её клиенты (категории, а не названия) и с кем она работает.

    Отвечай максимально кратко, по делу, без маркетинговой «воды» и общих фраз.

    Алгоритм анализа клиентов (client_segments) выполняй строго по шагам:
      Шаг 1 — Собери сигналы аудитории со ВСЕХ страниц, которые попали в текст:
              «Клиенты», «Кейсы», «Портфолио», «Проекты», «Отзывы», «Отрасли»,
              страницы услуг/решений/тарифов, формулировки «для …», «работаем с …»,
              CTA, описания болей и задач под конкретный тип заказчика.
      Шаг 2 — Сгруппируй сигналы в КАТЕГОРИИ клиентов (сегменты), а не в отдельные бренды.
      Шаг 3 — Для каждого сегмента назови, какую работу/услугу компания делает именно
              для него. Формат элемента: «<категория клиента> — <что делает для них>»
              (например: «стоматологии — SEO и маркетинг», «госзаказчики — тендерное сопровождение»).

    ЖЁСТКИЕ ПРАВИЛА:
      • НИКОГДА не выдумывай. Заполняй client_segments и works_with ТОЛЬКО если на сайте
        есть текстовые доказательства: явные клиентские разделы, кейсы, страницы услуг,
        отраслевые решения, CTA или формулировки задач/болей для конкретной аудитории.
        Если информации о клиентах нет — верни пустой массив [] для client_segments и
        пустую строку "" для works_with. Не догадывайся без опоры на текст.
      • ЗАПРЕЩЕНО указывать конкретные названия клиентов, брендов или логотипов —
        всегда обобщай до КАТЕГОРИИ (отрасль/тип бизнеса/тип заказчика).
      • works_with — одна короткая фраза о позиционировании: B2B / B2C / B2G и тип
        клиентов (например: «B2B: агентства и производители» или «B2C: частные клиенты»).
    """
    website_text = dspy.InputField(desc="Сырой текстовый контент сайта (Главная, Услуги, О компании, Клиенты, Кейсы, Портфолио)")
    
    contacts_summary = dspy.OutputField(desc="Сводка контактов (если применимо и найдено)")
    about_summary = dspy.OutputField(desc="Краткое описание 'О компании' (2-3 предложения)")
    services_list = dspy.OutputField(desc="Массив строк: точный перечень оказываемых услуг")
    main_focus = dspy.OutputField(desc="На чем компания делает упор (УТП, специализация, 1-2 предложения)")
    client_segments = dspy.OutputField(desc="Массив строк с КАТЕГОРИЯМИ клиентов в формате «<категория> — <что делает для них>». Только на основе данных сайта, без названий брендов. Пустой массив [], если данных нет")
    works_with = dspy.OutputField(desc="Одна короткая фраза: B2B/B2C/B2G и тип клиентов, с кем работает компания. Пустая строка, если данных нет")

async def parse_url_dspy(url: str, extract_contacts: bool, extract_about: bool, extract_services: bool, deepseek_api_key: str, extract_clients: bool = False) -> dict:
    key_str = f"{url}_{extract_contacts}_{extract_about}_{extract_services}_{extract_clients}"
    url_hash = hashlib.md5(key_str.encode()).hexdigest()
    cache_key = f"parser:result:v2:{url_hash}"

    if _redis is not None:
        try:
            cached = await _redis.get(cache_key)
            if cached:
                return json.loads(cached)
        except Exception as e:
            logger.debug(f"redis get failed: {e}")

    htmls = []
    base_host = base_hostname(url)

    async with aiohttp.ClientSession() as session:
        try:
            res = await fetch_page(session, url)
            html = res.html if res and res.html else ""
            htmls.append(html)

            seen_urls = {url}
            queue: List[Tuple[str, int, int]] = []
            for link, score in _extract_internal_links(html, url, base_host):
                if link in seen_urls:
                    continue
                seen_urls.add(link)
                queue.append((link, 1, score))

            async def _fetch_sub(item: Tuple[str, int, int]):
                sub_url, depth, score = item
                try:
                    sub_res = await fetch_page(session, sub_url)
                    sub_html = sub_res.html if sub_res and sub_res.html else None
                    return sub_url, depth, score, sub_html
                except Exception:
                    return sub_url, depth, score, None

            while queue and len(htmls) < MAX_SUBPAGES + 1:
                queue.sort(key=lambda item: item[2], reverse=True)
                batch = queue[:SUBPAGE_CONCURRENCY]
                queue = queue[SUBPAGE_CONCURRENCY:]

                for sub_url, depth, _score, sub_html in await asyncio.gather(*[_fetch_sub(item) for item in batch]):
                    if not sub_html:
                        continue
                    htmls.append(sub_html)
                    if len(htmls) >= MAX_SUBPAGES + 1 or depth >= PARSER_MAX_DEPTH:
                        continue
                    for link, score in _extract_internal_links(sub_html, sub_url, base_host):
                        if link in seen_urls:
                            continue
                        if len(seen_urls) >= DISCOVERY_CANDIDATE_LIMIT:
                            break
                        seen_urls.add(link)
                        queue.append((link, depth + 1, score))
        except Exception as e:
            logger.exception(f"Failed to fetch {url}")
            return {"url": url, "status": f"Ошибка доступа: {str(e)[:100]}"}

    combined_html = "\n\n".join(h for h in htmls if h)
    soup = BeautifulSoup(combined_html or "", "lxml")
    
    # Extract titles and metadata (заголовок берём с главной страницы)
    title_text = ""
    if soup.title and soup.title.string:
        title_text = soup.title.string.strip()
    
    # БАГФИКС: чистим КАЖДУЮ страницу отдельно (trafilatura/readability
    # работают по одному документу) и склеиваем, иначе до LLM доходила только
    # главная страница, а докачанные подстраницы клиентов/кейсов терялись.
    cleaned_parts = []
    for h in htmls:
        if not h:
            continue
        part = _clean_text(h, BeautifulSoup(h, "lxml")) or ""
        part = part.strip()
        if part:
            cleaned_parts.append(part)
    clean_text = "\n\n".join(cleaned_parts)
    # Trim to ~15000-20000 tokens (approx 60000 chars)
    clean_text = clean_text[:60000]
    
    result = {
        "url": url,
        "title": title_text,
        "contacts": "",
        "about": "",
        "services": [],
        "focus": "",
        "client_segments": [],
        "works_with": "",
        "status": "Успешно"
    }
    effective_api_key = (deepseek_api_key or DEEPSEEK_API_KEY or "").strip()

    if not clean_text.strip():
        result["status"] = "Ошибка: пустой контент"
        if _redis is not None:
            try:
                await _redis.set(cache_key, json.dumps(result, ensure_ascii=False), ex=CACHE_TTL_SECONDS)
            except Exception as e:
                logger.debug(f"redis set failed: {e}")
        return result

    if extract_services or extract_about or extract_contacts or extract_clients:
        if not effective_api_key:
            result["status"] = "Ошибка ИИ: не задан DEEPSEEK_API_KEY"
        else:
            try:
                # Set up DSPy with DeepSeek model
                # DeepSeek uses OpenAI compatible API
                lm = dspy.LM(
                    f"openai/{DEEPSEEK_PARSER_MODEL}",
                    api_key=effective_api_key,
                    api_base=DEEPSEEK_API_BASE,
                    max_tokens=2500,
                    temperature=0.3
                )
                dspy.settings.configure(lm=lm)

                # Define predictor
                extractor = dspy.Predict(ExtractCompanyServices)
                
                # Since dspy is synchronous, we run it in an executor
                def _run_dspy():
                    return extractor(website_text=clean_text)
                    
                loop = asyncio.get_running_loop()
                pred = await loop.run_in_executor(None, _run_dspy)
                _apply_ai_fields(
                    result,
                    pred,
                    extract_contacts=extract_contacts,
                    extract_about=extract_about,
                    extract_services=extract_services,
                    extract_clients=extract_clients,
                )
                     
            except Exception as e:
                recovered = _latest_lm_fields(locals().get("lm"))
                if recovered:
                    _apply_ai_fields(
                        result,
                        recovered,
                        extract_contacts=extract_contacts,
                        extract_about=extract_about,
                        extract_services=extract_services,
                        extract_clients=extract_clients,
                    )
                else:
                    logger.exception(f"DSPy extraction failed for {url}")
                    result["status"] = f"Ошибка ИИ: {str(e)[:100]}"
            
    # Кэшируем только успешные результаты. Если ИИ-извлечение было запрошено, но
    # модель не вернула ни одного поля — вероятен молчаливый сбой, не кэшируем,
    # чтобы следующий запрос повторил попытку, а не читал «пустышку».
    llm_requested = extract_services or extract_about or extract_contacts or extract_clients
    produced_any = bool(
        result["contacts"] or result["about"] or result["services"]
        or result["focus"] or result["client_segments"] or result["works_with"]
    )
    if _redis is not None and result["status"] == "Успешно" and (not llm_requested or produced_any):
        try:
            await _redis.set(cache_key, json.dumps(result, ensure_ascii=False), ex=CACHE_TTL_SECONDS)
        except Exception as e:
            logger.debug(f"redis set failed: {e}")

    return result
