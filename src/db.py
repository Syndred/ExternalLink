"""
LinkForge DB - 外链管理数据库
SQLite 存储，支持 4 站并发共享（通过 site_id 区分）
"""

import sqlite3
import json
import os
from datetime import datetime
from pathlib import Path


DB_PATH = Path(__file__).parent.parent / "db" / "linkforge.db"


def get_connection():
    """获取数据库连接，确保 WAL 模式（支持并发读写）"""
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """初始化数据库表结构"""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = get_connection()
    cursor = conn.cursor()

    # 候选站表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS candidate_sites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT NOT NULL,
            template_id TEXT,
            platform_type TEXT DEFAULT 'unknown',
            url TEXT,
            traffic INTEGER DEFAULT 0,
            dr REAL DEFAULT 0,
            is_spam INTEGER DEFAULT 0,
            notes TEXT,
            source TEXT DEFAULT 'manual',
            first_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            last_checked_at TIMESTAMP,
            UNIQUE(domain)
        )
    """)

    # 已提交外链表
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS submitted_links (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            url TEXT NOT NULL,
            platform_type TEXT DEFAULT 'unknown',
            anchor_text TEXT,
            rel TEXT DEFAULT 'unchecked',
            traffic INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending',
            verified_at TIMESTAMP,
            submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            notes TEXT
        )
    """)

    # 提交尝试日志
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS attempt_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            platform_type TEXT,
            result TEXT NOT NULL DEFAULT 'failed',
            error_type TEXT,
            captcha_used INTEGER DEFAULT 0,
            time_spent_seconds REAL,
            notes TEXT,
            attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # 反垃圾系统识别记录
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS anti_spam_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT NOT NULL UNIQUE,
            system_type TEXT,
            is_bypassable INTEGER DEFAULT 1,
            details TEXT,
            discovered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # 已验证码记录
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS captcha_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT NOT NULL,
            captcha_type TEXT,
            solved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP
        )
    """)

    # 平台经验记录（从 Skill 文件补充的动态数据）
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS platform_experience (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            domain TEXT NOT NULL UNIQUE,
            platform_name TEXT,
            registration_method TEXT,
            link_field_name TEXT,
            captcha_type TEXT,
            default_rel TEXT,
            is_active INTEGER DEFAULT 1,
            success_rate REAL DEFAULT 0,
            known_issues TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # 创建索引
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_candidate_traffic
        ON candidate_sites(traffic DESC)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_candidate_domain
        ON candidate_sites(domain)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_submitted_site
        ON submitted_links(site_id, domain)
    """)
    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_attempt_site
        ON attempt_log(site_id, domain)
    """)

    conn.commit()
    conn.close()
    print(f"[DB] Database initialized: {DB_PATH}")


# ========== 候选站 CRUD ==========

def get_candidates(site_id: str, limit: int = 20):
    """获取候选站列表：硬过滤 spam + traffic，按已提交去重"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT * FROM candidate_sites
        WHERE is_spam = 0
          AND traffic >= 100
          AND domain NOT IN (
              SELECT DISTINCT domain FROM submitted_links WHERE site_id = ?
          )
        ORDER BY traffic DESC
        LIMIT ?
    """, (site_id, limit))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def add_candidate(domain: str, traffic: int = 0, dr: float = 0,
                  platform_type: str = 'unknown', url: str = '',
                  is_spam: int = 0, notes: str = ''):
    """添加候选站"""
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("""
            INSERT OR IGNORE INTO candidate_sites
            (domain, traffic, dr, platform_type, url, is_spam, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (domain, traffic, dr, platform_type, url, is_spam, notes))
        conn.commit()
        return cursor.lastrowid
    finally:
        conn.close()


def mark_candidate_dead(domain: str, reason: str = ''):
    """标记站点为失效/死站"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        UPDATE candidate_sites
        SET is_spam = 2, notes = notes || ' | DEAD: ' || ?
        WHERE domain = ?
    """, (reason, domain))
    conn.commit()
    conn.close()


# ========== 已提交外链 CRUD ==========

def insert_submitted_link(site_id: str, domain: str, url: str,
                           platform_type: str = 'unknown',
                           anchor_text: str = '', rel: str = 'unchecked',
                           traffic: int = 0, status: str = 'pending',
                           notes: str = ''):
    """写入已提交外链"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO submitted_links
        (site_id, domain, url, platform_type, anchor_text, rel, traffic, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (site_id, domain, url, platform_type, anchor_text, rel, traffic, status, notes))
    conn.commit()
    link_id = cursor.lastrowid
    conn.close()
    return link_id


def update_link_rel(link_id: int, rel: str, verified: bool = True):
    """更新链接的 rel 属性"""
    conn = get_connection()
    cursor = conn.cursor()
    if verified:
        cursor.execute("""
            UPDATE submitted_links
            SET rel = ?, verified_at = datetime('now')
            WHERE id = ?
        """, (rel, link_id))
    else:
        cursor.execute("""
            UPDATE submitted_links SET rel = ? WHERE id = ?
        """, (rel, link_id))
    conn.commit()
    conn.close()


def get_submitted_count(site_id: str):
    """获取某站已提交数量"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) as cnt FROM submitted_links WHERE site_id = ?", (site_id,))
    count = cursor.fetchone()['cnt']
    cursor.execute("""
        SELECT COUNT(*) as cnt FROM submitted_links
        WHERE site_id = ? AND rel = 'dofollow'
    """, (site_id,))
    dofollow = cursor.fetchone()['cnt']
    conn.close()
    return count, dofollow


def get_domain_submitted_sites(domain: str):
    """检查某域名是否已被任何站提交过"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT site_id, submitted_at FROM submitted_links
        WHERE domain = ?
    """, (domain,))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


# ========== 提交日志 ==========

def log_attempt(site_id: str, domain: str, result: str,
                platform_type: str = 'unknown', error_type: str = '',
                captcha_used: int = 0, time_spent: float = 0,
                notes: str = ''):
    """记录提交尝试"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO attempt_log
        (site_id, domain, platform_type, result, error_type, captcha_used, time_spent_seconds, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (site_id, domain, platform_type, result, error_type, captcha_used, time_spent, notes))
    conn.commit()
    conn.close()


# ========== 反垃圾记录 ==========

def log_anti_spam(domain: str, system_type: str, is_bypassable: bool = True,
                  details: str = ''):
    """记录某站的反垃圾系统类型"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT OR REPLACE INTO anti_spam_log
        (domain, system_type, is_bypassable, details)
        VALUES (?, ?, ?, ?)
    """, (domain, system_type, 1 if is_bypassable else 0, details))
    conn.commit()
    conn.close()


def get_anti_spam_info(domain: str):
    """查询某站的反垃圾系统信息"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM anti_spam_log WHERE domain = ?", (domain,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


# ========== 统计 ==========

def get_stats(site_id: str = None):
    """获取统计数据"""
    conn = get_connection()
    cursor = conn.cursor()

    where = "WHERE site_id = ?" if site_id else ""
    params = (site_id,) if site_id else ()

    cursor.execute(f"""
        SELECT
            COUNT(*) as total,
            SUM(CASE WHEN rel = 'dofollow' THEN 1 ELSE 0 END) as dofollow,
            SUM(CASE WHEN rel = 'dofollow' THEN 0 ELSE 1 END) as nofollow,
            COUNT(DISTINCT domain) as unique_domains
        FROM submitted_links {where}
    """, params)
    stats = dict(cursor.fetchone())

    cursor.execute(f"""
        SELECT platform_type, COUNT(*) as cnt
        FROM submitted_links {where}
        GROUP BY platform_type
        ORDER BY cnt DESC
    """, params)
    stats['by_platform'] = [dict(r) for r in cursor.fetchall()]

    conn.close()
    return stats


if __name__ == '__main__':
    init_db()
    print("[DB] Database ready")
