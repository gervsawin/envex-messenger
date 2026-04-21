ь-- Таблица пользователей
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    online BOOLEAN DEFAULT false,
    last_seen TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Таблица сообщений
CREATE TABLE IF NOT EXISTS messages (
    id BIGSERIAL PRIMARY KEY,
    from_user TEXT NOT NULL,
    to_user TEXT NOT NULL,
    text TEXT,
    is_image BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    read BOOLEAN DEFAULT false
);

-- Таблица постов
CREATE TABLE IF NOT EXISTS posts (
    id BIGSERIAL PRIMARY KEY,
    author TEXT NOT NULL,
    text TEXT,
    is_image BOOLEAN DEFAULT false,
    likes INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);
