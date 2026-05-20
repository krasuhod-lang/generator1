"""Тесты CTR модели."""

import numpy as np
import pandas as pd
import pytest

from forecaster_py.app.ctr_model import CTRModel


def test_ctr_model_isotonic_fit(ctr_training_data):
    """Проверяет обучение через IsotonicRegression."""
    model = CTRModel()
    model.fit(ctr_training_data)
    
    assert model.method_used == "isotonic"
    assert model.model is not None


def test_ctr_model_predict_single(ctr_training_data):
    """Проверяет предсказание для одной позиции."""
    model = CTRModel()
    model.fit(ctr_training_data)
    
    ctr_pos_1 = model.predict_ctr(1.0)
    ctr_pos_10 = model.predict_ctr(10.0)
    
    assert isinstance(ctr_pos_1, float)
    assert isinstance(ctr_pos_10, float)
    # CTR должен убывать с позицией
    assert ctr_pos_1 > ctr_pos_10


def test_ctr_model_predict_array(ctr_training_data):
    """Проверяет предсказание для массива позиций."""
    model = CTRModel()
    model.fit(ctr_training_data)
    
    positions = np.array([1, 3, 5, 7, 10])
    ctr_values = model.predict_ctr(positions)
    
    assert isinstance(ctr_values, np.ndarray)
    assert len(ctr_values) == len(positions)
    # CTR должен убывать
    assert all(ctr_values[i] >= ctr_values[i+1] for i in range(len(ctr_values)-1))


def test_ctr_model_clips_range(ctr_training_data):
    """Проверяет клипинг за пределами диапазона."""
    model = CTRModel()
    model.fit(ctr_training_data)
    
    ctr_0 = model.predict_ctr(0.5)  # Ниже min
    ctr_100 = model.predict_ctr(100.0)  # Выше max
    
    assert 0.0 <= ctr_0 <= 1.0
    assert 0.0 <= ctr_100 <= 1.0


def test_ctr_model_default_fallback():
    """Проверяет fallback на industry-average при недостатке данных."""
    # Слишком мало данных
    small_df = pd.DataFrame({
        "position": [5.0],
        "impressions": [100],
        "clicks": [5]
    })
    
    model = CTRModel()
    model.fit(small_df)
    
    assert model.method_used == "default"
    
    ctr = model.predict_ctr(1.0)
    assert ctr > 0
