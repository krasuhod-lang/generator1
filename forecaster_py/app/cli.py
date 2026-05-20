"""CLI для запуска пайплайна прогнозирования.

Использование:
    python -m forecaster_py.app.cli --input data.csv --out forecast.xlsx
"""

import argparse
import logging
import sys
from pathlib import Path

from .pipeline import run_pipeline
from .scenarios import ScenarioType

logger = logging.getLogger("forecaster_py.cli")


def main():
    """Точка входа CLI."""
    parser = argparse.ArgumentParser(
        description="SEO Traffic Forecaster - прогнозирование трафика на основе исторических данных",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    
    parser.add_argument(
        "--input",
        required=True,
        type=str,
        help="Путь к входному файлу (CSV или XLSX) с историческими данными"
    )
    
    parser.add_argument(
        "--out",
        required=True,
        type=str,
        help="Путь к выходному файлу (расширение определяет формат: .csv или .xlsx)"
    )
    
    parser.add_argument(
        "--query",
        type=str,
        default=None,
        help="Имя запроса (опционально, автоопределение если в данных один запрос)"
    )
    
    parser.add_argument(
        "--horizon",
        type=int,
        default=12,
        help="Горизонт прогноза в месяцах (default: 12)"
    )
    
    parser.add_argument(
        "--from-pos",
        type=float,
        required=True,
        help="Начальная позиция (например, 15)"
    )
    
    parser.add_argument(
        "--to-pos",
        type=float,
        required=True,
        help="Целевая позиция (например, 3)"
    )
    
    parser.add_argument(
        "--scenario",
        type=str,
        choices=["pessimistic", "baseline", "optimistic", "all"],
        default="all",
        help="Сценарий для расчёта (default: all - все три сценария)"
    )
    
    parser.add_argument(
        "--ctr-data",
        type=str,
        default=None,
        help="Путь к CSV с CTR данными (position,impressions,clicks). "
             "Если не указано, используются исторические данные или industry-average"
    )
    
    parser.add_argument(
        "--no-prophet",
        action="store_true",
        help="Отключить Prophet, использовать только SARIMA/OLS"
    )
    
    parser.add_argument(
        "--include-confidence",
        action="store_true",
        help="Включить confidence интервалы в экспорт"
    )
    
    parser.add_argument(
        "--log-level",
        type=str,
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        default="INFO",
        help="Уровень логирования (default: INFO)"
    )
    
    args = parser.parse_args()
    
    # Настройка логирования
    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S"
    )
    
    # Определяем сценарии
    if args.scenario == "all":
        scenarios = ["pessimistic", "baseline", "optimistic"]
    else:
        scenarios = [args.scenario]
    
    # Проверка входного файла
    input_path = Path(args.input)
    if not input_path.exists():
        logger.error(f"Входной файл не найден: {args.input}")
        sys.exit(1)
    
    # Проверка выходной директории
    output_path = Path(args.out)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    try:
        # Запуск пайплайна
        result = run_pipeline(
            input_file=input_path,
            output_file=output_path,
            query_name=args.query,
            horizon_months=args.horizon,
            from_position=args.from_pos,
            to_position=args.to_pos,
            scenarios=scenarios,
            ctr_data_file=args.ctr_data,
            use_prophet=not args.no_prophet,
            include_confidence=args.include_confidence
        )
        
        logger.info("Готово! Результаты сохранены в: %s", result["output_file"])
        sys.exit(0)
        
    except Exception as e:
        logger.exception(f"Ошибка выполнения пайплайна: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
