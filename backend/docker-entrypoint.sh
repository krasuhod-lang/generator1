#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# SEO Genius — Docker Entrypoint
#
# Диагностика прокси-конфигурации при старте контейнера.
# Помогает быстро найти проблему, если GEMINI_PROXY_URL не задан или не работает.
# ═══════════════════════════════════════════════════════════════════════════

echo "═══════════════════════════════════════════════════════════════"
echo " SEO Genius — Proxy Diagnostics"
echo "═══════════════════════════════════════════════════════════════"

# ── Проверяем переменные прокси ──────────────────────────────────────────

PROXY_FOUND=0

check_proxy_var() {
  local suffix="$1"
  local var_name="GEMINI_PROXY_URL${suffix}"
  eval "local val=\${$var_name:-}"

  if [ -n "$val" ]; then
    # Маскируем пароль для безопасного вывода
    local masked
    masked=$(echo "$val" | sed 's/:[^:@]*@/:***@/g')
    echo "  ✅ ${var_name} = ${masked}"
    PROXY_FOUND=1
  fi

  # Проверяем компоненты (HOST/PORT/USER/PASS)
  local host_var="GEMINI_PROXY_HOST${suffix}"
  local port_var="GEMINI_PROXY_PORT${suffix}"
  local user_var="GEMINI_PROXY_USER${suffix}"
  local pass_var="GEMINI_PROXY_PASS${suffix}"

  eval "local host=\${$host_var:-}"
  eval "local port=\${$port_var:-}"
  eval "local user=\${$user_var:-}"
  eval "local pass=\${$pass_var:-}"

  if [ -n "$host" ] || [ -n "$port" ]; then
    echo "  ✅ ${host_var}=${host:-⚠пусто} ${port_var}=${port:-⚠пусто} USER=${user:+✓} PASS=${pass:+✓}"
    PROXY_FOUND=1
  fi
}

check_proxy_var ""
check_proxy_var "_2"
check_proxy_var "_3"
check_proxy_var "_4"
check_proxy_var "_5"

if [ "$PROXY_FOUND" -eq 0 ]; then
  echo ""
  echo "  ⚠ Переменные GEMINI_PROXY_* не заданы в окружении."
  echo "  ℹ Будет использован встроенный прокси (fallback)."
  echo ""
  echo "  Чтобы задать свой прокси, добавьте в .env файл:"
  echo ""
  echo "    # Вариант 1 — полная строка:"
  echo '    GEMINI_PROXY_URL="http://login:password@ip:port"'
  echo ""
  echo "    # Вариант 2 — отдельные компоненты (безопаснее при спец.символах):"
  echo "    GEMINI_PROXY_HOST=ip"
  echo "    GEMINI_PROXY_PORT=port"
  echo "    GEMINI_PROXY_USER=your_login"
  echo "    GEMINI_PROXY_PASS=your_password"
  echo ""
  echo "  ⚠ Важно: если в пароле есть спецсимволы (#, \$, @, и т.д.),"
  echo '    оберните значение в двойные кавычки в .env файле.'
  echo ""
fi

# ── Проверяем GEMINI_API_KEY ──────────────────────────────────────────────

if [ -n "$GEMINI_API_KEY" ]; then
  echo "  ✅ GEMINI_API_KEY = задан (${#GEMINI_API_KEY} символов)"
else
  echo "  ❌ GEMINI_API_KEY не задан!"
fi

echo "═══════════════════════════════════════════════════════════════"

# ── Запускаем основной процесс ────────────────────────────────────────────
exec "$@"
