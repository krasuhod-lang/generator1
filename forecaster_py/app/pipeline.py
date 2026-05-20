"""Пайплайн прогнозирования: оркестрация всех шагов.

run_pipeline() — главная функция для выполнения полного цикла.
"""

import logging
from pathlib import Path
from typing import Optional

import pandas as pd

from .config import CONFIG
from .connectors import CSVConnector, XLSXConnector
from .ctr_model import CTRModel
from .demand_model import DemandForecaster
from .exporter import export_forecasts
from .preprocessing import clean_data, detect_and_smooth_anomalies, resample_to_frequency
from .scenarios import ScenarioType, generate_scenarios
from .traffic_calc import (
    aggregate_traffic_summary,
    calculate_multi_scenario_forecast,
)

logger = logging.getLogger("forecaster_py.pipeline")


def run_pipeline(
    input_file: str | Path,
    output_file: str | Path,
    query_name: Optional[str] = None,
    horizon_months: int = CONFIG.default_horizon_months,
    from_position: float = 15.0,
    to_position: float = 3.0,
    scenarios: list[ScenarioType] = None,
    ctr_data_file: Optional[str | Path] = None,
    use_prophet: bool = True,
    include_confidence: bool = False
) -> dict:
    """Полный пайплайн прогнозирования трафика.
    
    Args:
        input_file: путь к CSV/XLSX с историческими данными
        output_file: путь к выходному файлу (CSV/XLSX)
        query_name: имя запроса (опционально, автоопределение)
        horizon_months: горизонт прогноза в месяцах
        from_position: начальная позиция
        to_position: целевая позиция
        scenarios: список сценариев для расчёта (default: все)
        ctr_data_file: путь к CSV с CTR данными (опционально)
        use_prophet: использовать Prophet если доступен
        include_confidence: включить confidence интервалы в экспорт
    
    Returns:
        Словарь с результатами и метаинформацией
    """
    logger.info("=" * 60)
    logger.info("Запуск пайплайна прогнозирования SEO трафика")
    logger.info("=" * 60)
    
    if scenarios is None:
        scenarios = ["pessimistic", "baseline", "optimistic"]
    
    # 1. Загрузка данных
    logger.info(f"Шаг 1/7: Загрузка данных из {input_file}")
    historical_data = _load_data(input_file)
    
    # 2. Определение запроса
    if query_name is None:
        query_name = _detect_query_name(historical_data)
    logger.info(f"  Запрос: {query_name}")
    
    # 3. Препроцессинг
    logger.info("Шаг 2/7: Препроцессинг данных")
    cleaned_data = clean_data(historical_data, value_column="impressions")
    smoothed_data = detect_and_smooth_anomalies(cleaned_data, value_column="impressions")
    monthly_data = resample_to_frequency(smoothed_data, freq="MS", agg="sum")
    logger.info(f"  Подготовлено {len(monthly_data)} месяцев данных")
    
    # 4. Обучение demand модели
    logger.info("Шаг 3/7: Обучение модели прогноза спроса")
    demand_forecaster = DemandForecaster(use_prophet=use_prophet)
    demand_forecaster.fit(monthly_data, value_column="impressions")
    logger.info(f"  Использован метод: {demand_forecaster.method_used}")
    
    # 5. Прогноз спроса
    logger.info(f"Шаг 4/7: Прогноз спроса на {horizon_months} месяцев")
    demand_forecast = demand_forecaster.predict(periods=horizon_months)
    logger.info(f"  Средний прогноз спроса: {demand_forecast['yhat'].mean():.1f}")
    
    # 6. Обучение CTR модели
    logger.info("Шаг 5/7: Обучение CTR модели")
    ctr_model = _build_ctr_model(cleaned_data, ctr_data_file)
    
    # 7. Генерация сценариев позиций
    logger.info("Шаг 6/7: Генерация сценариев роста позиций")
    position_curves = generate_scenarios(
        from_position,
        to_position,
        horizon_months,
        shape="ease_out"
    )
    
    # Фильтруем только нужные сценарии
    position_curves = {k: v for k, v in position_curves.items() if k in scenarios}
    
    # 8. Расчёт прогноза трафика
    logger.info("Шаг 7/7: Расчёт прогноза трафика")
    traffic_forecasts = calculate_multi_scenario_forecast(
        demand_forecast,
        position_curves,
        ctr_model,
        query_name
    )
    
    # 9. Экспорт
    logger.info(f"Экспорт результатов в {output_file}")
    export_forecasts(traffic_forecasts, output_file, include_confidence)
    
    # 10. Сводка
    summary = aggregate_traffic_summary(traffic_forecasts)
    
    logger.info("=" * 60)
    logger.info("Пайплайн завершён успешно")
    for scenario, stats in summary.items():
        logger.info(
            f"  {scenario.capitalize()}: "
            f"{stats['total_traffic']:.0f} посещений "
            f"(avg pos: {stats['avg_position']:.1f})"
        )
    logger.info("=" * 60)
    
    return {
        "success": True,
        "query": query_name,
        "horizon_months": horizon_months,
        "demand_method": demand_forecaster.method_used,
        "ctr_method": ctr_model.method_used,
        "summary": summary,
        "output_file": str(output_file)
    }


def _load_data(file_path: str | Path) -> pd.DataFrame:
    """Загружает данные из CSV или XLSX."""
    path = Path(file_path)
    suffix = path.suffix.lower()
    
    if suffix == ".csv":
        return CSVConnector.load(path)
    elif suffix in [".xlsx", ".xls"]:
        return XLSXConnector.load(path)
    else:
        raise ValueError(f"Неподдерживаемый формат: {suffix}")


def _detect_query_name(df: pd.DataFrame) -> str:
    """Автоопределение имени запроса из данных."""
    if "query" in df.columns:
        unique_queries = df["query"].dropna().unique()
        if len(unique_queries) == 1:
            return str(unique_queries[0])
        elif len(unique_queries) > 1:
            logger.warning(
                f"Обнаружено {len(unique_queries)} уникальных запросов, "
                "используем первый"
            )
            return str(unique_queries[0])
    
    return "unknown_query"


def _build_ctr_model(
    historical_data: pd.DataFrame,
    ctr_data_file: Optional[str | Path]
) -> CTRModel:
    """Строит и обучает CTR модель."""
    ctr_model = CTRModel()
    
    if ctr_data_file is not None:
        # Загружаем отдельный файл с CTR данными
        logger.info(f"  Загрузка CTR данных из {ctr_data_file}")
        ctr_data = _load_data(ctr_data_file)
    else:
        # Используем исторические данные
        logger.info("  Использование исторических данных для CTR")
        ctr_data = historical_data
    
    # Проверяем наличие нужных колонок
    required = {"position", "impressions", "clicks"}
    available = set(ctr_data.columns)
    
    if not required.issubset(available):
        logger.warning(
            f"Недостаточно данных для CTR модели, используем industry-average"
        )
        # Создаём dummy DataFrame для fallback на default curve
        ctr_data = pd.DataFrame({
            "position": [1.0],
            "impressions": [1],
            "clicks": [1]
        })
    
    ctr_model.fit(ctr_data)
    logger.info(f"  CTR модель: {ctr_model.method_used}")
    
    return ctr_model
