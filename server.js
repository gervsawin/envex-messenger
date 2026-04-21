const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;

// ============ SUPABASE ============
const supabaseUrl = 'https://jqpvblwydzxapfwqucbn.supabase.co';
const supabaseKey = 'sb_publishable_tO9Ph8N7m_ZbCi-ajZqSwA_qyL3wvny';
const supabase = createClient(supabaseUrl, supabaseKey);

// ============ EXPRESS ============
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(__dirname));
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'messenger.html'));
});

const activeUsers = new Map();

async function broadcastToAll(data, excludeWs = null) {
    for (const [username, ws] of activeUsers) {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    }
}

async function broadcastUserList() {
    const { data: users } = await supabase
        .from('users')
        .select('username, name, avatar, online, last_seen');
    
    broadcastToAll({ type: 'users', users: users || [] });
}

wss.on('connection', (ws) => {
    let currentUser = null;
    
    ws.on('message', async (raw) => {
        try {
            const data = JSON.parse(raw);
            
            if (data.type === 'register') {
                const { username, name, avatar } = data;
                
                if (!username.startsWith('@')) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Username должен начинаться с @' }));
                    return;
                }
                
                const { data: existing } = await supabase
                    .from('users')
                    .select('username')
                    .eq('username', username)
                    .single();
                
                if (existing) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Пользователь уже существует' }));
                    return;
                }
                
                await supabase.from('users').insert([{
                    username: username,
                    name: name || username.substring(1),
                    avatar: avatar || null,
                    online: true,
                    last_seen: new Date(),
                    created_at: new Date()
                }]);
                
                currentUser = username;
                activeUsers.set(username, ws);
                
                ws.send(JSON.stringify({ type: 'registered', username, name: name || username.substring(1), avatar }));
                
                const { data: messages } = await supabase
                    .from('messages')
                    .select('*')
                    .or(`from_user.eq.${username},to_user.eq.${username}`)
                    .order('created_at', { ascending: true })
                    .limit(200);
                
                ws.send(JSON.stringify({ type: 'history', messages: messages || [] }));
                
                const { data: posts } = await supabase
                    .from('posts')
                    .select('*')
                    .order('created_at', { ascending: false })
                    .limit(50);
                
                ws.send(JSON.stringify({ type: 'posts', posts: posts || [] }));
                
                await broadcastUserList();
                return;
            }
            
            if (data.type === 'login') {
                const { username } = data;
                
                const { data: user } = await supabase
                    .from('users')
                    .select('*')
                    .eq('username', username)
                    .single();
                
                if (!user) {
                    ws.send(JSON.stringify({ type: 'error', text: 'Пользователь не найден' }));
                    return;
                }
                
                currentUser = username;
                activeUsers.set(username, ws);
                
                await supabase
                    .from('users')
                    .update({ online: true, last_seen: new Date() })
                    .eq('username', username);
                
                ws.send(JSON.stringify({ type: 'logged_in', username, name: user.name, avatar: user.avatar }));
                
                const { data: messages } = await supabase
                    .from('messages')
                    .select('*')
                    .or(`from_user.eq.${username},to_user.eq.${username}`)
                    .order('created_at', { ascending: true })
                    .limit(200);
                
                ws.send(JSON.stringify({ type: 'history', messages: messages || [] }));
                
                const { data: posts } = await supabase
                    .from('posts')
                    .select('*')
                    .order('created_at', { ascending: false })
                    .limit(50);
                
                ws.send(JSON.stringify({ type: 'posts', posts: posts || [] }));
                
                await broadcastUserList();
                return;
            }
            
            if (data.type === 'update_profile') {
                const { name, avatar } = data;
                const updateData = {};
                if (name) updateData.name = name;
                if (avatar) updateData.avatar = avatar;
                
                await supabase.from('users').update(updateData).eq('username', currentUser);
                ws.send(JSON.stringify({ type: 'profile_updated', name, avatar }));
                await broadcastUserList();
                return;
            }
            
            if (data.type === 'message') {
                const { to, text, isImage } = data;
                
                const { data: savedMsg } = await supabase
                    .from('messages')
                    .insert([{
                        from_user: currentUser,
                        to_user: to,
                        text: text,
                        is_image: isImage || false,
                        created_at: new Date(),
                        read: false
                    }])
                    .select();
                
                const msg = {
                    id: savedMsg?.[0]?.id,
                    from: currentUser,
                    to: to,
                    text: text,
                    isImage: isImage || false,
                    time: new Date(),
                    timeStr: new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
                    status: 'sent'
                };
                
                const recipientWs = activeUsers.get(to);
                if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
                    recipientWs.send(JSON.stringify({ type: 'new_message', message: { ...msg, status: 'delivered' } }));
                }
                
                ws.send(JSON.stringify({ type: 'new_message', message: msg }));
                return;
            }
            
            if (data.type === 'new_post') {
                const { text, isImage } = data;
                
                const { data: user } = await supabase
                    .from('users')
                    .select('name, avatar')
                    .eq('username', currentUser)
                    .single();
                
                const { data: post } = await supabase
                    .from('posts')
                    .insert([{
                        author: currentUser,
                        text: text,
                        is_image: isImage || false,
                        created_at: new Date(),
                        likes: 0
                    }])
                    .select();
                
                const newPost = {
                    id: post?.[0]?.id,
                    author: currentUser,
                    authorName: user?.name,
                    authorAvatar: user?.avatar,
                    text: text,
                    isImage: isImage || false,
                    time: new Date(),
                    timeStr: new Date().toLocaleString(),
                    likes: 0,
                    comments: 0
                };
                
                broadcastToAll({ type: 'new_post', post: newPost });
                return;
            }
            
            if (data.type === 'read') {
                const { messageId } = data;
                
                await supabase.from('messages').update({ read: true }).eq('id', messageId);
                
                const { data: msg } = await supabase
                    .from('messages')
                    .select('from_user')
                    .eq('id', messageId)
                    .single();
                
                if (msg) {
                    const senderWs = activeUsers.get(msg.from_user);
                    if (senderWs) {
                        senderWs.send(JSON.stringify({ type: 'message_read', messageId }));
                    }
                }
                return;
            }
            
        } catch(e) { console.error(e); }
    });
    
    ws.on('close', async () => {
        if (currentUser) {
            activeUsers.delete(currentUser);
            await supabase.from('users').update({ online: false, last_seen: new Date() }).eq('username', currentUser);
            await broadcastUserList();
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер: http://localhost:${PORT}`);
});
