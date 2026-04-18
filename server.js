const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;

// ============ EXPRESS ============
const app = express();

// Отдаём статические файлы (твой HTML)
app.use(express.static(__dirname));

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'messenger.html'));
});

// ============ HTTP СЕРВЕР ============
const server = http.createServer(app);

// ============ WEBSOCKET ============
const wss = new WebSocket.Server({ server });

// Хранилища
const users = new Map(); // username -> { password, name, socket, online }
let messages = [];
let nextId = 1;

// Загрузка сохранённых сообщений
try {
    const saved = JSON.parse(fs.readFileSync('./messages.json', 'utf8'));
    messages = saved;
    nextId = (messages[messages.length - 1]?.id || 0) + 1;
} catch(e) {}

// Сохранение сообщений
function saveMessages() {
    fs.writeFileSync('./messages.json', JSON.stringify(messages.slice(-500)), 'utf8');
}

// Рассылка всем пользователям
function broadcastToAll(data, excludeSocket = null) {
    wss.clients.forEach(client => {
        if (client !== excludeSocket && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

// Отправка конкретному пользователю
function sendToUser(username, data) {
    const user = users.get(username);
    if (user && user.socket && user.socket.readyState === WebSocket.OPEN) {
        user.socket.send(JSON.stringify(data));
    }
}

// Отправка списка пользователей всем
function broadcastUserList() {
    const list = Array.from(users.keys()).map(username => ({
        username: username,
        name: users.get(username).name,
        online: users.get(username).online
    }));
    broadcastToAll({ type: 'users', users: list });
}

// ============ WEBSOCKET ОБРАБОТЧИК ============
wss.on('connection', (socket) => {
    let currentUser = null;
    
    socket.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            console.log('Получено:', data.type);
            
            // === РЕГИСТРАЦИЯ ===
            if (data.type === 'register') {
                const { username, password, name } = data;
                
                if (!username.startsWith('@')) {
                    socket.send(JSON.stringify({ type: 'error', text: 'Username должен начинаться с @' }));
                    return;
                }
                
                if (users.has(username)) {
                    socket.send(JSON.stringify({ type: 'error', text: 'Пользователь уже существует' }));
                    return;
                }
                
                users.set(username, {
                    password: password,
                    name: name || username.substring(1),
                    socket: socket,
                    online: true
                });
                currentUser = username;
                
                socket.send(JSON.stringify({
                    type: 'registered',
                    username: username,
                    name: users.get(username).name
                }));
                
                // Отправляем историю сообщений
                const userMessages = messages.filter(m => 
                    (m.from === username || m.to === username)
                );
                socket.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-100) }));
                
                broadcastUserList();
                return;
            }
            
            // === ЛОГИН ===
            if (data.type === 'login') {
                const { username, password } = data;
                
                if (!username.startsWith('@')) {
                    socket.send(JSON.stringify({ type: 'error', text: 'Username должен начинаться с @' }));
                    return;
                }
                
                const user = users.get(username);
                if (!user) {
                    socket.send(JSON.stringify({ type: 'error', text: 'Пользователь не найден. Зарегистрируйтесь.' }));
                    return;
                }
                
                if (user.password !== password) {
                    socket.send(JSON.stringify({ type: 'error', text: 'Неверный пароль' }));
                    return;
                }
                
                user.socket = socket;
                user.online = true;
                currentUser = username;
                
                socket.send(JSON.stringify({
                    type: 'logged_in',
                    username: username,
                    name: user.name
                }));
                
                // Отправляем историю сообщений
                const userMessages = messages.filter(m => 
                    (m.from === username || m.to === username)
                );
                socket.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-100) }));
                
                broadcastUserList();
                return;
            }
            
            // === ОТПРАВКА СООБЩЕНИЯ ===
            if (data.type === 'message') {
                const { to, text } = data;
                
                if (!to.startsWith('@')) {
                    socket.send(JSON.stringify({ type: 'error', text: 'Получатель должен начинаться с @' }));
                    return;
                }
                
                const msg = {
                    id: nextId++,
                    from: currentUser,
                    to: to,
                    text: text,
                    time: Date.now(),
                    timeStr: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
                    status: 'sent',
                    read: false
                };
                messages.push(msg);
                saveMessages();
                
                const recipient = users.get(to);
                if (recipient && recipient.socket && recipient.socket.readyState === WebSocket.OPEN) {
                    // Получатель онлайн
                    recipient.socket.send(JSON.stringify({ type: 'new_message', message: msg }));
                    msg.status = 'delivered';
                    socket.send(JSON.stringify({ type: 'new_message', message: msg }));
                } else {
                    // Получатель оффлайн
                    socket.send(JSON.stringify({ type: 'new_message', message: msg }));
                }
            }
            
            // === ПРОЧИТАНО ===
            if (data.type === 'read') {
                const { messageId } = data;
                const msg = messages.find(m => m.id === messageId);
                if (msg && msg.to === currentUser && !msg.read) {
                    msg.read = true;
                    msg.status = 'read';
                    sendToUser(msg.from, { type: 'message_read', messageId });
                    saveMessages();
                }
            }
            
        } catch(e) {
            console.error('Ошибка:', e);
        }
    });
    
    socket.on('close', () => {
        if (currentUser) {
            const user = users.get(currentUser);
            if (user) {
                user.online = false;
                user.socket = null;
            }
            broadcastUserList();
        }
    });
});

// ============ ЗАПУСК ============
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
    console.log(`📡 WebSocket на ws://localhost:${PORT}`);
});
