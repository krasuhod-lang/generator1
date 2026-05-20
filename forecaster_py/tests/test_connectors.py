"""Тесты connectors модуля."""

import pandas as pd
import pytest
from pathlib import Path

from forecaster_py.app.connectors import CSVConnector, XLSXConnector


def test_csv_connector_load(tmp_path):
    """Проверяет загрузку CSV."""
    # Создаём тестовый CSV
    csv_file = tmp_path / "test.csv"
    df = pd.DataFrame({
        "date": ["2024-01-01", "2024-02-01"],
        "query": ["test", "test"],
        "impressions": [1000, 1100],
        "clicks": [50, 60],
        "position": [5, 4]
    })
    df.to_csv(csv_file, index=False, encoding="utf-8-sig")
    
    # Загружаем
    loaded = CSVConnector.load(csv_file)
    
    assert len(loaded) == 2
    assert "date" in loaded.columns
    assert pd.api.types.is_datetime64_any_dtype(loaded["date"])


def test_xlsx_connector_load(tmp_path):
    """Проверяет загрузку XLSX."""
    # Создаём тестовый XLSX
    xlsx_file = tmp_path / "test.xlsx"
    df = pd.DataFrame({
        "date": pd.to_datetime(["2024-01-01", "2024-02-01"]),
        "query": ["test", "test"],
        "impressions": [1000, 1100],
        "clicks": [50, 60],
        "position": [5, 4]
    })
    df.to_excel(xlsx_file, index=False, engine="openpyxl")
    
    # Загружаем
    loaded = XLSXConnector.load(xlsx_file)
    
    assert len(loaded) == 2
    assert "date" in loaded.columns


def test_csv_connector_invalid_file():
    """Проверяет обработку несуществующего файла."""
    with pytest.raises(Exception):
        CSVConnector.load("nonexistent.csv")
