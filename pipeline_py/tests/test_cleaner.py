"""Тесты Слоя 3 — очиститель HTML."""

from app.cleaner import clean_html

SAMPLE = """
<!doctype html>
<html>
  <head>
    <title>  Пример страницы  </title>
    <style>.x{color:red}</style>
    <script>var a = 1;</script>
  </head>
  <body>
    <nav>Меню сайта</nav>
    <header>Шапка</header>
    <article>
      <h1>Заголовок</h1>
      <p>Первый    абзац   текста.</p>
      <p>Второй абзац.</p>
      <!-- комментарий -->
    </article>
    <footer>Подвал сайта</footer>
  </body>
</html>
"""


def test_clean_extracts_title_and_text():
    res = clean_html(SAMPLE)
    assert res.title == "Пример страницы"
    assert "Заголовок" in res.text
    assert "Первый абзац текста." in res.text  # схлопнуты пробелы
    assert "Второй абзац." in res.text


def test_clean_removes_noise():
    res = clean_html(SAMPLE)
    for noise in ("Меню сайта", "Шапка", "Подвал сайта", "var a", "color:red", "комментарий"):
        assert noise not in res.text


def test_clean_empty():
    assert clean_html("").is_empty
    assert clean_html("   ").is_empty
