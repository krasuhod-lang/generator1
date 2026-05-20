"""Модель CTR в зависимости от позиции.

Использует IsotonicRegression (приоритет) или polyfit (fallback).
"""

import logging
from typing import Optional, Union

import numpy as np
import pandas as pd
from sklearn.isotonic import IsotonicRegression

from .config import CONFIG

logger = logging.getLogger("forecaster_py.ctr_model")


class CTRModel:
    """Модель CTR(position) на основе собственных данных проекта.
    
    Использует IsotonicRegression (decreasing) как приоритет,
    polyfit degree=2 как fallback.
    """
    
    def __init__(self):
        self.model = None
        self.method_used = None
        self.position_range = CONFIG.ctr_position_range
    
    def fit(self, df: pd.DataFrame) -> None:
        """Обучает модель CTR на данных.
        
        Args:
            df: DataFrame с колонками position, impressions, clicks
                или position, ctr, weight
        """
        if df.empty:
            raise ValueError("Пустой DataFrame для обучения CTR модели")
        
        # Подготовка данных
        if "ctr" in df.columns:
            positions = df["position"].values
            ctr_values = df["ctr"].values
            weights = df.get("weight", pd.Series(np.ones(len(df)))).values
        elif "impressions" in df.columns and "clicks" in df.columns:
            positions = df["position"].values
            ctr_values = df["clicks"] / df["impressions"]
            weights = df["impressions"].values
        else:
            raise ValueError("DataFrame должен содержать (position, impressions, clicks) или (position, ctr, weight)")
        
        # Фильтруем валидные данные
        valid_mask = (
            (~np.isnan(positions)) &
            (~np.isnan(ctr_values)) &
            (~np.isnan(weights)) &
            (ctr_values >= 0) &
            (ctr_values <= 1) &
            (weights > 0)
        )
        
        positions = positions[valid_mask]
        ctr_values = ctr_values[valid_mask]
        weights = weights[valid_mask]
        
        if len(positions) < CONFIG.ctr_min_data_points:
            logger.warning(
                f"Недостаточно данных ({len(positions)}), используем industry-average CTR"
            )
            self._fit_default_curve()
            return
        
        # Попытка IsotonicRegression
        try:
            self._fit_isotonic(positions, ctr_values, weights)
            return
        except Exception as e:
            logger.warning(f"IsotonicRegression провалился: {e}, используем polyfit")
        
        # Fallback на polyfit
        self._fit_polyfit(positions, ctr_values, weights)
    
    def predict_ctr(self, position: Union[float, np.ndarray]) -> Union[float, np.ndarray]:
        """Предсказывает CTR для заданной позиции.
        
        Args:
            position: позиция или массив позиций
        
        Returns:
            CTR или массив CTR
        """
        if self.model is None:
            raise ValueError("Модель не обучена, вызовите fit() сначала")
        
        is_scalar = np.isscalar(position)
        pos_array = np.atleast_1d(position)
        
        # Клипаем в допустимый диапазон
        pos_clipped = np.clip(pos_array, *self.position_range)
        
        if self.method_used == "isotonic":
            ctr = self.model["isotonic"].predict(pos_clipped)
        elif self.method_used == "polyfit":
            poly = self.model["poly"]
            ctr = np.polyval(poly, pos_clipped)
        elif self.method_used == "default":
            ctr = self._predict_from_default(pos_clipped)
        else:
            raise ValueError(f"Неизвестный метод: {self.method_used}")
        
        # Клипаем CTR в [0, 1]
        ctr = np.clip(ctr, 0.0, 1.0)
        
        return float(ctr[0]) if is_scalar else ctr
    
    def _fit_isotonic(
        self,
        positions: np.ndarray,
        ctr_values: np.ndarray,
        weights: np.ndarray
    ) -> None:
        """Обучает IsotonicRegression (decreasing)."""
        model = IsotonicRegression(
            increasing=False,
            out_of_bounds="clip"
        )
        model.fit(positions, ctr_values, sample_weight=weights)
        
        self.model = {"isotonic": model}
        self.method_used = "isotonic"
        logger.info("CTR модель IsotonicRegression обучена")
    
    def _fit_polyfit(
        self,
        positions: np.ndarray,
        ctr_values: np.ndarray,
        weights: np.ndarray
    ) -> None:
        """Fallback: polyfit degree=2."""
        poly = np.polyfit(positions, ctr_values, deg=2, w=weights)
        
        self.model = {"poly": poly}
        self.method_used = "polyfit"
        logger.info("CTR модель polyfit обучена")
    
    def _fit_default_curve(self) -> None:
        """Использует industry-average CTR из конфига."""
        self.model = {"default_curve": CONFIG.default_ctr_curve}
        self.method_used = "default"
        logger.info("CTR модель использует industry-average кривую")
    
    def _predict_from_default(self, positions: np.ndarray) -> np.ndarray:
        """Предсказание через интерполяцию industry-average кривой."""
        curve = self.model["default_curve"]
        
        # Создаём интерполятор
        pos_keys = np.array(sorted(curve.keys()), dtype=float)
        ctr_vals = np.array([curve[k] for k in pos_keys])
        
        # Линейная интерполяция
        ctr = np.interp(positions, pos_keys, ctr_vals)
        
        return ctr
