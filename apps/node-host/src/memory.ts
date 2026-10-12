import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BotMemory, BotMemoryInput } from '@anomaloharis/contracts';
import { RunControlError } from './run-control.js';
export class MemoryStore {
    constructor(readonly db: DatabaseSync, private readonly projectId = 'workspace', private readonly now = () => new Date().toISOString()) {
        db.exec(`CREATE TABLE IF NOT EXISTS bot_memories(id TEXT PRIMARY KEY,content TEXT NOT NULL,scope TEXT NOT NULL,scope_id TEXT NOT NULL,category TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,source_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS bot_memory_scope ON bot_memories(scope,scope_id,status);
      CREATE TABLE IF NOT EXISTS bot_memory_changes(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,created_at TEXT NOT NULL);`);
    }
    list(includeInactive = true): BotMemory[] {
        return (this.db.prepare(`SELECT * FROM bot_memories ${includeInactive ? '' : "WHERE status='active'"} ORDER BY updated_at DESC,id LIMIT 500`).all() as Array<Record<string, unknown>>).map(row => ({ id: String(row.id), content: String(row.content), scope: row.scope as BotMemory['scope'], scope_id: String(row.scope_id), category: String(row.category), status: row.status as BotMemory['status'], revision: Number(row.revision), source: JSON.parse(String(row.source_json)), created_at: String(row.created_at), updated_at: String(row.updated_at) }));
    }
    write(input: BotMemoryInput, source: Record<string, unknown>): BotMemory {
        const item: BotMemory = { id: randomUUID(), content: input.content.trim(), scope: input.scope ?? 'user', scope_id: (input.scope === 'project' ? this.projectId : 'default'), category: input.category ?? 'general', status: 'active', revision: 1, source, created_at: this.now(), updated_at: this.now() };
        if (!item.content)
            throw new RunControlError(400, 'memory_empty', 'Memory must not be empty.');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare('INSERT INTO bot_memories VALUES(?,?,?,?,?,?,?,?,?,?)').run(item.id, item.content, item.scope, item.scope_id, item.category, item.status, item.revision, JSON.stringify(source), item.created_at, item.updated_at);
            this.log(null, item);
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        return item;
    }
    update(id: string, revision: number, patch: {
        content?: string;
        status?: 'active' | 'inactive';
    }, source?: Record<string, unknown>): BotMemory {
        const before = this.list().find(x => x.id === id);
        if (!before)
            throw new RunControlError(404, 'memory_not_found', 'Memory not found.');
        if (before.revision !== revision)
            throw new RunControlError(409, 'memory_revision_conflict', 'Memory revision has changed.');
        const after = { ...before, ...patch, revision: revision + 1, updated_at: this.now(), source: source ?? before.source };
        if (!after.content.trim())
            throw new RunControlError(400, 'memory_empty', 'Memory must not be empty.');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const changed = this.db.prepare('UPDATE bot_memories SET content=?,status=?,revision=?,source_json=?,updated_at=? WHERE id=? AND revision=?').run(after.content, after.status, after.revision, JSON.stringify(after.source), after.updated_at, id, revision);
            if (!changed.changes)
                throw new RunControlError(409, 'memory_revision_conflict', 'Memory revision has changed.');
            this.log(before, after);
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
        return after;
    }
    search(query: string, limit = 12): BotMemory[] {
        const q = tokens(query);
        return this.list(false).filter(x => x.scope !== 'project' || x.scope_id === this.projectId).map(item => ({ item, score: [...tokens(item.content)].filter(x => q.has(x)).length })).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.item);
    }
    context(query: string): string {
        const selected = new Map(this.search(query).map(x => [x.id, x]));
        for (const item of this.list(false).filter(x => x.scope === 'user').slice(0, 5))
            selected.set(item.id, item);
        return [...selected.values()].map(x => `[${x.id}; ${x.scope}; ${x.source.type}] ${x.content}`).join('\n').slice(0, 12000);
    }
    history(id: string): unknown[] { return this.db.prepare('SELECT * FROM bot_memory_changes WHERE memory_id=? ORDER BY created_at,rowid').all(id); }
    private log(before: BotMemory | null, after: BotMemory) { this.db.prepare('INSERT INTO bot_memory_changes VALUES(?,?,?,?,?)').run(randomUUID(), after.id, before ? JSON.stringify(before) : null, JSON.stringify(after), this.now()); }
}
function tokens(text: string): Set<string> {
    const words: string[] = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    for (const part of text.match(/[\u3400-\u9fff]+/g) ?? []) {
        for (let i = 0; i < part.length - 1; i++)
            words.push(part.slice(i, i + 2));
        if (part.length === 1)
            words.push(part);
    }
    return new Set(words);
}
