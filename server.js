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
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'messenger.html'));
});

// Хранилища
const users = new Map();
const channels = new Map();
const groups = new Map();
let messages = [];
let posts = [];
let nextId = 1;
let nextPostId = 1;

// Загрузка данных
try {
    const savedUsers = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
    for (const [username, data] of Object.entries(savedUsers)) {
        users.set(username, { ...data, ws: null, typingTo: null });
    }
} catch(e) {}

try {
    const savedMessages = JSON.parse(fs.readFileSync('./messages.json', 'utf8'));
    messages = savedMessages;
    nextId = (messages[messages.length - 1]?.id || 0) + 1;
} catch(e) {}

try {
    const savedPosts = JSON.parse(fs.readFileSync('./posts.json', 'utf8'));
    posts = savedPosts;
    nextPostId = (posts[posts.length - 1]?.id || 0) + 1;
} catch(e) {}

function saveUsers() {
    const toSave = {};
    for (const [username, data] of users.entries()) {
        toSave[username] = { password: data.password, name: data.name, avatar: data.avatar, lastSeen: data.lastSeen };
    }
    fs.writeFileSync('./users.json', JSON.stringify(toSave, null, 2));
}

function saveMessages() {
    fs.writeFileSync('./messages.json', JSON.stringify(messages.slice(-2000), null, 2));
}

function savePosts() {
    fs.writeFileSync('./posts.json', JSON.stringify(posts.slice(-500), null, 2));
}

function broadcastToAll(data, excludeSocket = null) {
    wss.clients.forEach(client => {
        if (client !== excludeSocket && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function broadcastToUser(username, data) {
    const user = users.get(username);
    if (user?.ws?.readyState === WebSocket.OPEN) {
        user.ws.send(JSON.stringify(data));
    }
}

function broadcastUserList() {
    const list = Array.from(users.entries()).map(([username, data]) => ({
        username, name: data.name, online: data.online, lastSeen: data.lastSeen, avatar: data.avatar
    }));
    broadcastToAll({ type: 'users', users: list });
}

wss.on('connection', (ws) => {
    let currentUser = null;
    
    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            
            // Регистрация
            if (data.type === 'register') {
                const { username, password, name, avatar } = data;
                if (!username.startsWith('@')) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Username должен начинаться с @' }));
                    return;
                }
                if (users.has(username)) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Пользователь уже существует' }));
                    return;
                }
                users.set(username, {
                    password, name: name || username.substring(1), online: true, ws, lastSeen: Date.now(), avatar: avatar || null
                });
                currentUser = username;
                ws.send(JSON.stringify({ type: 'registered', username, name: users.get(username).name, avatar }));
                
                const userMessages = messages.filter(m => 
                    (m.from === username || m.to === username)
                );
                ws.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-200) }));
                ws.send(JSON.stringify({ type: 'posts', posts: posts.slice(-50) }));
                broadcastUserList();
                saveUsers();
                return;
            }
            
            // Логин
            if (data.type === 'login') {
                const { username, password } = data;
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
                user.lastSeen = Date.now();
                currentUser = username;
                ws.send(JSON.stringify({ type: 'logged_in', username, name: user.name, avatar: user.avatar }));
                
                const userMessages = messages.filter(m => 
                    (m.from === username || m.to === username)
                );
                ws.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-200) }));
                ws.send(JSON.stringify({ type: 'posts', posts: posts.slice(-50) }));
                broadcastUserList();
                saveUsers();
                return;
            }
            
            // Обновление профиля
            if (data.type === 'update_profile') {
                const { name, avatar } = data;
                const user = users.get(currentUser);
                if (user) {
                    if (name) user.name = name;
                    if (avatar) user.avatar = avatar;
                    saveUsers();
                    broadcastUserList();
                    ws.send(JSON.stringify({ type: 'profile_updated', name: user.name, avatar: user.avatar }));
                }
                return;
            }
            
            // Личное сообщение
            if (data.type === 'message') {
                const { to, text, isImage } = data;
                const msg = {
                    id: nextId++, from: currentUser, to, text, isImage: isImage || false,
                    time: Date.now(),
                    timeStr: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
                    status: 'sent', read: false, edited: false, deleted: false
                };
                messages.push(msg);
                saveMessages();
                const recipient = users.get(to);
                if (recipient?.ws?.readyState === WebSocket.OPEN) {
                    recipient.ws.send(JSON.stringify({ type: 'new_message', message: msg }));
                    msg.status = 'delivered';
                }
                ws.send(JSON.stringify({ type: 'new_message', message: msg }));
            }
            
            // Пост в ленту
            if (data.type === 'new_post') {
                const { text, isImage } = data;
                const user = users.get(currentUser);
                const post = {
                    id: nextPostId++,
                    author: currentUser,
                    authorName: user.name,
                    authorAvatar: user.avatar,
                    text, isImage: isImage || false,
                    time: Date.now(),
                    timeStr: new Date().toLocaleString(),
                    likes: 0, comments: 0
                };
                posts.unshift(post);
                savePosts();
                broadcastToAll({ type: 'new_post', post });
                return;
            }
            
            // Прочитано
            if (data.type === 'read') {
                const { messageId } = data;
                const msg = messages.find(m => m.id === messageId);
                if (msg && !msg.read && msg.to === currentUser) {
                    msg.read = true;
                    msg.status = 'read';
                    broadcastToUser(msg.from, { type: 'message_read', messageId });
                    saveMessages();
                }
                return;
            }
            
        } catch(e) { console.error(e); }
    });
    
    ws.on('close', () => {
        if (currentUser) {
            const user = users.get(currentUser);
            if (user) {
                user.online = false;
                user.lastSeen = Date.now();
                user.ws = null;
            }
            broadcastUserList();
            saveUsers();
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер: http://localhost:${PORT}`);
});
