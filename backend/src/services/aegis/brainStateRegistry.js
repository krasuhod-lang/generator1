'use strict';

/**
 * aegis/brainStateRegistry — реестр «состояния мозга» A.E.G.I.S.
 *
 * Каждая статья, прошедшая через DSPy MIPROv2, обновляет файл
 * brain_state/compiled_writer.yaml (и compiled_critic.yaml). Этот
 * реестр читает их и отдаёт остальным сервисам.
 *
 * Файлы хранятся в репозитории и коммитятся ботом при успешном
 * retrain (см. .github/workflows/aegis-dspy-retrain.yml).
 *
 * Формат yaml (минимальный собственный парсер — не тащим js-yaml deps):
 *
 *   version: 1
 *   compiled_at: 2026-05-21T02:00:00Z
 *   mean_spq_before: 78.4
 *   mean_spq_after: 83.1
 *   model: gemini-3.5-flash
 *   writer:
 *     system_prompt: |
 *       ...
 *     few_shot: []
 *
 * Хранение plain-text → возможен git diff и review.
 */

const fs   = require('fs');
const path = require('path');
const { getAegisFlags } = require('./featureFlags');

/**
 * _parseSimpleYaml — мини-парсер ПЛОСКОГО подмножества YAML:
 *   key: value
 *   key:
 *     nested: value
 *   key: |
 *     multi-line
 *     text
 *
 * Не поддерживает массивы со сложными объектами, anchor'ы, теги.
 * Достаточно для нашего формата compiled_writer.yaml.
 *
 * @param {string} text
 * @returns {object}
 */
function _parseSimpleYaml(text) {
  if (!text || typeof text !== 'string') return {};
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const root = {};
  const stack = [{ obj: root, indent: -1 }];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { i += 1; continue; }
    const m = line.match(/^(\s*)([\w.-]+):\s*(.*)$/);
    if (!m) { i += 1; continue; }
    const indent = m[1].length;
    const key    = m[2];
    let value    = m[3];

    // Раскрываем стек до текущего уровня вложенности.
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].obj;

    if (value === '|') {
      // Многострочный блок: собираем строки с большим indent.
      const blockLines = [];
      i += 1;
      const baseIndent = (lines[i] && lines[i].match(/^(\s*)/)[1].length) || (indent + 2);
      while (i < lines.length) {
        const ln = lines[i];
        if (!ln.length) { blockLines.push(''); i += 1; continue; }
        const m2 = ln.match(/^(\s*)/);
        if (m2[1].length < baseIndent && ln.trim().length) break;
        blockLines.push(ln.slice(baseIndent));
        i += 1;
      }
      parent[key] = blockLines.join('\n').replace(/\n+$/, '');
      continue;
    }

    if (value === '') {
      // Вложенный объект.
      const child = {};
      parent[key] = child;
      stack.push({ obj: child, indent });
    } else {
      // Скаляр: число | bool | string.
      let v = value.trim();
      if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
      else if (v === 'true')  v = true;
      else if (v === 'false') v = false;
      else if (v === 'null' || v === '~') v = null;
      else v = v.replace(/^['"]|['"]$/g, '');
      parent[key] = v;
    }
    i += 1;
  }
  return root;
}

/**
 * loadBrainState() — читает все yaml-файлы из brain_state/ и возвращает
 * объект { writer, critic, available, root }.
 *
 * Если файлы отсутствуют — возвращает заглушку с available=false и
 * НЕ бросает ошибку (мозг ещё не обучен).
 */
function loadBrainState() {
  const flags = getAegisFlags().brainState;
  const root = flags.rootDir;
  const writerPath = path.join(root, flags.writerYaml);
  const criticPath = path.join(root, flags.criticYaml);

  function _safeRead(p) {
    try {
      if (!fs.existsSync(p)) return null;
      const text = fs.readFileSync(p, 'utf8');
      return _parseSimpleYaml(text);
    } catch (_e) {
      return null;
    }
  }

  const writer = _safeRead(writerPath);
  const critic = _safeRead(criticPath);

  return {
    available: Boolean(writer || critic),
    root,
    writer:    writer || null,
    critic:    critic || null,
    paths:     { writer: writerPath, critic: criticPath },
  };
}

/**
 * getWriterSystemPromptOverride() — если в brain_state/compiled_writer.yaml
 * прописан skompilированный системный промпт — возвращает его. Иначе null.
 *
 * Используется в writer'е info-article и link-article pipelines:
 * если override есть — он подставляется поверх дефолтного системного
 * промпта, что и есть «DSPy эволюция мозга в действии».
 */
function getWriterSystemPromptOverride() {
  const state = loadBrainState();
  if (!state.writer) return null;
  if (state.writer.writer && typeof state.writer.writer.system_prompt === 'string') {
    return state.writer.writer.system_prompt;
  }
  if (typeof state.writer.system_prompt === 'string') {
    return state.writer.system_prompt;
  }
  return null;
}

/**
 * _humanBytes — форматирует размер файла в человекочитаемый вид (B/KB/MB).
 */
function _humanBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * getBrainStructure() — детерминированная карта «устройства мозга»:
 * какие файлы лежат в brain_state/, сколько весят, читаемы ли они.
 *
 * Не бросает ошибок: отсутствующий каталог/файл просто помечается
 * exists=false. Используется для блока «Устройство мозга» в UI и для
 * вычисления health (см. getBrainSummary).
 */
function getBrainStructure() {
  const flags = getAegisFlags().brainState;
  const root = flags.rootDir;

  // Известные артефакты мозга + их роль. Порядок фиксирован для стабильного UI.
  const known = [
    { file: flags.writerYaml, role: 'Скомпилированный промт писателя (DSPy)' },
    { file: flags.criticYaml, role: 'Скомпилированный промт критика (DSPy)' },
    { file: 'biobrain_state.json', role: 'Состояние Bio-Brain (поколение/фитнес)' },
    { file: 'biobrain_best.pkl', role: 'Лучший геном Bio-Brain (бинарь)' },
    { file: 'README.md', role: 'Документация формата и отката' },
  ];

  const files = known.map((k) => {
    const full = path.join(root, k.file);
    let exists = false;
    let bytes = null;
    let modified_at = null;
    let readable = false;
    try {
      const st = fs.statSync(full);
      exists = st.isFile();
      bytes = st.size;
      modified_at = st.mtime.toISOString();
      fs.accessSync(full, fs.constants.R_OK);
      readable = true;
    } catch (_e) { /* missing/unreadable → exists/readable остаются false */ }
    return {
      file: k.file,
      role: k.role,
      exists,
      readable,
      bytes,
      size_human: _humanBytes(bytes),
      modified_at,
    };
  });

  // history/ — снапшоты yaml перед каждым retrain'ом.
  let historyCount = 0;
  let historyBytes = 0;
  try {
    const histDir = path.join(root, 'history');
    for (const ent of fs.readdirSync(histDir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name !== '.gitkeep') {
        historyCount += 1;
        try { historyBytes += fs.statSync(path.join(histDir, ent.name)).size; } catch (_) { /* skip */ }
      }
    }
  } catch (_e) { /* history dir may be absent */ }

  const presentFiles = files.filter((f) => f.exists);
  const totalBytes = presentFiles.reduce((acc, f) => acc + (f.bytes || 0), 0) + historyBytes;
  const lastModified = files
    .map((f) => f.modified_at)
    .filter(Boolean)
    .sort()
    .pop() || null;

  return {
    root,
    files,
    history_snapshots: historyCount,
    history_bytes: historyBytes,
    files_present: presentFiles.length,
    files_total: files.length,
    total_bytes: totalBytes,
    total_human: _humanBytes(totalBytes),
    last_modified: lastModified,
  };
}

/**
 * getBrainSummary() — короткая сводка для UI/мониторинга.
 *
 * Возвращает не только версию/Spq, но и trials/notes/модель критика и
 * блок health: мозг читается синхронно из файлов на каждом запросе, без
 * сети, поэтому он «всегда онлайн», пока writer-файл читаем и парсится.
 */
function getBrainSummary() {
  const state = loadBrainState();
  const writer = state.writer || {};
  const critic = state.critic || {};
  const structure = getBrainStructure();

  // trained=true, когда DSPy реально перезаписал промт (есть system_prompt
  // или ≥1 trial). Пустой initial state считается «ещё не обучен».
  const writerPrompt = (writer.writer && writer.writer.system_prompt) || writer.system_prompt || '';
  const trialsDone = writer.trials_done != null ? writer.trials_done : (critic.trials_done || 0);
  const trained = Boolean(String(writerPrompt).trim()) || Number(trialsDone) > 0;

  // health: ok, если writer-файл присутствует и распарсился в объект.
  const writerFile = structure.files.find((f) => f.file === getAegisFlags().brainState.writerYaml);
  const writerOk = Boolean(state.writer) && Boolean(writerFile && writerFile.readable);
  const missing = structure.files.filter((f) => !f.exists).map((f) => f.file);

  return {
    available:        state.available,
    trained,
    version:          writer.version || critic.version || null,
    compiled_at:      writer.compiled_at || null,
    mean_spq_before:  writer.mean_spq_before || null,
    mean_spq_after:   writer.mean_spq_after  || null,
    model_writer:     writer.model || null,
    model_critic:     critic.model || null,
    trials_done:      Number(trialsDone) || 0,
    notes:            (typeof writer.notes === 'string' && writer.notes.trim()) || null,
    paths:            state.paths,
    structure,
    health: {
      // Мозг — это локальные файлы, читаемые на каждом вызове: нет внешних
      // зависимостей, поэтому он доступен 24/7, пока файлы на месте.
      always_on:    true,
      ok:           writerOk,
      reason:       writerOk
        ? (trained ? 'compiled' : 'baseline (ещё не обучен)')
        : 'writer-файл недоступен или повреждён',
      files_present: structure.files_present,
      files_total:   structure.files_total,
      missing,
      last_modified: structure.last_modified,
    },
  };
}

module.exports = {
  loadBrainState,
  getWriterSystemPromptOverride,
  getBrainSummary,
  getBrainStructure,
  _humanBytes,
  _parseSimpleYaml,        // для unit-тестов
};
