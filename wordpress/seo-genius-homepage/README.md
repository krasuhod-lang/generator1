# SEO Genius Homepage — WordPress package

Это отдельная маркетинговая тема для публичной главной страницы SEO Genius. Она содержит premium landing с SEO-заголовками, блоками платформы, workflow, лимитами, FAQ, CTA, JSON-LD `SoftwareApplication` и social metadata.

Тема не содержит authenticated application, database logic, AI calls, user data или секретов. Рабочий интерфейс после входа остаётся отдельной Vue SPA и не входит в этот пакет.

## Установка

1. Соберите архив каталога `seo-genius-homepage` и загрузите его в WordPress через **Внешний вид → Темы → Добавить новую → Загрузить тему**.
2. Активируйте тему и назначьте нужную страницу статической главной страницей в **Настройки → Чтение**.
3. Проверьте, что `/login` и `/register` ведут на домен Vue-приложения. По умолчанию тема использует текущий домен и пути `/login` и `/register`.
4. Если marketing WordPress и application находятся на разных доменах, задайте URL приложения через `wp-config.php` до активации темы:

```php
define('SEO_GENIUS_APP_URL', 'https://app.example.com');
define('SEO_GENIUS_LOGIN_URL', 'https://app.example.com/login');
define('SEO_GENIUS_REGISTER_URL', 'https://app.example.com/register');
```

Значения выше являются примерами и не должны заменяться реальными секретами. URL можно настроить также после установки небольшим site-specific plugin.

## SEO-проверка перед публикацией

Замените `example.com` только на реальный production-домен в SEO-инструментах, проверьте canonical/OG image через выбранный SEO plugin, создайте XML sitemap и отправьте публичную главную страницу в Google Search Console и Яндекс Вебмастер. Сама тема не добавляет выдуманные цифры, отзывы или обещания гарантированного места в выдаче.

## Важно

Не удаляйте и не переносите этот пакет в каталог Vue-приложения на сервере вместо штатного frontend build. WordPress-тема и authenticated SPA — два отдельных слоя. Для установки в WordPress нужен доступ администратора WordPress или файловый доступ к теме; пароли и токены в репозиторий добавлять нельзя.
