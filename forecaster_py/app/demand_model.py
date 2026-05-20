"""Модель прогнозирования спроса (demand) через Prophet или SARIMA.

Graceful handling: Prophet → SARIMA → OLS trend fallback.
"""

import logging
from typing import Optional, Tuple

import numpy as np
import pandas as pd
from statsmodels.tsa.statespace.sarimax import SARIMAX

from .config import CONFIG

logger = logging.getLogger("forecaster_py.demand_model")

# Graceful import Prophet
PROPHET_AVAILABLE = False
try:
    from prophet import Prophet
    PROPHET_AVAILABLE = True
    logger.info("Prophet доступен для прогнозирования")
except ImportError:
    logger.info("Prophet недоступен, будет использован SARIMA fallback")


class DemandForecaster:
    """Прогнозирование спроса на основе исторических данных.
    
    Приоритет: Prophet > SARIMA > OLS trend.
    """
    
    def __init__(self, use_prophet: bool = True):
        """
        Args:
            use_prophet: пытаться использовать Prophet (если доступен)
        """
        self.use_prophet = use_prophet and PROPHET_AVAILABLE
        self.model = None
        self.method_used = None
    
    def fit(self, df: pd.DataFrame, value_column: str = "impressions") -> None:
        """Обучает модель на исторических данных.
        
        Args:
            df: DataFrame с колонками 'date' и value_column
            value_column: имя колонки для прогнозирования
        """
        if df.empty or len(df) < CONFIG.min_history_points:
            raise ValueError(f"Недостаточно данных: нужно минимум {CONFIG.min_history_points}")
        
        if self.use_prophet:
            try:
                self._fit_prophet(df, value_column)
                return
            except Exception as e:
                logger.warning(f"Prophet обучение провалилось: {e}, пробуем SARIMA")
        
        # Fallback на SARIMA
        try:
            self._fit_sarima(df, value_column)
            return
        except Exception as e:
            logger.warning(f"SARIMA обучение провалилось: {e}, используем OLS trend")
        
        # Fallback на OLS trend
        self._fit_ols_trend(df, value_column)
    
    def predict(self, periods: int) -> pd.DataFrame:
        """Прогнозирует на N периодов вперёд.
        
        Args:
            periods: количество периодов для прогноза
        
        Returns:
            DataFrame с колонками: date, yhat, yhat_lower, yhat_upper
        """
        if self.model is None:
            raise ValueError("Модель не обучена, вызовите fit() сначала")
        
        if self.method_used == "prophet":
            return self._predict_prophet(periods)
        elif self.method_used == "sarima":
            return self._predict_sarima(periods)
        elif self.method_used == "ols_trend":
            return self._predict_ols_trend(periods)
        else:
            raise ValueError(f"Неизвестный метод: {self.method_used}")
    
    def _fit_prophet(self, df: pd.DataFrame, value_column: str) -> None:
        """Обучает Prophet модель."""
        prophet_df = pd.DataFrame({
            "ds": df["date"],
            "y": df[value_column]
        })
        
        model = Prophet(
            interval_width=CONFIG.prophet_interval_width,
            yearly_seasonality=True,
            weekly_seasonality=False,
            daily_seasonality=False
        )
        model.fit(prophet_df)
        
        self.model = {"prophet": model}
        self.method_used = "prophet"
        logger.info("Модель Prophet обучена")
    
    def _predict_prophet(self, periods: int) -> pd.DataFrame:
        """Прогноз через Prophet."""
        future = self.model["prophet"].make_future_dataframe(periods=periods, freq="MS")
        forecast = self.model["prophet"].predict(future)
        
        # Берём только будущие периоды
        forecast = forecast.tail(periods)
        
        return pd.DataFrame({
            "date": forecast["ds"],
            "yhat": forecast["yhat"],
            "yhat_lower": forecast["yhat_lower"],
            "yhat_upper": forecast["yhat_upper"]
        }).reset_index(drop=True)
    
    def _fit_sarima(self, df: pd.DataFrame, value_column: str) -> None:
        """Обучает SARIMA модель."""
        ts = df.set_index("date")[value_column]
        
        model = SARIMAX(
            ts,
            order=CONFIG.sarima_order,
            seasonal_order=CONFIG.sarima_seasonal_order,
            enforce_stationarity=False,
            enforce_invertibility=False
        )
        fitted = model.fit(disp=False)
        
        self.model = {"sarima": fitted, "ts": ts}
        self.method_used = "sarima"
        logger.info("Модель SARIMA обучена")
    
    def _predict_sarima(self, periods: int) -> pd.DataFrame:
        """Прогноз через SARIMA."""
        fitted = self.model["sarima"]
        forecast = fitted.get_forecast(steps=periods)
        
        mean = forecast.predicted_mean
        conf_int = forecast.conf_int(alpha=1 - CONFIG.prophet_interval_width)
        
        # Генерируем будущие даты
        last_date = self.model["ts"].index[-1]
        future_dates = pd.date_range(start=last_date, periods=periods + 1, freq="MS")[1:]
        
        return pd.DataFrame({
            "date": future_dates,
            "yhat": mean.values,
            "yhat_lower": conf_int.iloc[:, 0].values,
            "yhat_upper": conf_int.iloc[:, 1].values
        }).reset_index(drop=True)
    
    def _fit_ols_trend(self, df: pd.DataFrame, value_column: str) -> None:
        """Fallback: OLS trend + сезонность через group-by-month."""
        df = df.copy()
        df["time_idx"] = np.arange(len(df))
        df["month"] = pd.to_datetime(df["date"]).dt.month
        
        # OLS тренд
        X = df["time_idx"].values
        y = df[value_column].values
        
        # Простая линейная регрессия
        A = np.vstack([X, np.ones(len(X))]).T
        slope, intercept = np.linalg.lstsq(A, y, rcond=None)[0]
        
        # Сезонность: отклонение по месяцам
        df["trend"] = slope * df["time_idx"] + intercept
        df["residual"] = df[value_column] - df["trend"]
        
        seasonal = df.groupby("month")["residual"].mean().to_dict()
        
        # Оценка стандартного отклонения для CI
        std = df["residual"].std()
        
        self.model = {
            "slope": slope,
            "intercept": intercept,
            "seasonal": seasonal,
            "std": std,
            "last_idx": len(df) - 1,
            "last_date": df["date"].iloc[-1]
        }
        self.method_used = "ols_trend"
        logger.info("Модель OLS trend + сезонность обучена")
    
    def _predict_ols_trend(self, periods: int) -> pd.DataFrame:
        """Прогноз через OLS trend."""
        slope = self.model["slope"]
        intercept = self.model["intercept"]
        seasonal = self.model["seasonal"]
        std = self.model["std"]
        last_idx = self.model["last_idx"]
        last_date = self.model["last_date"]
        
        # Будущие индексы
        future_idx = np.arange(last_idx + 1, last_idx + 1 + periods)
        
        # Тренд
        trend = slope * future_idx + intercept
        
        # Будущие даты
        future_dates = pd.date_range(start=last_date, periods=periods + 1, freq="MS")[1:]
        future_months = future_dates.month
        
        # Добавляем сезонность
        seasonal_component = np.array([seasonal.get(m, 0) for m in future_months])
        yhat = trend + seasonal_component
        
        # CI
        z_score = 1.28  # ~80% CI
        yhat_lower = yhat - z_score * std
        yhat_upper = yhat + z_score * std
        
        return pd.DataFrame({
            "date": future_dates,
            "yhat": yhat,
            "yhat_lower": yhat_lower,
            "yhat_upper": yhat_upper
        }).reset_index(drop=True)
