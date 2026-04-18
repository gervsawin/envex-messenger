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
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'messenger.html'));
});

// ============ ХРАНИЛИЩА ============
const users = new Map(); // @username -> { password, name, online, ws, avatar }
const groups = new Map(); // groupId -> { name, members, owner, avatar, createdAt }
let messages = [];
let nextId = 1;

// Загрузка данных
try {
    const savedUsers = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
    for (const [username, data] of Object.entries(savedUsers)) {
        users.set(username, { ...data, ws: null });
    }
} catch(e) {}

try {
    const savedGroups = JSON.parse(fs.readFileSync('./groups.json', 'utf8'));
    for (const [groupId, data] of Object.entries(savedGroups)) {
        groups.set(groupId, data);
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
        toSave[username] = { password: data.password, name: data.name, online: false, lastSeen: data.lastSeen, avatar: data.avatar };
    }
    fs.writeFileSync('./users.json', JSON.stringify(toSave, null, 2), 'utf8');
}

function saveGroups() {
    const toSave = {};
    for (const [groupId, data] of groups.entries()) {
        toSave[groupId] = { name: data.name, members: data.members, owner: data.owner, avatar: data.avatar, createdAt: data.createdAt };
    }
    fs.writeFileSync('./groups.json', JSON.stringify(toSave, null, 2), 'utf8');
}

function saveMessages() {
    fs.writeFileSync('./messages.json', JSON.stringify(messages.slice(-1000), null, 2), 'utf8');
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

function broadcastToGroup(groupId, data, excludeUser = null) {
    const group = groups.get(groupId);
    if (!group) return;
    group.members.forEach(member => {
        if (member !== excludeUser) {
            broadcastToUser(member, data);
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

function broadcastGroupList() {
    const list = Array.from(groups.entries()).map(([groupId, data]) => ({
        id: groupId,
        name: data.name,
        members: data.members,
        owner: data.owner,
        avatar: data.avatar,
        createdAt: data.createdAt
    }));
    broadcastToAll({ type: 'groups', groups: list });
}

wss.on('connection', (ws) => {
    console.log('✅ Новый клиент');
    let currentUser = null;
    
    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            console.log('📨', data.type);
            
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
                    avatar: avatar || null
                });
                currentUser = username;
                
                ws.send(JSON.stringify({ type: 'registered', username, name: users.get(username).name, avatar }));
                
                const userMessages = messages.filter(m => 
                    (!m.isGroup && (m.from === username || m.to === username)) ||
                    (m.isGroup && groups.get(m.to)?.members?.includes(username))
                );
                ws.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-200) }));
                
                broadcastUserList();
                broadcastGroupList();
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
                    (!m.isGroup && (m.from === username || m.to === username)) ||
                    (m.isGroup && groups.get(m.to)?.members?.includes(username))
                );
                ws.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-200) }));
                
                broadcastUserList();
                broadcastGroupList();
                saveUsers();
                return;
            }
            
            // === ОБНОВЛЕНИЕ АВАТАРА ===
            if (data.type === 'update_avatar') {
                const { avatar } = data;
                const user = users.get(currentUser);
                if (user) {
                    user.avatar = avatar;
                    saveUsers();
                    broadcastUserList();
                }
                return;
            }
            
            // === ЛИЧНОЕ СООБЩЕНИЕ ===
            if (data.type === 'message') {
                const { to, text } = data;
                
                const msg = {
                    id: nextId++,
                    from: currentUser,
                    to: to,
                    text: text,
                    time: Date.now(),
                    timeStr: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
                    status: 'sent',
                    read: false,
                    edited: false,
                    deleted: false,
                    isGroup: false
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
            
            // === ГРУППОВОЕ СООБЩЕНИЕ ===
            if (data.type === 'group_message') {
                const { groupId, text } = data;
                
                const group = groups.get(groupId);
                if (!group || !group.members.includes(currentUser)) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Нет доступа к группе' }));
                    return;
                }
                
                const msg = {
                    id: nextId++,
                    from: currentUser,
                    to: groupId,
                    text: text,
                    time: Date.now(),
                    timeStr: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
                    status: 'sent',
                    read: false,
                    edited: false,
                    deleted: false,
                    isGroup: true
                };
                messages.push(msg);
                saveMessages();
                
                broadcastToGroup(groupId, { type: 'new_message', message: msg }, currentUser);
                ws.send(JSON.stringify({ type: 'new_message', message: msg }));
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
                    if (msg.isGroup) {
                        broadcastToGroup(msg.to, { type: 'message_edited', messageId, newText });
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
                    if (msg.isGroup) {
                        broadcastToGroup(msg.to, { type: 'message_deleted', messageId });
                    } else {
                        broadcastToUser(msg.to, { type: 'message_deleted', messageId });
                    }
                    saveMessages();
                }
            }
            
            // === СОЗДАНИЕ ГРУППЫ ===
            if (data.type === 'create_group') {
                const { name, members, avatar } = data;
                const groupId = 'group_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                
                groups.set(groupId, {
                    name: name,
                    members: [currentUser, ...members],
                    owner: currentUser,
                    avatar: avatar || null,
                    createdAt: Date.now()
                });
                
                broadcastGroupList();
                saveGroups();
                
                ws.send(JSON.stringify({ type: 'group_created', groupId, name }));
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
            }
            broadcastUserList();
            saveUsers();
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер: http://localhost:${PORT}`);
});
