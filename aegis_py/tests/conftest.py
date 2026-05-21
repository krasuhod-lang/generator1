"""Conftest для aegis_py tests — добавляет корень репозитория в sys.path,
чтобы `from aegis_py.app...` работало без установки пакета."""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
