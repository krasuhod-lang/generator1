"""Тесты exporter модуля."""

import pandas as pd
import pytest
from pathlib import Path

from forecaster_py.app.exporter import (
    prepare_export_dataframe,
    export_to_csv,
    export_to_xlsx,
    export_forecasts
)


def test_prepare_export_dataframe():
    """Проверяет подготовку DataFrame для экспорта."""
    df = pd.DataFrame({
        "date": pd.to_datetime(["2024-01-01", "2024-02-01"]),
        "query": ["test", "test"],
        "scenario": ["baseline", "baseline"],
        "demand_forecast": [1000.5, 1100.7],
        "position": [5.2, 4.8],
        "ctr": [0.05, 0.06],
        "traffic_forecast": [50.025, 66.042],
        "demand_lower": [900, 1000],
        "demand_upper": [1100, 1200],
        "traffic_lower": [45, 60],
        "traffic_upper": [55, 72]
    })
    
    prepared = prepare_export_dataframe(df, include_confidence=False)
    
    assert "Месяц" in prepared.columns
    assert "Запрос" in prepared.columns
    assert "Прогноз трафика" in prepared.columns
    assert prepared["Месяц"].iloc[0] == "2024-01"


def test_export_to_csv(tmp_path):
    """Проверяет экспорт в CSV."""
    forecast_df = pd.DataFrame({
        "date": pd.to_datetime(["2024-01-01"]),
        "query": ["test"],
        "scenario": ["baseline"],
        "demand_forecast": [1000],
        "position": [5],
        "ctr": [0.05],
        "traffic_forecast": [50],
        "demand_lower": [900],
        "demand_upper": [1100],
        "traffic_lower": [45],
        "traffic_upper": [55]
    })
    
    forecasts = {"baseline": forecast_df}
    output_file = tmp_path / "test.csv"
    
    export_to_csv(forecasts, output_file, include_confidence=False)
    
    assert output_file.exists()
    
    # Проверяем чтение обратно
    df = pd.read_csv(output_file, encoding="utf-8-sig")
    assert len(df) == 1
    assert "Месяц" in df.columns


def test_export_to_xlsx(tmp_path):
    """Проверяет экспорт в XLSX."""
    forecast_df = pd.DataFrame({
        "date": pd.to_datetime(["2024-01-01"]),
        "query": ["test"],
        "scenario": ["baseline"],
        "demand_forecast": [1000],
        "position": [5],
        "ctr": [0.05],
        "traffic_forecast": [50],
        "demand_lower": [900],
        "demand_upper": [1100],
        "traffic_lower": [45],
        "traffic_upper": [55]
    })
    
    forecasts = {
        "baseline": forecast_df,
        "optimistic": forecast_df.copy()
    }
    output_file = tmp_path / "test.xlsx"
    
    export_to_xlsx(forecasts, output_file, include_confidence=False)
    
    assert output_file.exists()
    
    # Проверяем чтение обратно
    df_base = pd.read_excel(output_file, sheet_name="Baseline", engine="openpyxl")
    assert len(df_base) == 1
    
    df_opt = pd.read_excel(output_file, sheet_name="Optimistic", engine="openpyxl")
    assert len(df_opt) == 1


def test_export_forecasts_auto_format(tmp_path):
    """Проверяет автоопределение формата по расширению."""
    forecast_df = pd.DataFrame({
        "date": pd.to_datetime(["2024-01-01"]),
        "query": ["test"],
        "scenario": ["baseline"],
        "demand_forecast": [1000],
        "position": [5],
        "ctr": [0.05],
        "traffic_forecast": [50],
        "demand_lower": [900],
        "demand_upper": [1100],
        "traffic_lower": [45],
        "traffic_upper": [55]
    })
    
    forecasts = {"baseline": forecast_df}
    
    # CSV
    csv_file = tmp_path / "test.csv"
    export_forecasts(forecasts, csv_file)
    assert csv_file.exists()
    
    # XLSX
    xlsx_file = tmp_path / "test.xlsx"
    export_forecasts(forecasts, xlsx_file)
    assert xlsx_file.exists()
