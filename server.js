const express = require('express');
const path = require('path');
const app = express();

// Указываем порт для Railway
const PORT = process.env.PORT || 3000;

// ГЛАВНОЕ: отдаем файл messenger.html при заходе на сайт
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'messenger.html'));
});

// Если у тебя есть папка с картинками/стилями, добавь это:
app.use(express.static(__dirname));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
