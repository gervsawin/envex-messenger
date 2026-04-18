const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const users = new Map();
let messages = [];
let nextId = 1;

try {
    const saved = JSON.parse(fs.readFileSync('./messages.json', 'utf8'));
    messages = saved;
    nextId = (messages[messages.length - 1]?.id || 0) + 1;
} catch(e) {}

const server = http.createServer((req, res) => {
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(__dirname, filePath);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('404');
        } else {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        }
    });
});

const wss = new WebSocket.Server({ server });

function broadcastToAll(data, excludeSocket = null) {
    wss.clients.forEach(client => {
        if (client !== excludeSocket && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function broadcastUserList() {
    const list = Array.from(users.entries()).map(([nick, data]) => ({
        nickname: nick,
        online: data.online,
        lastSeen: data.lastSeen
    }));
    broadcastToAll({ type: 'users', users: list });
}

function saveMessages() {
    fs.writeFileSync('./messages.json', JSON.stringify(messages), 'utf8');
}

wss.on('connection', (socket) => {
    let currentUser = null;
    
    socket.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);
            
            if (data.type === 'login') {
                const { nickname } = data;
                if (!nickname) return;
                
                currentUser = nickname;
                users.set(nickname, { socket, online: true, lastSeen: Date.now() });
                
                socket.send(JSON.stringify({ type: 'logged_in', nickname }));
                
                const userMessages = messages.filter(m => 
                    (m.from === nickname || m.to === nickname)
                );
                socket.send(JSON.stringify({ type: 'history', messages: userMessages.slice(-100) }));
                
                broadcastUserList();
            }
            
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
                    read: false
                };
                messages.push(msg);
                saveMessages();
                
                const recipient = users.get(to);
                if (recipient && recipient.socket && recipient.socket.readyState === WebSocket.OPEN) {
                    recipient.socket.send(JSON.stringify({ type: 'new_message', message: msg }));
                    msg.status = 'delivered';
                    socket.send(JSON.stringify({ type: 'new_message', message: msg }));
                } else {
                    socket.send(JSON.stringify({ type: 'new_message', message: msg }));
                }
            }
            
            if (data.type === 'read') {
                const { messageId, from } = data;
                const msg = messages.find(m => m.id === messageId);
                if (msg && msg.from === from) {
                    msg.read = true;
                    msg.status = 'read';
                    const sender = users.get(msg.from);
                    if (sender && sender.socket) {
                        sender.socket.send(JSON.stringify({ type: 'message_read', messageId }));
                    }
                    saveMessages();
                }
            }
            
            if (data.type === 'edit') {
                const { messageId, newText } = data;
                const msg = messages.find(m => m.id === messageId);
                if (msg && msg.from === currentUser) {
                    msg.text = newText;
                    msg.edited = true;
                    const recipient = users.get(msg.to);
                    if (recipient && recipient.socket) {
                        recipient.socket.send(JSON.stringify({ type: 'message_edited', messageId, newText }));
                    }
                    saveMessages();
                }
            }
            
            if (data.type === 'delete') {
                const { messageId } = data;
                const msg = messages.find(m => m.id === messageId);
                if (msg && msg.from === currentUser) {
                    msg.text = '[Удалено]';
                    msg.deleted = true;
                    const recipient = users.get(msg.to);
                    if (recipient && recipient.socket) {
                        recipient.socket.send(JSON.stringify({ type: 'message_deleted', messageId }));
                    }
                    saveMessages();
                }
            }
            
        } catch(e) { console.error(e); }
    });
    
    socket.on('close', () => {
        if (currentUser) {
            const user = users.get(currentUser);
            if (user) {
                user.online = false;
                user.lastSeen = Date.now();
            }
            broadcastUserList();
        }
    });
});

server.listen(PORT, () => {
    console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});