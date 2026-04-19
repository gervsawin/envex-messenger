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

function saveGroups() {
    const toSave = {};
    for (const [groupId, data] of groups.entries()) {
        toSave[groupId] = { name: data.name, members: data.members, owner: data.owner, avatar: data.avatar, createdAt: data.createdAt };
    }
    fs.writeFileSync('./groups.json', JSON.stringify(toSave, null, 2), 'utf8');
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

function broadcastToGroup(groupId, data, excludeUser = null) {
    const group = groups.get(groupId);
    if (!group) return;
    group.members.forEach(member => {
        if (member !== excludeUser) {
            broadcastToUser(member, data);
        }
    });
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
        username, name: data.name, online: data.online, lastSeen: data.lastSeen, avatar: data.avatar
    }));
    broadcastToAll({ type: 'users', users: list });
}

function broadcastChannelList() {
    const list = Array.from(channels.entries()).map(([id, data]) => ({
        id, name: data.name, description: data.description, owner: data.owner, subscribers: data.subscribers, avatar: data.avatar
    }));
    broadcastToAll({ type: 'channels', channels: list });
}

function broadcastGroupList() {
    const list = Array.from(groups.entries()).map(([id, data]) => ({
        id, name: data.name, members: data.members, owner: data.owner, avatar: data.avatar
    }));
    broadcastToAll({ type: 'groups', groups: list });
}

wss.on('connection', (ws) => {
    let currentUser = null;
    
    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            
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
                    password, name: name || username.substring(1), online: true, ws, lastSeen: Date.now(), avatar: avatar || null, typingTo: null
                });
                currentUser = username;
                ws.send(JSON.stringify({ type: 'registered', username, name: users.get(username).name, avatar }));
                
                const userMessages = messages.filter(m => 
                    (!m.isChannel && !m.isGroup && (m.from === username || m.to === username)) ||
                    (m.isChannel && channels.get(m.to)?.subscribers?.includes(username)) ||
                    (m.isGroup && groups.get(m.to)?.members?.includes(username))
                );
                ws.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-200) }));
                
                broadcastUserList();
                broadcastChannelList();
                broadcastGroupList();
                saveUsers();
                return;
            }
            
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
                    (m.isChannel && channels.get(m.to)?.subscribers?.includes(username)) ||
                    (m.isGroup && groups.get(m.to)?.members?.includes(username))
                );
                ws.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-200) }));
                
                broadcastUserList();
                broadcastChannelList();
                broadcastGroupList();
                saveUsers();
                return;
            }
            
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
            
            if (data.type === 'message') {
                const { to, text, isImage, replyTo } = data;
                const msg = {
                    id: nextId++, from: currentUser, to, text, isImage: isImage || false,
                    replyTo: replyTo || null, time: Date.now(),
                    timeStr: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
                    status: 'sent', read: false, edited: false, deleted: false, isGroup: false, isChannel: false
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
                // Обновляем непрочитанные
                if (recipient && recipient.online) {
                    const unreadCount = messages.filter(m => m.to === recipient.username && !m.read && m.from !== recipient.username).length;
                    broadcastToUser(recipient.username, { type: 'unread_count', count: unreadCount });
                }
            }
            
            if (data.type === 'group_message') {
                const { groupId, text, isImage, replyTo } = data;
                const group = groups.get(groupId);
                if (!group || !group.members.includes(currentUser)) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Нет доступа к группе' }));
                    return;
                }
                const msg = {
                    id: nextId++, from: currentUser, to: groupId, text, isImage: isImage || false,
                    replyTo: replyTo || null, time: Date.now(),
                    timeStr: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
                    status: 'sent', read: false, edited: false, deleted: false, isGroup: true, isChannel: false
                };
                messages.push(msg);
                saveMessages();
                broadcastToGroup(groupId, { type: 'new_message', message: msg }, currentUser);
                ws.send(JSON.stringify({ type: 'new_message', message: msg }));
            }
            
            if (data.type === 'channel_message') {
                const { channelId, text, isImage, replyTo } = data;
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
                    id: nextId++, from: currentUser, to: channelId, text, isImage: isImage || false,
                    replyTo: replyTo || null, time: Date.now(),
                    timeStr: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
                    status: 'sent', read: false, edited: false, deleted: false, isGroup: false, isChannel: true
                };
                messages.push(msg);
                saveMessages();
                broadcastToChannel(channelId, { type: 'new_message', message: msg }, currentUser);
                ws.send(JSON.stringify({ type: 'new_message', message: msg }));
            }
            
            if (data.type === 'create_group') {
                const { name, members, avatar } = data;
                const groupId = 'group_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                groups.set(groupId, {
                    name, members: [currentUser, ...members], owner: currentUser, avatar: avatar || null, createdAt: Date.now()
                });
                broadcastGroupList();
                saveGroups();
                ws.send(JSON.stringify({ type: 'group_created', groupId, name }));
            }
            
            if (data.type === 'create_channel') {
                const { name, description, avatar } = data;
                const channelId = 'channel_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
                channels.set(channelId, {
                    name, description: description || '', owner: currentUser, subscribers: [currentUser], avatar: avatar || null, createdAt: Date.now()
                });
                broadcastChannelList();
                saveChannels();
                ws.send(JSON.stringify({ type: 'channel_created', channelId, name }));
            }
            
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
            
            if (data.type === 'unsubscribe_channel') {
                const { channelId } = data;
                const channel = channels.get(channelId);
                if (channel && channel.subscribers.includes(currentUser) && channel.owner !== currentUser) {
                    channel.subscribers = channel.subscribers.filter(s => s !== currentUser);
                    broadcastChannelList();
                    saveChannels();
                }
            }
            
            if (data.type === 'read') {
                const { messageId } = data;
                const msg = messages.find(m => m.id === messageId);
                if (msg && !msg.read && msg.to === currentUser) {
                    msg.read = true;
                    msg.status = 'read';
                    broadcastToUser(msg.from, { type: 'message_read', messageId });
                    saveMessages();
                    // Обновляем счётчик непрочитанных
                    const unreadCount = messages.filter(m => m.to === currentUser && !m.read).length;
                    ws.send(JSON.stringify({ type: 'unread_count', count: unreadCount }));
                }
            }
            
            if (data.type === 'edit') {
                const { messageId, newText } = data;
                const msg = messages.find(m => m.id === messageId);
                if (msg && msg.from === currentUser) {
                    msg.text = newText;
                    msg.edited = true;
                    if (msg.isChannel) {
                        broadcastToChannel(msg.to, { type: 'message_edited', messageId, newText });
                    } else if (msg.isGroup) {
                        broadcastToGroup(msg.to, { type: 'message_edited', messageId, newText });
                    } else {
                        broadcastToUser(msg.to, { type: 'message_edited', messageId, newText });
                    }
                    saveMessages();
                }
            }
            
            if (data.type === 'delete') {
                const { messageId, forEveryone } = data;
                const msg = messages.find(m => m.id === messageId);
                if (msg && (msg.from === currentUser || forEveryone)) {
                    if (forEveryone && msg.from !== currentUser) {
                        ws.send(JSON.stringify({ type: 'error', text: 'Нельзя удалить чужое сообщение' }));
                        return;
                    }
                    msg.text = '[Удалено]';
                    msg.deleted = true;
                    if (msg.isChannel) {
                        broadcastToChannel(msg.to, { type: 'message_deleted', messageId });
                    } else if (msg.isGroup) {
                        broadcastToGroup(msg.to, { type: 'message_deleted', messageId });
                    } else {
                        broadcastToUser(msg.to, { type: 'message_deleted', messageId });
                    }
                    saveMessages();
                }
            }
            
            if (data.type === 'delete_chat') {
                const { withUser } = data;
                messages = messages.filter(m => 
                    !((m.from === currentUser && m.to === withUser) || (m.from === withUser && m.to === currentUser))
                );
                saveMessages();
                ws.send(JSON.stringify({ type: 'chat_deleted', withUser }));
            }
            
            if (data.type === 'search_messages') {
                const { query } = data;
                const results = messages.filter(m => 
                    (m.from === currentUser || m.to === currentUser) && 
                    m.text.toLowerCase().includes(query.toLowerCase())
                ).slice(-50);
                ws.send(JSON.stringify({ type: 'search_results', results }));
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
