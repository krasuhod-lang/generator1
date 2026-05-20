"""Коннекторы для загрузки данных: CSV/XLSX, GSC, Yandex.Webmaster, Wordstat.

Graceful handling: GSC API опционален, может быть недоступен.
"""

import logging
from pathlib import Path
from typing import Optional

import pandas as pd
import requests

from .config import CONFIG

logger = logging.getLogger("forecaster_py.connectors")

# Graceful import GSC
GSC_AVAILABLE = False
try:
    from googleapiclient.discovery import build
    from google.oauth2 import service_account
    GSC_AVAILABLE = True
    logger.info("Google Search Console API доступен")
except ImportError:
    logger.info("Google Search Console API недоступен (опционально)")


class CSVConnector:
    """Загрузчик данных из CSV файла."""
    
    @staticmethod
    def load(file_path: str | Path) -> pd.DataFrame:
        """Загружает данные из CSV.
        
        Expected columns: date, query, impressions, clicks, position
        
        Args:
            file_path: путь к CSV файлу
        
        Returns:
            DataFrame с данными
        """
        try:
            df = pd.read_csv(
                file_path,
                encoding="utf-8-sig",
                parse_dates=["date"]
            )
            logger.info(f"CSV загружен: {len(df)} строк из {file_path}")
            return df
        except Exception as e:
            logger.error(f"Ошибка загрузки CSV {file_path}: {e}")
            raise


class XLSXConnector:
    """Загрузчик данных из XLSX файла."""
    
    @staticmethod
    def load(
        file_path: str | Path,
        sheet_name: str | int = 0,
        max_rows: int = 200000
    ) -> pd.DataFrame:
        """Загружает данные из XLSX.
        
        Expected columns: date, query, impressions, clicks, position
        
        Args:
            file_path: путь к XLSX файлу
            sheet_name: имя или индекс листа
            max_rows: максимальное количество строк (защита от огромных файлов)
        
        Returns:
            DataFrame с данными
        """
        try:
            df = pd.read_excel(
                file_path,
                sheet_name=sheet_name,
                engine="openpyxl",
                nrows=max_rows
            )
            
            # Парсим даты
            if "date" in df.columns:
                df["date"] = pd.to_datetime(df["date"], errors="coerce")
            
            logger.info(f"XLSX загружен: {len(df)} строк из {file_path}")
            return df
        except Exception as e:
            logger.error(f"Ошибка загрузки XLSX {file_path}: {e}")
            raise


class GSCConnector:
    """Коннектор для Google Search Console API.
    
    Опционален, требует google-api-python-client.
    """
    
    def __init__(self, credentials_path: str):
        """
        Args:
            credentials_path: путь к JSON файлу с service account credentials
        """
        if not GSC_AVAILABLE:
            raise ImportError(
                "Google Search Console API недоступен. "
                "Установите: pip install google-api-python-client google-auth"
            )
        
        self.credentials = service_account.Credentials.from_service_account_file(
            credentials_path,
            scopes=["https://www.googleapis.com/auth/webmasters.readonly"]
        )
        self.service = build("searchconsole", "v1", credentials=self.credentials)
    
    def fetch_data(
        self,
        site_url: str,
        start_date: str,
        end_date: str,
        dimensions: list[str] = None
    ) -> pd.DataFrame:
        """Загружает данные из GSC.
        
        Args:
            site_url: URL сайта (например, 'sc-domain:example.com')
            start_date: дата начала (YYYY-MM-DD)
            end_date: дата окончания (YYYY-MM-DD)
            dimensions: список измерений (date, query, page, device, country)
        
        Returns:
            DataFrame с данными
        """
        if dimensions is None:
            dimensions = ["date", "query"]
        
        request_body = {
            "startDate": start_date,
            "endDate": end_date,
            "dimensions": dimensions,
            "rowLimit": 25000
        }
        
        try:
            response = self.service.searchanalytics().query(
                siteUrl=site_url,
                body=request_body
            ).execute()
            
            rows = response.get("rows", [])
            
            data = []
            for row in rows:
                keys = row.get("keys", [])
                item = dict(zip(dimensions, keys))
                item["clicks"] = row["clicks"]
                item["impressions"] = row["impressions"]
                item["ctr"] = row["ctr"]
                item["position"] = row["position"]
                data.append(item)
            
            df = pd.DataFrame(data)
            if "date" in df.columns:
                df["date"] = pd.to_datetime(df["date"])
            
            logger.info(f"GSC: загружено {len(df)} строк")
            return df
        except Exception as e:
            logger.error(f"Ошибка загрузки из GSC: {e}")
            raise


class YandexWebmasterConnector:
    """Коннектор для Яндекс.Вебмастер API.
    
    Использует requests напрямую.
    """
    
    def __init__(self, oauth_token: str):
        """
        Args:
            oauth_token: OAuth токен для Яндекс API
        """
        self.oauth_token = oauth_token
        self.base_url = "https://api.webmaster.yandex.net/v4"
    
    def fetch_query_stats(
        self,
        user_id: int,
        host_id: str,
        date_from: str,
        date_to: str
    ) -> pd.DataFrame:
        """Загружает статистику по запросам.
        
        Args:
            user_id: ID пользователя Яндекс
            host_id: ID хоста в Вебмастере
            date_from: дата начала (YYYY-MM-DD)
            date_to: дата окончания (YYYY-MM-DD)
        
        Returns:
            DataFrame с данными
        """
        headers = {
            "Authorization": f"OAuth {self.oauth_token}",
            "Content-Type": "application/json"
        }
        
        url = f"{self.base_url}/user/{user_id}/hosts/{host_id}/search-queries/popular"
        params = {
            "date_from": date_from,
            "date_to": date_to
        }
        
        try:
            response = requests.get(url, headers=headers, params=params, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            queries = data.get("queries", [])
            
            df = pd.DataFrame(queries)
            logger.info(f"Яндекс.Вебмастер: загружено {len(df)} запросов")
            return df
        except Exception as e:
            logger.error(f"Ошибка загрузки из Яндекс.Вебмастер: {e}")
            raise


class WordstatConnector:
    """Заглушка для Yandex Wordstat / Key Collector API.
    
    В реальности требует отдельной интеграции.
    """
    
    @staticmethod
    def load_from_csv(file_path: str | Path) -> pd.DataFrame:
        """Загружает экспортированные данные Wordstat из CSV.
        
        Expected columns: query, frequency (или impressions)
        
        Args:
            file_path: путь к CSV с данными Wordstat
        
        Returns:
            DataFrame с частотностью
        """
        df = pd.read_csv(file_path, encoding="utf-8-sig")
        logger.info(f"Wordstat CSV загружен: {len(df)} запросов")
        return df
