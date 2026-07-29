# ТЗ: Исправление скачка трафика в первый месяц прогнозатора

## Проблема
При вводе небольшого текущего трафика (например, `curTraffic = 100`) и загрузке большого семантического ядра (например, суммарный Wordstat `L0 = 1 000 000`) в единой модели прогноза (`unifiedForecast.js`) происходит нереалистичный скачок трафика в первый же месяц прогноза (например, со 100 до 4500 визитов). 

График должен показывать плавный рост от стартового значения, но вместо этого происходит резкий "прыжок" на `M1`.

## Причина
В файле `backend/src/services/forecaster/unifiedForecast.js` формула первого месяца (при `t=1`) рассчитывает ядро так:
```javascript
const captureCore = sovStart + (sovMax - sovStart) / (1 + Math.exp(-k * (t - t0)));
const coreRaw = (L0 + t * T) * (1 + r * t) * cYield * capture * calib;
```

**Где ломается логика:**
Логистическая кривая (`1 / (1 + exp(-k*(t-t0)))`) при `t=1` и `t0=6` даёт значение `~0.15`.
Это значит, что уже в **первый месяц** модель закладывает **15% от всего потенциала роста** (разницы между `sovMax` и `sovStart`).
При огромном ядре (большой `L0`) и малом старте (`sovStart ≈ 0`) эти 15% превращаются в огромный абсолютный прирост (например, +4000 визитов за один месяц).

Калибровка (`calib`) выравнивает точку `t=0` к `curTraffic`, но она **константна** и не защищает от резкого прироста самого множителя `capture` при `t=1`.

## Решение: Сглаживание старта (Ramp-up)

Нам нужно принудительно "привязать" кривую к стартовому значению на первых месяцах, чтобы рост начинался плавно (ramp-up), а не прыгал сразу на 15% от максимума.

### Задача 1: Внедрение ramp-up множителя в `unifiedForecast.js`
В файле `backend/src/services/forecaster/unifiedForecast.js`, внутри цикла `for (let t = 1; t <= horizon; t++)`, перед вычислением `coreRaw`, необходимо добавить сглаживающий множитель для `capture`.

**Логика:**
На `t=0` (старт) capture должен быть равен `sovStart`.
На `t=1` мы делаем плавный переход, а не берем сырое значение логистики.

**Изменения в коде (`backend/src/services/forecaster/unifiedForecast.js`):**

```javascript
// Было (примерно 276 строка):
const captureCore = sovStart + (sovMax - sovStart) / (1 + Math.exp(-k * (t - t0)));
const captureBlend = (captureCore + sovNew * (r * t)) / (1 + r * t);
const capture = Math.max(captureBlend, prevCapture);
prevCapture = capture;

// Стало:
const rawLogistic = 1 / (1 + Math.exp(-k * (t - t0)));
// На t=1 логистика уже дает ~0.15 (15% пути). Нам нужно сгладить старт.
// Вводим ramp-up множитель, который плавно отпускает кривую с 0 до 1 за первые 3-4 месяца.
// Например, t=1: 0.25, t=2: 0.5, t=3: 0.75, t>=4: 1.0
const rampUpMonths = 4;
const rampFactor = Math.min(1, t / rampUpMonths);

const captureCore = sovStart + (sovMax - sovStart) * rawLogistic * rampFactor;
const captureBlend = (captureCore + sovNew * (r * t)) / (1 + r * t);
const capture = Math.max(captureBlend, prevCapture);
prevCapture = capture;
```

### Задача 2: Ограничение максимального прироста (Max Uplift Cap)
В старой модели (`trafficModel.js`) была защита `maxUplift` (например, не более x3 за год). В `unifiedForecast.js` она не применяется к самому трафику, из-за чего возможны скачки x45.

Необходимо добавить жесткий `cap` на прирост `capture` или итогового `value` относительно старта, особенно в первые месяцы.

**Изменения в коде (`backend/src/services/forecaster/unifiedForecast.js`):**
После вычисления `coreRaw`:

```javascript
// Было (строка 286):
const coreRaw = Math.max(0, (L0 + t * T)) * (1 + r * t) * cYield * capture * calib;
const core = Math.max(coreRaw, startCore);

// Стало:
let coreRaw = Math.max(0, (L0 + t * T)) * (1 + r * t) * cYield * capture * calib;

// ЖЕСТКИЙ CAP: Трафик не может расти быстрее, чем на 50% в месяц (или +X визитов) от предыдущего месяца.
// Защита от "прыжка" в M1: максимум +30% к старту или +500 визитов (что больше), чтобы новые сайты тоже росли.
if (curTraffic > 0) {
  const maxAllowedMultiplier = 1 + (0.4 * t); // t=1: x1.4, t=2: x1.8, t=3: x2.2...
  const absoluteMinGrowth = 300 * t; // разрешаем вырасти на 300 визитов в месяц даже маленьким сайтам
  const capValue = Math.max(curTraffic * maxAllowedMultiplier, curTraffic + absoluteMinGrowth);
  
  if (coreRaw > capValue) {
    coreRaw = capValue;
    // Корректируем capture обратным счетом для прозрачности отчета
    capture = coreRaw / (Math.max(1, (L0 + t * T)) * (1 + r * t) * cYield * calib);
    prevCapture = capture; // обновляем prevCapture, чтобы следующий месяц опирался на обрезанное значение
  }
}

const core = Math.max(coreRaw, startCore);
```

### Задача 3: Перегенерация отчетов (Миграция / Скрипт)
Поскольку исправленная логика меняет саму математику `unifiedForecast`, уже сгенерированные отчеты в БД (`forecaster_tasks`) останутся со старыми скачками, так как результаты сохранены в JSON-полях.

Для применения фикса к **уже сгенерированным отчетам** необходимо:
1. Создать скрипт-утилиту (например, `backend/scripts/fix-forecast-jumps.js`).
2. Скрипт должен сделать `SELECT id, options, monthly_series, forecast, target_url, keysso_signals ... FROM forecaster_tasks WHERE status = 'completed'`.
3. Для каждой задачи вызвать заново `buildUnifiedForecast` (и `buildSovForecast`, так как он зависит от unified) с уже существующими `monthly_series`.
4. Обновить поля `unified_forecast` и `sov_forecast` в БД.

```javascript
// Примерный скелет скрипта backend/scripts/fix-forecast-jumps.js
const db = require('../src/db');
const { buildUnifiedForecast } = require('../src/services/forecaster/unifiedForecast');
const { buildSovForecast } = require('../src/services/forecaster/sovForecast');
const { getForecasterConfig } = require('../src/services/forecaster/config');

async function run() {
  const { rows } = await db.query(`SELECT * FROM forecaster_tasks WHERE status = 'completed'`);
  const cfg = getForecasterConfig();
  
  for (const task of rows) {
    try {
      const options = task.options || {};
      const currentTraffic = Number(options.current_traffic_per_month) || 0;
      const seriesData = task.monthly_series || { monthly: [] };
      const forecast = task.forecast || { points: [] };
      // ... извлечь commPercent, serpElements, crFinal из существующих данных ...
      
      const newUnified = buildUnifiedForecast({
        monthly: seriesData.monthly,
        forecastPoints: forecast.points,
        options,
        currentTrafficPerMonth: currentTraffic,
        // ...
        cfg
      });
      
      // Аналогично пересчитать sovForecast
      
      await db.query(
        `UPDATE forecaster_tasks SET unified_forecast = $1, sov_forecast = $2 WHERE id = $3`,
        [JSON.stringify(newUnified), JSON.stringify(newSov), task.id]
      );
      console.log(`Task ${task.id} updated.`);
    } catch (e) {
      console.error(`Error on task ${task.id}:`, e);
    }
  }
}
run().then(() => process.exit(0));
```

**Итог для Copilot:**
1. Добавь `rampFactor` в S-кривую в `unifiedForecast.js`.
2. Добавь жесткий cap на `coreRaw` (не более x1.4 от старта в первый месяц).
3. Напиши и запусти скрипт `fix-forecast-jumps.js` для обновления старых отчетов в БД.
