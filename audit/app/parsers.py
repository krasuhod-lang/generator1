import asyncio
import logging
import json
from typing import List, Optional
import dspy
from bs4 import BeautifulSoup
import aiohttp

from .page_parser import _clean_text
from .fetcher import fetch_page

logger = logging.getLogger("audit.parsers")

class ExtractCompanyServices(dspy.Signature):
    """
    Ты — строгий бизнес-аналитик. Твоя задача — изучить текст сайта компании.
    Извлеки конкретные услуги, которые оказывает компания, и определи, на чем именно она делает упор.
    Отвечай максимально кратко, по делу, без маркетинговой «воды» и общих фраз.
    """
    website_text = dspy.InputField(desc="Сырой текстовый контент сайта (Главная, Услуги, О компании)")
    
    contacts_summary = dspy.OutputField(desc="Сводка контактов (если применимо и найдено)")
    about_summary = dspy.OutputField(desc="Краткое описание 'О компании' (2-3 предложения)")
    services_list = dspy.OutputField(desc="Массив строк: точный перечень оказываемых услуг")
    main_focus = dspy.OutputField(desc="На чем компания делает упор (УТП, специализация, 1-2 предложения)")

async def parse_url_dspy(url: str, extract_contacts: bool, extract_about: bool, extract_services: bool, deepseek_api_key: str) -> dict:
    pages_to_fetch = [url]
    # Patterns for internal links
    patterns = ["/about", "/contact", "/service", "/услуги", "/контакты", "/о-компании"]
    
    htmls = []
    base_host = url.split("://")[-1].split("/")[0]

    async with aiohttp.ClientSession() as session:
        try:
            res = await fetch_page(session, url)
            html = res.html
            htmls.append(html)
            
            # Extract links from main page to find subpages
            soup = BeautifulSoup(html or "", "lxml")
            for a in soup.find_all("a", href=True):
                href = a.get("href", "").lower()
                if any(p in href for p in patterns):
                    if href.startswith("http"):
                        if base_host in href and href not in pages_to_fetch:
                            pages_to_fetch.append(href)
                    elif href.startswith("/"):
                        full_url = url.rstrip("/") + href
                        if full_url not in pages_to_fetch:
                            pages_to_fetch.append(full_url)
                            
            # Fetch found subpages (limit to 5)
            for sub_url in pages_to_fetch[1:6]:
                try:
                    sub_res = await fetch_page(session, sub_url)
                    if sub_res.html:
                        htmls.append(sub_res.html)
                except Exception:
                    continue
        except Exception as e:
            logger.exception(f"Failed to fetch {url}")
            return {"url": url, "status": f"Ошибка доступа: {str(e)[:100]}"}

    combined_html = "\n\n".join(htmls)
    soup = BeautifulSoup(combined_html or "", "lxml")
    
    # Extract titles and metadata
    title_text = ""
    if soup.title and soup.title.string:
        title_text = soup.title.string.strip()
    
    clean_text = _clean_text(html or "", soup) or ""
    # Trim to ~15000-20000 tokens (approx 60000 chars)
    clean_text = clean_text[:60000]
    
    result = {
        "url": url,
        "title": title_text,
        "contacts": "",
        "about": "",
        "services": [],
        "focus": "",
        "status": "Успешно"
    }

    if not clean_text.strip():
        result["status"] = "Ошибка: пустой контент"
        return result

    if extract_services or extract_about or extract_contacts:
        try:
            # Set up DSPy with DeepSeek model
            # DeepSeek uses OpenAI compatible API
            import os
            lm = dspy.LM(
                "openai/deepseek-chat",
                api_key=deepseek_api_key,
                api_base="https://api.deepseek.com",
                max_tokens=1500,
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
                result["services"] = pred.services_list
                result["focus"] = pred.main_focus
                
        except Exception as e:
            logger.exception(f"DSPy extraction failed for {url}")
            result["status"] = f"Ошибка ИИ: {str(e)[:100]}"
            
    return result

