const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'messenger.html'));
});

// ============ ХРАНИЛИЩА ============
const users = new Map(); // @username -> { password, name, online, ws }
let messages = [];
let nextId = 1;

// Загрузка сообщений из файла
try {
    const saved = JSON.parse(fs.readFileSync('./messages.json', 'utf8'));
    messages = saved;
    nextId = (messages[messages.length - 1]?.id || 0) + 1;
} catch(e) {}

// Сохранение сообщений
function saveMessages() {
    fs.writeFileSync('./messages.json', JSON.stringify(messages.slice(-500)), 'utf8');
}

// ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ============
function broadcastToAll(data, excludeSocket = null) {
    wss.clients.forEach(client => {
        if (client !== excludeSocket && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function broadcastUserList() {
    const list = Array.from(users.entries()).map(([username, data]) => ({
        username: username,
        name: data.name,
        online: data.online
    }));
    broadcastToAll({ type: 'users', users: list });
}

// ============ WEBSOCKET ============
wss.on('connection', (ws) => {
    console.log('✅ Новый клиент подключился');
    let currentUser = null;
    
    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            console.log('📨 Получено:', data.type);
            
            // === РЕГИСТРАЦИЯ ===
            if (data.type === 'register') {
                const { username, password, name } = data;
                
                if (!username.startsWith('@')) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Username должен начинаться с @' }));
                    return;
                }
                
                if (users.has(username)) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Пользователь уже существует' }));
                    return;
                }
                
                users.set(username, {
                    password: password,
                    name: name || username.substring(1),
                    online: true,
                    ws: ws
                });
                currentUser = username;
                
                ws.send(JSON.stringify({
                    type: 'registered',
                    username: username,
                    name: users.get(username).name
                }));
                
                // Отправляем историю сообщений
                const userMessages = messages.filter(m =>
                    (m.from === username || m.to === username)
                );
                ws.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-100) }));
                
                broadcastUserList();
                return;
            }
            
            // === ЛОГИН ===
            if (data.type === 'login') {
                const { username, password } = data;
                
                if (!username.startsWith('@')) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Username должен начинаться с @' }));
                    return;
                }
                
                const user = users.get(username);
                if (!user) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Пользователь не найден' }));
                    return;
                }
                
                if (user.password !== password) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Неверный пароль' }));
                    return;
                }
                
                user.ws = ws;
                user.online = true;
                currentUser = username;
                
                ws.send(JSON.stringify({
                    type: 'logged_in',
                    username: username,
                    name: user.name
                }));
                
                // Отправляем историю сообщений
                const userMessages = messages.filter(m =>
                    (m.from === username || m.to === username)
                );
                ws.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-100) }));
                
                broadcastUserList();
                return;
            }
            
            // === ОТПРАВКА СООБЩЕНИЯ ===
            if (data.type === 'message') {
                const { to, text } = data;
                
                if (!to.startsWith('@')) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Получатель должен начинаться с @' }));
                    return;
                }
                
                const msg = {
                    id: nextId++,
                    from: currentUser,
                    to: to,
                    text: text,
                    time: Date.now(),
                    timeStr: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    status: 'sent',
                    read: false,
                    edited: false,
                    deleted: false
                };
                messages.push(msg);
                saveMessages();
                
                const recipient = users.get(to);
                if (recipient && recipient.ws && recipient.ws.readyState === WebSocket.OPEN) {
                    recipient.ws.send(JSON.stringify({ type: 'new_message', message: msg }));
                    msg.status = 'delivered';
                    ws.send(JSON.stringify({ type: 'new_message', message: msg }));
                } else {
                    ws.send(JSON.stringify({ type: 'new_message', message: msg }));
                }
            }
            
            // === ПРОЧИТАНО ===
            if (data.type === 'read') {
                const { messageId } = data;
                const msg = messages.find(m => m.id === messageId);
                if (msg && msg.to === currentUser && !msg.read) {
                    msg.read = true;
                    msg.status = 'read';
                    const sender = users.get(msg.from);
                    if (sender && sender.ws && sender.ws.readyState === WebSocket.OPEN) {
                        sender.ws.send(JSON.stringify({ type: 'message_read', messageId }));
                    }
                    saveMessages();
                }
            }
            
            // === РЕДАКТИРОВАНИЕ ===
            if (data.type === 'edit') {
                const { messageId, newText } = data;
                const msg = messages.find(m => m.id === messageId);
                if (msg && msg.from === currentUser) {
                    msg.text = newText;
                    msg.edited = true;
                    const recipient = users.get(msg.to);
                    if (recipient && recipient.ws && recipient.ws.readyState === WebSocket.OPEN) {
                        recipient.ws.send(JSON.stringify({ type: 'message_edited', messageId, newText }));
                    }
                    saveMessages();
                }
            }
            
            // === УДАЛЕНИЕ ===
            if (data.type === 'delete') {
                const { messageId } = data;
                const msg = messages.find(m => m.id === messageId);
                if (msg && msg.from === currentUser) {
                    msg.text = '[Удалено]';
                    msg.deleted = true;
                    const recipient = users.get(msg.to);
                    if (recipient && recipient.ws && recipient.ws.readyState === WebSocket.OPEN) {
                        recipient.ws.send(JSON.stringify({ type: 'message_deleted', messageId }));
                    }
                    saveMessages();
                }
            }
            
        } catch(e) {
            console.error('Ошибка:', e);
        }
    });
    
    ws.on('close', () => {
        console.log('❌ Клиент отключился');
        if (currentUser) {
            const user = users.get(currentUser);
            if (user) {
                user.online = false;
                user.ws = null;
            }
            broadcastUserList();
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
    console.log(`📡 WebSocket работает на ws://localhost:${PORT}`);
});
