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
const users = new Map(); // @username -> { password, name, online, ws, lastSeen, avatar, typingTo }
const channels = new Map(); // channelId -> { name, description, owner, subscribers, createdAt, avatar }
let messages = [];
let nextId = 1;

// Загрузка данных
try {
    const savedUsers = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
    for (const [username, data] of Object.entries(savedUsers)) {
        users.set(username, { ...data, ws: null, typingTo: null });
    }
} catch(e) {}

try {
    const savedChannels = JSON.parse(fs.readFileSync('./channels.json', 'utf8'));
    for (const [channelId, data] of Object.entries(savedChannels)) {
        channels.set(channelId, data);
    }
} catch(e) {}

try {
    const saved = JSON.parse(fs.readFileSync('./messages.json', 'utf8'));
    messages = saved;
    nextId = (messages[messages.length - 1]?.id || 0) + 1;
} catch(e) {}

function saveUsers() {
    const toSave = {};
    for (const [username, data] of users.entries()) {
        toSave[username] = { password: data.password, name: data.name, avatar: data.avatar, lastSeen: data.lastSeen };
    }
    fs.writeFileSync('./users.json', JSON.stringify(toSave, null, 2), 'utf8');
}

function saveChannels() {
    const toSave = {};
    for (const [channelId, data] of channels.entries()) {
        toSave[channelId] = { name: data.name, description: data.description, owner: data.owner, subscribers: data.subscribers, avatar: data.avatar, createdAt: data.createdAt };
    }
    fs.writeFileSync('./channels.json', JSON.stringify(toSave, null, 2), 'utf8');
}

function saveMessages() {
    fs.writeFileSync('./messages.json', JSON.stringify(messages.slice(-2000), null, 2), 'utf8');
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
    if (user && user.ws && user.ws.readyState === WebSocket.OPEN) {
        user.ws.send(JSON.stringify(data));
    }
}

function broadcastToChannel(channelId, data, excludeUser = null) {
    const channel = channels.get(channelId);
    if (!channel) return;
    channel.subscribers.forEach(sub => {
        if (sub !== excludeUser) {
            broadcastToUser(sub, data);
        }
    });
}

function broadcastUserList() {
    const list = Array.from(users.entries()).map(([username, data]) => ({
        username: username,
        name: data.name,
        online: data.online,
        lastSeen: data.lastSeen,
        avatar: data.avatar
    }));
    broadcastToAll({ type: 'users', users: list });
}

function broadcastChannelList() {
    const list = Array.from(channels.entries()).map(([channelId, data]) => ({
        id: channelId,
        name: data.name,
        description: data.description,
        owner: data.owner,
        subscribers: data.subscribers,
        avatar: data.avatar,
        createdAt: data.createdAt
    }));
    broadcastToAll({ type: 'channels', channels: list });
}

wss.on('connection', (ws) => {
    let currentUser = null;
    
    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            
            // === РЕГИСТРАЦИЯ ===
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
                    password: password,
                    name: name || username.substring(1),
                    online: true,
                    ws: ws,
                    lastSeen: Date.now(),
                    avatar: avatar || null,
                    typingTo: null
                });
                currentUser = username;
                ws.send(JSON.stringify({ type: 'registered', username, name: users.get(username).name, avatar }));
                
                const userMessages = messages.filter(m => 
                    (!m.isChannel && !m.isGroup && (m.from === username || m.to === username)) ||
                    (m.isChannel && channels.get(m.to)?.subscribers?.includes(username))
                );
                ws.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-200) }));
                
                broadcastUserList();
                broadcastChannelList();
                saveUsers();
                return;
            }
            
            // === ЛОГИН ===
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
                    (!m.isChannel && !m.isGroup && (m.from === username || m.to === username)) ||
                    (m.isChannel && channels.get(m.to)?.subscribers?.includes(username))
                );
                ws.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-200) }));
                
                broadcastUserList();
                broadcastChannelList();
                saveUsers();
                return;
            }
            
            // === ОБНОВЛЕНИЕ ПРОФИЛЯ ===
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
            
            // === ПЕЧАТАЕТ ===
            if (data.type === 'typing') {
                const { to } = data;
                const user = users.get(currentUser);
                if (user) user.typingTo = to;
                broadcastToUser(to, { type: 'typing', from: currentUser });
                setTimeout(() => {
                    if (users.get(currentUser)?.typingTo === to) {
                        broadcastToUser(to, { type: 'stop_typing', from: currentUser });
                    }
                }, 2000);
                return;
            }
            
            // === ЛИЧНОЕ СООБЩЕНИЕ ===
            if (data.type === 'message') {
                const { to, text, isImage } = data;
                const msg = {
                    id: nextId++,
                    from: currentUser,
                    to: to,
                    text: text,
                    isImage: isImage || false,
                    time: Date.now(),
                    timeStr: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
                    status: 'sent',
                    read: false,
                    edited: false,
                    deleted: false,
                    isGroup: false,
                    isChannel: false
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
            
            // === СООБЩЕНИЕ В КАНАЛ ===
            if (data.type === 'channel_message') {
                const { channelId, text, isImage } = data;
                const channel = channels.get(channelId);
                if (!channel) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Канал не найден' }));
                    return;
                }
                if (channel.owner !== currentUser && !channel.subscribers.includes(currentUser)) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Нет доступа к каналу' }));
                    return;
                }
                const msg = {
                    id: nextId++,
                    from: currentUser,
                    to: channelId,
                    text: text,
                    isImage: isImage || false,
                    time: Date.now(),
                    timeStr: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
                    status: 'sent',
                    read: false,
                    edited: false,
                    deleted: false,
                    isGroup: false,
                    isChannel: true
                };
                messages.push(msg);
                saveMessages();
                broadcastToChannel(channelId, { type: 'new_message', message: msg }, currentUser);
                ws.send(JSON.stringify({ type: 'new_message', message: msg }));
            }
            
            // === СОЗДАНИЕ КАНАЛА ===
            if (data.type === 'create_channel') {
                const { name, description, avatar } = data;
                const channelId = 'channel_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                channels.set(channelId, {
                    name: name,
                    description: description || '',
                    owner: currentUser,
                    subscribers: [currentUser],
                    avatar: avatar || null,
                    createdAt: Date.now()
                });
                broadcastChannelList();
                saveChannels();
                ws.send(JSON.stringify({ type: 'channel_created', channelId, name }));
            }
            
            // === ПОДПИСКА НА КАНАЛ ===
            if (data.type === 'subscribe_channel') {
                const { channelId } = data;
                const channel = channels.get(channelId);
                if (channel && !channel.subscribers.includes(currentUser)) {
                    channel.subscribers.push(currentUser);
                    broadcastChannelList();
                    saveChannels();
                    ws.send(JSON.stringify({ type: 'subscribed', channelId }));
                }
            }
            
            // === ОТПИСКА ОТ КАНАЛА ===
            if (data.type === 'unsubscribe_channel') {
                const { channelId } = data;
                const channel = channels.get(channelId);
                if (channel && channel.subscribers.includes(currentUser) && channel.owner !== currentUser) {
                    channel.subscribers = channel.subscribers.filter(s => s !== currentUser);
                    broadcastChannelList();
                    saveChannels();
                }
            }
            
            // === ПРОЧИТАНО ===
            if (data.type === 'read') {
                const { messageId } = data;
                const msg = messages.find(m => m.id === messageId);
                if (msg && !msg.read && msg.to === currentUser) {
                    msg.read = true;
                    msg.status = 'read';
                    broadcastToUser(msg.from, { type: 'message_read', messageId });
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
                    if (msg.isChannel) {
                        broadcastToChannel(msg.to, { type: 'message_edited', messageId, newText });
                    } else {
                        broadcastToUser(msg.to, { type: 'message_edited', messageId, newText });
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
                    if (msg.isChannel) {
                        broadcastToChannel(msg.to, { type: 'message_deleted', messageId });
                    } else {
                        broadcastToUser(msg.to, { type: 'message_deleted', messageId });
                    }
                    saveMessages();
                }
            }
            
            // === УДАЛЕНИЕ ЧАТА ===
            if (data.type === 'delete_chat') {
                const { withUser } = data;
                messages = messages.filter(m => 
                    !((m.from === currentUser && m.to === withUser) || (m.from === withUser && m.to === currentUser))
                );
                saveMessages();
                ws.send(JSON.stringify({ type: 'chat_deleted', withUser }));
            }
            
        } catch(e) { console.error('Ошибка:', e); }
    });
    
    ws.on('close', () => {
        if (currentUser) {
            const user = users.get(currentUser);
            if (user) {
                user.online = false;
                user.lastSeen = Date.now();
                user.ws = null;
                user.typingTo = null;
            }
            broadcastUserList();
            saveUsers();
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер: http://localhost:${PORT}`);
});
