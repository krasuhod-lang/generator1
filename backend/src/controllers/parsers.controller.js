const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const exceljs = require('exceljs');
const fs = require('fs');
const path = require('path');
const os = require('os');

// in-memory store for tasks
const tasksStore = new Map();

// Optional: you can integrate this with the existing sseManager if you want SSE

exports.startParsing = async (req, res) => {
    try {
        const { urls, options } = req.body;
        // options: { contacts: bool, about: bool, services: bool, deepseek_api_key: string }
        
        if (!urls || !Array.isArray(urls)) {
            urls = [];
        }
        
        if (urls.length === 0 && !options?.search_query) {
            return res.status(400).json({ error: 'List of URLs or search_query is required' });
        }

        const taskId = uuidv4();
        
        // Save initial state
        tasksStore.set(taskId, {
            id: taskId,
            status: 'running', // running, done, error
            progress: 0,
            total: urls.length || 10, // Assuming 10 from search
            results: [],
            error: null,
            file_path: null
        });

        res.json({ task_id: taskId });

        // Start background process
        processUrls(taskId, urls, options);
        
    } catch (error) {
        console.error('startParsing error:', error);
        res.status(500).json({ error: error.message });
    }
};

async function processUrls(taskId, urls, options) {
    const task = tasksStore.get(taskId);
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

        if (finalUrls.length === 0) {
            throw new Error('No URLs to parse');
        }

        const payload = {
            urls: finalUrls,
            extract_contacts: options?.contacts || false,
            extract_about: options?.about || false,
            extract_services: options?.services || false,
            api_key: process.env.DEEPSEEK_API_KEY || options?.deepseek_api_key || ""
        };

        // Call python microservice audit
        const AUDIT_URL = process.env.AUDIT_URL || 'http://seo_audit:8002';
        const response = await axios.post(`${AUDIT_URL}/audit/parsers/extract`, payload, {
            headers: {
                'X-Internal-Token': process.env.RELEVANCE_INTERNAL_TOKEN || ''
            },
            timeout: 600000 // 10 mins
        });
        
        const results = response.data.results;
        
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
        
        task.status = 'done';
        task.progress = task.total;
        task.results = results;
        task.file_path = filePath;
        
    } catch (err) {
        console.error('Parsers background error:', err);
        task.status = 'error';
        task.error = err.message;
    }
}

exports.getTaskStatus = async (req, res) => {
    const { taskId } = req.params;
    const task = tasksStore.get(taskId);
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
    const task = tasksStore.get(taskId);
    if (!task) {
        return res.status(404).json({ error: 'Task not found' });
    }
    if (task.status !== 'done' || !task.file_path) {
        return res.status(400).json({ error: 'Report not ready' });
    }
    res.download(task.file_path, `parsers_report.xlsx`);
};