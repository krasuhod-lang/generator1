# SEO Traffic Forecaster

Микросервис для прогнозирования SEO трафика на основе исторических данных с использованием Prophet/SARIMA и моделей CTR.

## Назначение

Цель: повышение точности прогнозирования трафика (и, как следствие, лидов/выручки) при защите SEO-бюджетов перед руководством. Учёт сезонности и реальной кривой роста.

**Ключевые возможности:**
- Загрузка исторических данных из CSV/XLSX, Google Search Console API, Яндекс.Вебмастер API
- Препроцессинг: очистка NaN, дубликатов, детекция и сглаживание аномалий
- Прогноз спроса через Prophet (приоритет) или SARIMA/OLS trend (fallback)
- Модель CTR(позиция) на основе собственных данных проекта
- Расчёт прогноза трафика для трёх сценариев: Pessimistic, Baseline, Optimistic
- Экспорт результатов в CSV/XLSX с русскими заголовками
- CLI и REST API (FastAPI) для интеграции

## Установка

### Минимальные зависимости (обязательные)

```bash
cd forecaster_py
pip install -r requirements.txt
```

Это установит базовые зависимости: pandas, numpy, scikit-learn, statsmodels, openpyxl, fastapi, pytest.

### Опциональные зависимости (расширенная функциональность)

Для полной функциональности установите тяжёлые зависимости:

```bash
# Prophet (рекомендуется для лучшего прогнозирования)
pip install prophet==1.1.5

# Kats (улучшенная детекция аномалий, опционально, часто ломается на Python 3.11+)
pip install kats==0.2.0

# Google Search Console API (опционально)
pip install google-api-python-client==2.149.0 google-auth==2.35.0

# Визуализация для отладки (опционально)
pip install matplotlib plotly
```

**Важно:** Если Prophet/Kats/GSC не установлены, микросервис автоматически использует fallback на SARIMA/OLS и встроенные методы детекции аномалий.

## Запуск CLI

### Пример: полный прогноз из CSV

```bash
python -m forecaster_py.app.cli \
  --input data/historical.csv \
  --out results/forecast.xlsx \
  --query "ремонт квартир" \
  --horizon 12 \
  --from-pos 15 \
  --to-pos 3 \
  --scenario all
```

### Параметры CLI

- `--input <path>` — путь к CSV/XLSX с историческими данными (обязательно)
- `--out <path>` — путь к выходному файлу, расширение определяет формат (.csv или .xlsx)
- `--query <str>` — имя запроса (опционально, автоопределение)
- `--horizon <int>` — горизонт прогноза в месяцах (default: 12)
- `--from-pos <float>` — начальная позиция (обязательно)
- `--to-pos <float>` — целевая позиция (обязательно)
- `--scenario {pessimistic|baseline|optimistic|all}` — сценарий (default: all)
- `--ctr-data <path>` — путь к CSV с CTR данными (опционально, иначе industry-average)
- `--no-prophet` — отключить Prophet, использовать SARIMA/OLS
- `--include-confidence` — включить confidence интервалы в экспорт
- `--log-level {DEBUG|INFO|WARNING|ERROR}` — уровень логирования

### Быстрый пример

```bash
# Создание тестовых данных
python -c "
import pandas as pd, numpy as np
dates = pd.date_range('2023-01-01', periods=24, freq='MS')
df = pd.DataFrame({
    'date': dates,
    'query': 'ремонт квартир',
    'impressions': np.random.RandomState(0).randint(500, 2000, 24),
    'clicks': np.random.RandomState(1).randint(20, 200, 24),
    'position': np.random.RandomState(2).uniform(8, 18, 24)
})
df.to_csv('input.csv', index=False, encoding='utf-8-sig')
"

# Запуск прогноза
python -m forecaster_py.app.cli \
  --input input.csv \
  --out forecast.xlsx \
  --horizon 12 \
  --from-pos 15 \
  --to-pos 3
```

## Запуск через Docker

### Сборка образа

```bash
# Базовая сборка (без тяжёлых зависимостей)
docker build -t forecaster_py:latest .

# Сборка с Prophet/Kats/GSC (требует больше времени)
docker build --build-arg INSTALL_HEAVY=true -t forecaster_py:full .
```

### Запуск FastAPI сервера

```bash
docker run -p 8000:8000 forecaster_py:latest
```

Или через docker-compose (добавьте в корневой docker-compose.yml):

```yaml
forecaster:
  build:
    context: ./forecaster_py
    args:
      INSTALL_HEAVY: "false"
  ports:
    - "8001:8000"
  environment:
    - FORECASTER_INTERNAL_TOKEN=${FORECASTER_INTERNAL_TOKEN:-}
    - LOG_LEVEL=INFO
```

## REST API

### Endpoints

#### `GET /health`

Проверка статуса сервиса.

**Response:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "prophet_available": false,
  "kats_available": false
}
```

#### `POST /forecast`

Прогнозирование трафика.

**Headers:**
- `X-Internal-Token` (опционально, если задан `FORECASTER_INTERNAL_TOKEN`)

**Body (JSON):**
```json
{
  "historical": [
    {
      "date": "2023-01-01",
      "query": "ремонт квартир",
      "impressions": 1000,
      "clicks": 50,
      "position": 10.5
    }
  ],
  "options": {
    "query_name": "ремонт квартир",
    "horizon_months": 12,
    "from_position": 15.0,
    "to_position": 3.0,
    "scenarios": ["pessimistic", "baseline", "optimistic"],
    "use_prophet": true,
    "include_confidence": false
  }
}
```

**Response:**
```json
{
  "success": true,
  "query": "ремонт квартир",
  "horizon_months": 12,
  "demand_method": "sarima",
  "ctr_method": "isotonic",
  "forecast": {
    "baseline": [...]
  },
  "summary": {
    "baseline": {
      "total_traffic": 5000,
      "avg_position": 6.5,
      "avg_ctr": 0.045
    }
  }
}
```

#### `POST /forecast-csv`

Загрузка CSV файла и прогнозирование (multipart/form-data).

## Запуск тестов

```bash
cd forecaster_py
pytest
```

Или с подробным выводом:

```bash
pytest -v --tb=short
```

Тесты работают **без Prophet/Kats/GSC** — используются только базовые зависимости.

## Формат входных данных

### CSV/XLSX

**Обязательные колонки:**
- `date` — дата в формате YYYY-MM-DD или любом pandas-совместимом
- `query` — текст запроса
- `impressions` — количество показов
- `clicks` — количество кликов
- `position` — средняя позиция

**Пример:**
```csv
date,query,impressions,clicks,position
2023-01-01,ремонт квартир,1500,75,12.3
2023-02-01,ремонт квартир,1600,80,11.8
```

### CTR данные (опционально)

Если передаётся отдельный файл с `--ctr-data`:

**Обязательные колонки:**
- `position` — позиция (1-100)
- `impressions` — показы (вес для регрессии)
- `clicks` — клики

Или альтернативно: `position`, `ctr`, `weight`

## Формат выходных данных

### CSV

Единый файл со всеми сценариями, колонка `Сценарий` различает их.

### XLSX

Отдельный лист для каждого сценария: `Pessimistic`, `Baseline`, `Optimistic`.

**Колонки (на русском, согласно ТЗ):**
- `Месяц` — месяц прогноза (YYYY-MM)
- `Запрос` — имя запроса
- `Сценарий` — тип сценария (только в CSV)
- `Прогноз спроса` — прогнозируемые показы
- `Ожидаемая позиция` — целевая позиция в этом месяце
- `Расчетный CTR` — CTR для данной позиции
- `Прогноз трафика` — расчётный трафик (спрос × CTR)

Если `--include-confidence`, добавляются: `Спрос (нижн.)`, `Спрос (верхн.)`, `Трафик (нижн.)`, `Трафик (верхн.)`

## Архитектура

Модульная структура с разделением ответственности:

### Основные модули

- **config.py** — замороженная конфигурация (dataclass), без env переменных
- **connectors.py** — загрузка данных (CSV, XLSX, GSC, Яндекс.Вебмастер, Wordstat)
- **preprocessing.py** — очистка NaN/дубликатов, детекция аномалий (Kats или IQR fallback)
- **demand_model.py** — прогноз спроса (Prophet → SARIMA → OLS trend fallback)
- **ctr_model.py** — модель CTR(позиция) через IsotonicRegression или polyfit
- **scenarios.py** — генерация кривых позиций для трёх сценариев
- **traffic_calc.py** — комбинирование спроса × CTR × сценарий
- **exporter.py** — экспорт в CSV/XLSX с русскими заголовками
- **pipeline.py** — оркестрация полного пайплайна
- **cli.py** — CLI через argparse
- **main.py** — FastAPI REST API

### Graceful degradation

Все тяжёлые зависимости (Prophet, Kats, GSC) импортируются через `try/except` с fallback:

- **Prophet недоступен** → SARIMA (statsmodels)
- **SARIMA недоступен / короткий ряд** → OLS trend + сезонность
- **Kats недоступен** → IQR + rolling median
- **GSC API недоступен** → коннектор помечается unavailable, работа через CSV/XLSX

## Опциональные зависимости

### Prophet

Рекомендуется для высокой точности прогнозирования с автоматической декомпозицией тренда и сезонности.

**Установка:**
```bash
pip install prophet==1.1.5
```

### Kats (Facebook Time Series Library)

Улучшенная детекция аномалий через OutlierDetector. Опционально, часто ломается на Python 3.11+.

**Установка:**
```bash
pip install kats==0.2.0
```

Если не установлен — используется fallback на IQR + rolling median.

### Google Search Console API

Для загрузки исторических данных напрямую из GSC.

**Установка:**
```bash
pip install google-api-python-client google-auth google-auth-oauthlib google-auth-httplib2
```

**Использование:**
```python
from forecaster_py.app.connectors import GSCConnector

connector = GSCConnector("path/to/service-account.json")
df = connector.fetch_data(
    site_url="sc-domain:example.com",
    start_date="2023-01-01",
    end_date="2023-12-31",
    dimensions=["date", "query"]
)
```

## Лицензия

Внутренний инструмент для `krasuhod-lang/generator1`.

## Авторы

Создано как часть монорепозитория `generator1` для автоматизации SEO прогнозирования.
