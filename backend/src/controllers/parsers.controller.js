const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const exceljs = require('exceljs');
const fs = require('fs');
const path = require('path');
const os = require('os');
const db = require('../config/db');

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers for parser_tasks
// ─────────────────────────────────────────────────────────────────────────────

async function createTask(taskId, userId, total) {
    await db.query(
        `INSERT INTO parser_tasks (id, user_id, status, progress, total)
         VALUES ($1, $2, 'running', 0, $3)`,
        [taskId, userId || null, total]
    );
}

async function updateTaskProgress(taskId, progress) {
    await db.query(
        `UPDATE parser_tasks SET progress = $2, updated_at = NOW() WHERE id = $1`,
        [taskId, progress]
    );
}

async function completeTask(taskId, results, filePath) {
    await db.query(
        `UPDATE parser_tasks SET status = 'done', progress = total, results = $2, file_path = $3, updated_at = NOW() WHERE id = $1`,
        [taskId, JSON.stringify(results), filePath]
    );
}

async function failTask(taskId, error) {
    await db.query(
        `UPDATE parser_tasks SET status = 'error', error = $2, updated_at = NOW() WHERE id = $1`,
        [taskId, (error || '').substring(0, 2000)]
    );
}

async function getTask(taskId) {
    const { rows } = await db.query(`SELECT * FROM parser_tasks WHERE id = $1`, [taskId]);
    return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────

exports.startParsing = async (req, res) => {
    try {
        let { urls, options } = req.body;
        // options: { contacts: bool, about: bool, services: bool, deepseek_api_key: string }
        
        if (!urls || !Array.isArray(urls)) {
            urls = [];
        } else {
            // Validation, normalization and deduplication
            const validUrls = new Set();
            for (let u of urls) {
                if (typeof u === 'string') {
                    u = u.trim();
                    if (u) {
                        if (!/^https?:\/\//i.test(u)) {
                            u = 'https://' + u;
                        }
                        validUrls.add(u);
                    }
                }
            }
            urls = Array.from(validUrls);
        }
        
        if (urls.length === 0 && !options?.search_query) {
            return res.status(400).json({ error: 'List of URLs or search_query is required' });
        }

        const taskId = uuidv4();
        const userId = req.user?.id || null;
        
        // Save initial state to DB
        await createTask(taskId, userId, urls.length || 10);

        res.json({ task_id: taskId });

        // Start background process
        processUrls(taskId, urls, options);
        
    } catch (error) {
        console.error('startParsing error:', error);
        res.status(500).json({ error: error.message });
    }
};

async function processUrls(taskId, urls, options) {
    try {
        let finalUrls = urls;

        if (urls.length === 0 && options?.search_query) {
            // Fetch from xmlstock if search_query is provided
            const { fetchYandexSerp } = require('../services/metaTags/xmlstockClient');
            try {
                const serp = await fetchYandexSerp({
                    query: options.search_query,
                    page: 0
                });
                finalUrls = (serp.organic || []).map(r => r.url).slice(0, 10);
            } catch (err) {
                console.warn('Failed to fetch SERP:', err.message);
                finalUrls = [];
            }
        }

        // Apply same validation to search results
        const validFinalUrls = new Set();
        for (let u of finalUrls) {
            if (typeof u === 'string') {
                u = u.trim();
                if (u) {
                    if (!/^https?:\/\//i.test(u)) {
                        u = 'https://' + u;
                    }
                    validFinalUrls.add(u);
                }
            }
        }
        finalUrls = Array.from(validFinalUrls);

        if (finalUrls.length === 0) {
            throw new Error('No URLs to parse');
        }
        
        // Update total in DB
        await db.query(`UPDATE parser_tasks SET total = $2, updated_at = NOW() WHERE id = $1`, [taskId, finalUrls.length]);

        const AUDIT_URL = process.env.AUDIT_INTERNAL_URL || 'http://audit:8002';
        const results = [];
        
        const CONCURRENCY = 5;
        let index = 0;
        let progressCount = 0;
        
        const worker = async () => {
            while (index < finalUrls.length) {
                const i = index++;
                const currentUrl = finalUrls[i];
                
                try {
                    const payload = {
                        urls: [currentUrl],
                        extract_contacts: options?.contacts || false,
                        extract_about: options?.about || false,
                        extract_services: options?.services || false,
                        api_key: process.env.DEEPSEEK_API_KEY || options?.deepseek_api_key || ""
                    };
                    
                    const response = await axios.post(`${AUDIT_URL}/audit/parsers/extract`, payload, {
                        headers: {
                            'X-Internal-Token': process.env.RELEVANCE_INTERNAL_TOKEN || ''
                        },
                        timeout: 300000 // 5 mins
                    });
                    
                    if (response.data && response.data.results && response.data.results.length > 0) {
                        results.push(response.data.results[0]);
                    } else {
                        results.push({ url: currentUrl, status: "Ошибка: пустой ответ от сервиса" });
                    }
                } catch (err) {
                    const code = err.code || '';
                    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
                        results.push({ url: currentUrl, status: 'Сервис парсинга недоступен' });
                    } else {
                        results.push({ url: currentUrl, status: `Ошибка API: ${err.message}` });
                    }
                }
                
                progressCount++;
                // Batch DB updates every 3 items or on last item
                if (progressCount % 3 === 0 || progressCount === finalUrls.length) {
                    await updateTaskProgress(taskId, progressCount).catch(() => {});
                }
            }
        };

        const workers = [];
        for (let w = 0; w < CONCURRENCY; w++) {
            workers.push(worker());
        }
        await Promise.all(workers);
        
        // Generate Excel
        const workbook = new exceljs.Workbook();
        const worksheet = workbook.addWorksheet('Parsers');
        
        worksheet.columns = [
            { header: 'URL сайта', key: 'url', width: 30 },
            { header: 'Title главной страницы', key: 'title', width: 30 },
            { header: 'Контакты', key: 'contacts', width: 30 },
            { header: 'О компании', key: 'about', width: 30 },
            { header: 'Список услуг', key: 'services', width: 30 },
            { header: 'Ключевой упор (Фокус)', key: 'focus', width: 30 },
            { header: 'Статус парсинга', key: 'status', width: 20 }
        ];

        for (const item of results) {
            worksheet.addRow({
                url: item.url,
                title: item.title,
                contacts: item.contacts,
                about: item.about,
                services: Array.isArray(item.services) ? item.services.join(', ') : item.services,
                focus: item.focus,
                status: item.status
            });
        }
        
        const uploadsDir = path.join(os.tmpdir(), 'generator_uploads');
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        
        const filePath = path.join(uploadsDir, `parsers_${taskId}.xlsx`);
        await workbook.xlsx.writeFile(filePath);
        
        await completeTask(taskId, results, filePath);
        
    } catch (err) {
        console.error('Parsers background error:', err);
        await failTask(taskId, err.message);
    }
}

exports.getTaskStatus = async (req, res) => {
    const { taskId } = req.params;
    const task = await getTask(taskId);
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }
    res.json({
        id: task.id,
        status: task.status,
        progress: task.progress,
        total: task.total,
        error: task.error
    });
};

exports.downloadReport = async (req, res) => {
    const { taskId } = req.params;
    const task = await getTask(taskId);
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }
    if (task.status !== 'done' || !task.file_path) {
        return res.status(400).json({ error: 'Report not ready' });
    }
    res.download(task.file_path, `parsers_report.xlsx`);
};