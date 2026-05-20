"""Тесты pipeline модуля."""

import pandas as pd
import pytest
from pathlib import Path

from forecaster_py.app.pipeline import run_pipeline


def test_run_pipeline_csv(tmp_path, synthetic_time_series):
    """Проверяет полный пайплайн с CSV."""
    # Подготовка входного CSV
    input_file = tmp_path / "input.csv"
    synthetic_time_series.to_csv(input_file, index=False, encoding="utf-8-sig")
    
    output_file = tmp_path / "output.xlsx"
    
    # Запуск пайплайна
    result = run_pipeline(
        input_file=input_file,
        output_file=output_file,
        query_name="test query",
        horizon_months=6,
        from_position=10.0,
        to_position=3.0,
        scenarios=["baseline"],
        use_prophet=False  # Используем SARIMA/OLS для тестов
    )
    
    assert result["success"] is True
    assert result["query"] == "test query"
    assert result["horizon_months"] == 6
    assert output_file.exists()
    
    # Проверяем выходной файл
    df = pd.read_excel(output_file, sheet_name="Baseline", engine="openpyxl")
    assert len(df) == 6


def test_run_pipeline_xlsx(tmp_path, synthetic_time_series):
    """Проверяет пайплайн с XLSX входом и CSV выходом."""
    # Подготовка входного XLSX
    input_file = tmp_path / "input.xlsx"
    synthetic_time_series.to_excel(input_file, index=False, engine="openpyxl")
    
    output_file = tmp_path / "output.csv"
    
    # Запуск пайплайна
    result = run_pipeline(
        input_file=input_file,
        output_file=output_file,
        horizon_months=3,
        from_position=15.0,
        to_position=5.0,
        scenarios=["pessimistic", "optimistic"],
        use_prophet=False
    )
    
    assert result["success"] is True
    assert output_file.exists()
    
    # Проверяем выходной CSV
    df = pd.read_csv(output_file, encoding="utf-8-sig")
    # 3 месяца × 2 сценария = 6 строк
    assert len(df) == 6
