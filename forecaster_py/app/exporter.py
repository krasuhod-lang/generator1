"""Экспорт результатов в CSV и XLSX с русскими заголовками."""

import logging
from pathlib import Path

import pandas as pd

from .config import CONFIG
from .scenarios import ScenarioType

logger = logging.getLogger("forecaster_py.exporter")

# Мапинг колонок на русские названия (согласно ТЗ)
COLUMN_MAPPING = {
    "date": "Месяц",
    "query": "Запрос",
    "scenario": "Сценарий",
    "demand_forecast": "Прогноз спроса",
    "position": "Ожидаемая позиция",
    "ctr": "Расчетный CTR",
    "traffic_forecast": "Прогноз трафика",
    "demand_lower": "Спрос (нижн.)",
    "demand_upper": "Спрос (верхн.)",
    "traffic_lower": "Трафик (нижн.)",
    "traffic_upper": "Трафик (верхн.)"
}


def prepare_export_dataframe(
    forecast_df: pd.DataFrame,
    include_confidence: bool = False
) -> pd.DataFrame:
    """Подготавливает DataFrame для экспорта.
    
    Args:
        forecast_df: DataFrame с прогнозом
        include_confidence: включить ли confidence интервалы
    
    Returns:
        DataFrame с переименованными колонками
    """
    if include_confidence:
        columns = [
            "date", "query", "scenario",
            "demand_forecast", "demand_lower", "demand_upper",
            "position", "ctr",
            "traffic_forecast", "traffic_lower", "traffic_upper"
        ]
    else:
        columns = [
            "date", "query", "scenario",
            "demand_forecast", "position", "ctr", "traffic_forecast"
        ]
    
    # Выбираем нужные колонки
    df = forecast_df[columns].copy()
    
    # Форматируем дату
    df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m")
    
    # Округляем числа
    numeric_cols = df.select_dtypes(include=["float", "int"]).columns
    for col in numeric_cols:
        df[col] = df[col].round(2)
    
    # Переименовываем колонки на русский
    rename_map = {k: v for k, v in COLUMN_MAPPING.items() if k in df.columns}
    df = df.rename(columns=rename_map)
    
    return df


def export_to_csv(
    forecasts: dict[ScenarioType, pd.DataFrame],
    output_path: str | Path,
    include_confidence: bool = False
) -> None:
    """Экспортирует прогнозы в CSV.
    
    Args:
        forecasts: словарь {scenario: forecast_df}
        output_path: путь к выходному CSV файлу
        include_confidence: включить ли confidence интервалы
    """
    # Объединяем все сценарии в один DataFrame
    dfs = []
    for scenario, df in forecasts.items():
        prepared = prepare_export_dataframe(df, include_confidence)
        dfs.append(prepared)
    
    combined = pd.concat(dfs, ignore_index=True)
    
    # Проверка размера
    if len(combined) > CONFIG.export_max_rows:
        logger.warning(
            f"Слишком много строк ({len(combined)}), обрезаем до {CONFIG.export_max_rows}"
        )
        combined = combined.head(CONFIG.export_max_rows)
    
    # Экспорт с UTF-8 BOM
    try:
        combined.to_csv(output_path, index=False, encoding="utf-8-sig")
        logger.info(f"CSV экспортирован: {output_path} ({len(combined)} строк)")
    except Exception as e:
        logger.error(f"Ошибка экспорта CSV: {e}")
        raise


def export_to_xlsx(
    forecasts: dict[ScenarioType, pd.DataFrame],
    output_path: str | Path,
    include_confidence: bool = False
) -> None:
    """Экспортирует прогнозы в XLSX (отдельные листы для каждого сценария).
    
    Args:
        forecasts: словарь {scenario: forecast_df}
        output_path: путь к выходному XLSX файлу
        include_confidence: включить ли confidence интервалы
    """
    try:
        with pd.ExcelWriter(output_path, engine="openpyxl") as writer:
            for scenario, df in forecasts.items():
                prepared = prepare_export_dataframe(df, include_confidence)
                
                # Проверка размера
                if len(prepared) > CONFIG.export_max_rows:
                    logger.warning(
                        f"Сценарий {scenario}: слишком много строк, обрезаем"
                    )
                    prepared = prepared.head(CONFIG.export_max_rows)
                
                # Имя листа (с заглавной буквы)
                sheet_name = scenario.capitalize()
                prepared.to_excel(writer, sheet_name=sheet_name, index=False)
        
        logger.info(f"XLSX экспортирован: {output_path}")
    except Exception as e:
        logger.error(f"Ошибка экспорта XLSX: {e}")
        raise


def export_forecasts(
    forecasts: dict[ScenarioType, pd.DataFrame],
    output_path: str | Path,
    include_confidence: bool = False
) -> None:
    """Автоматически определяет формат по расширению и экспортирует.
    
    Args:
        forecasts: словарь {scenario: forecast_df}
        output_path: путь к выходному файлу (.csv или .xlsx)
        include_confidence: включить ли confidence интервалы
    """
    path = Path(output_path)
    suffix = path.suffix.lower()
    
    if suffix == ".csv":
        export_to_csv(forecasts, path, include_confidence)
    elif suffix in [".xlsx", ".xls"]:
        export_to_xlsx(forecasts, path, include_confidence)
    else:
        raise ValueError(f"Неподдерживаемый формат: {suffix}. Используйте .csv или .xlsx")
