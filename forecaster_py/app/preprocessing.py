"""Препроцессинг данных: очистка NaN, дубликатов, аномалий.

Graceful handling: если Kats недоступен, используется rolling median + IQR.
"""

import logging
from typing import Optional

import numpy as np
import pandas as pd
from scipy.stats import iqr as scipy_iqr

from .config import CONFIG

logger = logging.getLogger("forecaster_py.preprocessing")

# Graceful import Kats
KATS_AVAILABLE = False
try:
    from kats.detectors.outlier import OutlierDetector
    KATS_AVAILABLE = True
    logger.info("Kats доступна для детекции аномалий")
except ImportError:
    logger.info("Kats недоступна, будет использован fallback IQR")


def clean_data(df: pd.DataFrame, value_column: str = "impressions") -> pd.DataFrame:
    """Очищает DataFrame от NaN, дубликатов, валидирует даты.
    
    Args:
        df: DataFrame с колонкой 'date' и value_column
        value_column: имя колонки для валидации значений
    
    Returns:
        Очищенный DataFrame
    """
    if df.empty:
        logger.warning("Пустой DataFrame на входе")
        return df
    
    original_len = len(df)
    
    # Удаляем дубликаты по дате
    df = df.drop_duplicates(subset=["date"], keep="last").copy()
    
    # Убираем NaN в критических колонках
    df = df.dropna(subset=["date", value_column])
    
    # Конвертируем дату
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df = df.dropna(subset=["date"])
    
    # Сортируем по дате
    df = df.sort_values("date").reset_index(drop=True)
    
    # Убираем нулевые/отрицательные значения
    df = df[df[value_column] > 0]
    
    cleaned_len = len(df)
    if cleaned_len < original_len:
        logger.info(f"Очищено {original_len - cleaned_len} строк, осталось {cleaned_len}")
    
    return df


def detect_and_smooth_anomalies(
    df: pd.DataFrame,
    value_column: str = "impressions",
    use_kats: bool = True
) -> pd.DataFrame:
    """Детектирует и сглаживает аномалии.
    
    Args:
        df: DataFrame с колонками 'date' и value_column
        value_column: имя колонки для обработки
        use_kats: попытаться использовать Kats (если доступна)
    
    Returns:
        DataFrame со сглаженными аномалиями
    """
    if df.empty or len(df) < 10:
        logger.warning("Недостаточно данных для детекции аномалий")
        return df
    
    df = df.copy()
    
    if KATS_AVAILABLE and use_kats:
        try:
            return _detect_with_kats(df, value_column)
        except Exception as e:
            logger.warning(f"Kats детекция провалилась: {e}, используем fallback")
    
    # Fallback: IQR + rolling median
    return _detect_with_iqr(df, value_column)


def _detect_with_kats(df: pd.DataFrame, value_column: str) -> pd.DataFrame:
    """Детекция аномалий через Kats OutlierDetector."""
    from kats.consts import TimeSeriesData
    
    ts_data = TimeSeriesData(
        pd.DataFrame({
            "time": df["date"],
            "value": df[value_column]
        })
    )
    
    detector = OutlierDetector(ts_data, "additive")
    detected = detector.detector()
    
    anomaly_indices = detected["outliers"]
    if anomaly_indices:
        logger.info(f"Kats: обнаружено {len(anomaly_indices)} аномалий")
        # Интерполяция
        df.loc[anomaly_indices, value_column] = np.nan
        df[value_column] = df[value_column].interpolate(method="linear")
    
    return df


def _detect_with_iqr(df: pd.DataFrame, value_column: str) -> pd.DataFrame:
    """Fallback детекция через IQR + rolling median."""
    values = df[value_column].values
    
    # Rolling median для сглаживания
    window = min(CONFIG.rolling_window, len(df) // 2)
    if window < 3:
        return df
    
    rolling_median = pd.Series(values).rolling(window, center=True).median()
    rolling_median = rolling_median.bfill().ffill()
    
    # Отклонения
    residuals = values - rolling_median.values
    
    # IQR
    q1 = np.percentile(residuals, 25)
    q3 = np.percentile(residuals, 75)
    iqr_val = q3 - q1
    
    lower_bound = q1 - CONFIG.anomaly_iqr_multiplier * iqr_val
    upper_bound = q3 + CONFIG.anomaly_iqr_multiplier * iqr_val
    
    # Находим аномалии
    anomalies = (residuals < lower_bound) | (residuals > upper_bound)
    n_anomalies = anomalies.sum()
    
    if n_anomalies > 0:
        logger.info(f"IQR: обнаружено {n_anomalies} аномалий")
        df = df.copy()
        df.loc[anomalies, value_column] = np.nan
        df[value_column] = df[value_column].interpolate(method="linear")
        df[value_column] = df[value_column].bfill().ffill()
    
    return df


def resample_to_frequency(
    df: pd.DataFrame,
    freq: str = "MS",
    agg: str = "sum"
) -> pd.DataFrame:
    """Ресемплирует временной ряд к нужной частоте.
    
    Args:
        df: DataFrame с колонкой 'date' (index)
        freq: частота ('D', 'W', 'MS' для начала месяца)
        agg: метод агрегации ('sum', 'mean')
    
    Returns:
        Ресемплированный DataFrame
    """
    if df.empty:
        return df
    
    df = df.copy()
    if "date" in df.columns:
        df = df.set_index("date")
    
    if agg == "sum":
        resampled = df.resample(freq).sum()
    elif agg == "mean":
        resampled = df.resample(freq).mean()
    else:
        raise ValueError(f"Неподдерживаемая агрегация: {agg}")
    
    # Убираем нулевые строки после ресемплинга (только числовые колонки)
    numeric_cols = resampled.select_dtypes(include=[np.number]).columns
    if len(numeric_cols) > 0:
        resampled = resampled[resampled[numeric_cols].sum(axis=1) > 0]
    
    return resampled.reset_index()
