import asyncio
import logging
import json
import hashlib
import os
import re
from typing import List, Optional
from urllib.parse import urljoin
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

# Максимум внутренних подстраниц, докачиваемых сверх главной. Поднят, чтобы
# успевали попасть страницы клиентов/кейсов/портфолио без взрыва задержки.
MAX_SUBPAGES = int(os.getenv("PARSER_MAX_SUBPAGES") or 8)

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

# Ссылки, которые заведомо не являются навигацией по сайту.
_SKIP_HREF_PREFIXES = ("mailto:", "tel:", "javascript:", "#", "data:")


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


class ExtractCompanyServices(dspy.Signature):
    """
    Ты — строгий бизнес-аналитик, который сегментирует аудиторию компании по её сайту.
    Твоя задача — погрузиться в текст сайта и понять: что компания делает, на чём
    делает упор, И — главное — КТО её клиенты (категории, а не названия) и с кем она работает.

    Отвечай максимально кратко, по делу, без маркетинговой «воды» и общих фраз.

    Алгоритм анализа клиентов (client_segments) выполняй строго по шагам:
      Шаг 1 — Собери сигналы аудитории: разделы «Клиенты», «Кейсы», «Портфолио»,
              «Проекты», «Отзывы», «Отрасли», формулировки «для …», «работаем с …»,
              описания решаемых задач под конкретный тип заказчика.
      Шаг 2 — Сгруппируй сигналы в КАТЕГОРИИ клиентов (сегменты), а не в отдельные бренды.
      Шаг 3 — Для каждого сегмента назови, какую работу/услугу компания делает именно
              для него. Формат элемента: «<категория клиента> — <что делает для них>»
              (например: «стоматологии — SEO и маркетинг», «госзаказчики — тендерное сопровождение»).

    ЖЁСТКИЕ ПРАВИЛА:
      • НИКОГДА не выдумывай. Заполняй client_segments и works_with ТОЛЬКО если на сайте
        есть прямые доказательства. Если информации о клиентах нет — верни пустой массив
        [] для client_segments и пустую строку "" для works_with. Не догадывайся.
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

    pages_to_fetch = [url]
    # Patterns for internal links (услуги/о компании/контакты + клиенты/кейсы/портфолио)
    patterns = LINK_PATTERNS
    
    htmls = []
    base_host = base_hostname(url)

    async with aiohttp.ClientSession() as session:
        try:
            res = await fetch_page(session, url)
            html = res.html
            htmls.append(html)
            
            # Extract links from main page to find subpages
            soup = BeautifulSoup(html or "", "lxml")
            for a in soup.find_all("a", href=True):
                raw_href = (a.get("href") or "").strip()
                if not raw_href:
                    continue
                href_l = raw_href.lower()
                if href_l.startswith(_SKIP_HREF_PREFIXES):
                    continue
                if not any(p in href_l for p in patterns):
                    continue
                # urljoin корректно склеивает относительные/protocol-relative
                # ссылки с учётом пути базового URL, без обрезки хвоста.
                full_url = urljoin(url, raw_href).split("#")[0]
                if not full_url.startswith(("http://", "https://")):
                    continue
                # Только внутренние ссылки того же домена (без ложных совпадений
                # по подстроке — используем разбор хоста из page_parser).
                if not _same_domain(full_url, base_host):
                    continue
                if full_url not in pages_to_fetch:
                    pages_to_fetch.append(full_url)
                            
            # Fetch found subpages (limit to MAX_SUBPAGES) параллельно, с
            # ограничением одновременных запросов, чтобы не ждать их по очереди.
            sub_urls = pages_to_fetch[1:MAX_SUBPAGES + 1]
            if sub_urls:
                sem = asyncio.Semaphore(SUBPAGE_CONCURRENCY)

                async def _fetch_sub(sub_url):
                    async with sem:
                        try:
                            sub_res = await fetch_page(session, sub_url)
                            return sub_res.html if sub_res and sub_res.html else None
                        except Exception:
                            return None

                for sub_html in await asyncio.gather(*[_fetch_sub(u) for u in sub_urls]):
                    if sub_html:
                        htmls.append(sub_html)
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

    if not clean_text.strip():
        result["status"] = "Ошибка: пустой контент"
        if _redis is not None:
            try:
                await _redis.set(cache_key, json.dumps(result, ensure_ascii=False), ex=CACHE_TTL_SECONDS)
            except Exception as e:
                logger.debug(f"redis set failed: {e}")
        return result

    if extract_services or extract_about or extract_contacts or extract_clients:
        try:
            # Set up DSPy with DeepSeek model
            # DeepSeek uses OpenAI compatible API
            lm = dspy.LM(
                f"openai/{DEEPSEEK_PARSER_MODEL}",
                api_key=deepseek_api_key,
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
            
            if extract_contacts:
                result["contacts"] = pred.contacts_summary
            if extract_about:
                result["about"] = pred.about_summary
            if extract_services:
                result["services"] = _coerce_to_list(pred.services_list)
                result["focus"] = pred.main_focus
            if extract_clients:
                result["client_segments"] = _coerce_to_list(pred.client_segments)
                result["works_with"] = pred.works_with
                
        except Exception as e:
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

