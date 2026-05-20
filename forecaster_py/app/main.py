"""FastAPI entrypoint для SEO Traffic Forecaster microservice.

POST /forecast
    body: JSON или multipart CSV с историческими данными
    auth: header X-Internal-Token (опционально)

GET /health
    public healthcheck
"""

import logging
import os
import tempfile
from io import StringIO
from typing import Optional

import pandas as pd
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile, status
from pydantic import BaseModel, Field

from .config import CONFIG
from .ctr_model import CTRModel
from .demand_model import DemandForecaster
from .preprocessing import clean_data, detect_and_smooth_anomalies, resample_to_frequency
from .scenarios import generate_scenarios
from .traffic_calc import aggregate_traffic_summary, calculate_multi_scenario_forecast

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("forecaster_py")

APP_VERSION = "1.0.0"

app = FastAPI(
    title="SEO Traffic Forecaster",
    version=APP_VERSION,
    description="Прогнозирование SEO трафика на основе Prophet/SARIMA + CTR модели",
)


# ─── Auth ──────────────────────────────────────────────────────────────────────
def verify_internal_token(
    x_internal_token: Optional[str] = Header(default=None, alias="X-Internal-Token"),
) -> None:
    """Проверяет заголовок X-Internal-Token.
    
    Если FORECASTER_INTERNAL_TOKEN не задан в env — auth выключен.
    """
    expected = os.environ.get("FORECASTER_INTERNAL_TOKEN", "").strip()
    if not expected:
        return
    if not x_internal_token or x_internal_token.strip() != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Internal-Token",
        )


# ─── Schemas ───────────────────────────────────────────────────────────────────
class HistoricalDataPoint(BaseModel):
    date: str
    query: str
    impressions: float
    clicks: float
    position: float


class ForecastOptions(BaseModel):
    query_name: Optional[str] = None
    horizon_months: int = Field(default=12, ge=1, le=60)
    from_position: float = Field(..., ge=1, le=100)
    to_position: float = Field(..., ge=1, le=100)
    scenarios: list[str] = Field(default=["pessimistic", "baseline", "optimistic"])
    use_prophet: bool = True
    include_confidence: bool = False


class ForecastRequest(BaseModel):
    historical: list[HistoricalDataPoint]
    options: ForecastOptions


class ForecastResponse(BaseModel):
    success: bool
    query: str
    horizon_months: int
    demand_method: str
    ctr_method: str
    forecast: dict
    summary: dict


# ─── Endpoints ─────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    """Healthcheck endpoint."""
    return {
        "status": "ok",
        "version": APP_VERSION,
        "prophet_available": False,  # Будет обновлено при импорте
        "kats_available": False
    }


@app.post("/forecast", response_model=ForecastResponse, dependencies=[Depends(verify_internal_token)])
def forecast_traffic(request: ForecastRequest):
    """Прогнозирует SEO трафик на основе исторических данных.
    
    Args:
        request: JSON с историческими данными и опциями
    
    Returns:
        Прогноз трафика по сценариям
    """
    try:
        # Конвертируем в DataFrame
        historical_df = pd.DataFrame([
            {
                "date": pd.to_datetime(point.date),
                "query": point.query,
                "impressions": point.impressions,
                "clicks": point.clicks,
                "position": point.position
            }
            for point in request.historical
        ])
        
        opts = request.options
        
        # Определяем query
        query_name = opts.query_name or _detect_query_name(historical_df)
        
        # Препроцессинг
        cleaned = clean_data(historical_df, value_column="impressions")
        smoothed = detect_and_smooth_anomalies(cleaned, value_column="impressions")
        monthly = resample_to_frequency(smoothed, freq="MS", agg="sum")
        
        # Demand model
        demand_forecaster = DemandForecaster(use_prophet=opts.use_prophet)
        demand_forecaster.fit(monthly, value_column="impressions")
        demand_forecast = demand_forecaster.predict(periods=opts.horizon_months)
        
        # CTR model
        ctr_model = CTRModel()
        try:
            ctr_model.fit(cleaned)
        except Exception:
            logger.warning("Fallback на industry-average CTR")
            ctr_model.fit(pd.DataFrame({
                "position": [1.0],
                "impressions": [1],
                "clicks": [1]
            }))
        
        # Сценарии
        position_curves = generate_scenarios(
            opts.from_position,
            opts.to_position,
            opts.horizon_months,
            shape="ease_out"
        )
        
        # Фильтруем сценарии
        position_curves = {k: v for k, v in position_curves.items() if k in opts.scenarios}
        
        # Расчёт трафика
        traffic_forecasts = calculate_multi_scenario_forecast(
            demand_forecast,
            position_curves,
            ctr_model,
            query_name
        )
        
        # Сводка
        summary = aggregate_traffic_summary(traffic_forecasts)
        
        # Конвертируем forecasts в JSON-serializable формат
        forecast_json = {}
        for scenario, df in traffic_forecasts.items():
            forecast_json[scenario] = df.to_dict(orient="records")
        
        return ForecastResponse(
            success=True,
            query=query_name,
            horizon_months=opts.horizon_months,
            demand_method=demand_forecaster.method_used,
            ctr_method=ctr_model.method_used,
            forecast=forecast_json,
            summary=summary
        )
        
    except Exception as e:
        logger.exception(f"Ошибка прогнозирования: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@app.post("/forecast-csv", dependencies=[Depends(verify_internal_token)])
async def forecast_traffic_csv(
    file: UploadFile = File(...),
    horizon_months: int = Form(12),
    from_position: float = Form(...),
    to_position: float = Form(...),
    scenarios: str = Form("pessimistic,baseline,optimistic"),
    use_prophet: bool = Form(True)
):
    """Прогнозирует трафик из загруженного CSV файла.
    
    Args:
        file: CSV файл с данными
        horizon_months: горизонт прогноза
        from_position: начальная позиция
        to_position: целевая позиция
        scenarios: сценарии через запятую
        use_prophet: использовать Prophet
    
    Returns:
        JSON с прогнозом
    """
    try:
        # Читаем CSV
        contents = await file.read()
        df = pd.read_csv(StringIO(contents.decode("utf-8")))
        
        # Конвертируем в HistoricalDataPoint
        historical = []
        for _, row in df.iterrows():
            historical.append(HistoricalDataPoint(
                date=str(row["date"]),
                query=str(row.get("query", "unknown")),
                impressions=float(row["impressions"]),
                clicks=float(row["clicks"]),
                position=float(row["position"])
            ))
        
        # Создаём запрос
        scenario_list = [s.strip() for s in scenarios.split(",")]
        request = ForecastRequest(
            historical=historical,
            options=ForecastOptions(
                horizon_months=horizon_months,
                from_position=from_position,
                to_position=to_position,
                scenarios=scenario_list,
                use_prophet=use_prophet
            )
        )
        
        return forecast_traffic(request)
        
    except Exception as e:
        logger.exception(f"Ошибка обработки CSV: {e}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Ошибка парсинга CSV: {str(e)}"
        )


def _detect_query_name(df: pd.DataFrame) -> str:
    """Автоопределение имени запроса."""
    if "query" in df.columns:
        unique = df["query"].dropna().unique()
        if len(unique) >= 1:
            return str(unique[0])
    return "unknown_query"


# Обновляем healthcheck с реальными значениями
from .demand_model import PROPHET_AVAILABLE
from .preprocessing import KATS_AVAILABLE

@app.get("/health")
def health():
    """Healthcheck endpoint."""
    return {
        "status": "ok",
        "version": APP_VERSION,
        "prophet_available": PROPHET_AVAILABLE,
        "kats_available": KATS_AVAILABLE
    }
