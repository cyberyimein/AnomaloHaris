import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BotProfile, BotTask, BotTaskInput } from '@anomaloharis/contracts';
import { initialDue } from './automation.js';
export const BOT_CLIENT = 'local-bot';
export type BotRequest = {
    id: string;
    message: string;
    session_id: string;
    status: 'pending' | 'dispatched' | 'cancelled' | 'failed';
    run_id: string | null;
    request_json: string | null;
};
export type Occurrence = {
    id: string;
    task_id: string;
    scheduled_at: string;
    status: string;
    dispatch_key: string;
    request_json: string | null;
    run_id: string | null;
    missed_count: number;
};
export class BotStore {
    constructor(readonly db: DatabaseSync, defaultModel: string, private readonly now: () => string) {
        db.exec(`CREATE TABLE IF NOT EXISTS bot_profiles(id TEXT PRIMARY KEY,profile_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_sessions(session_id TEXT PRIMARY KEY,target_ref TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_requests(id TEXT PRIMARY KEY,message TEXT NOT NULL,session_id TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT,request_json TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS automation_tasks(id TEXT PRIMARY KEY,task_json TEXT NOT NULL,status TEXT NOT NULL,next_due_at TEXT);
      CREATE INDEX IF NOT EXISTS automation_due ON automation_tasks(status,next_due_at);
      CREATE TABLE IF NOT EXISTS automation_occurrences(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,scheduled_at TEXT NOT NULL,status TEXT NOT NULL,dispatch_key TEXT NOT NULL UNIQUE,request_json TEXT,run_id TEXT,missed_count INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS automation_work ON automation_occurrences(status,task_id);
      CREATE TABLE IF NOT EXISTS bot_results(id TEXT PRIMARY KEY,task_id TEXT,run_id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,summary TEXT NOT NULL,read_at TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bot_task_updates(run_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,state_json TEXT NOT NULL);`);
        if (!db.prepare("SELECT id FROM bot_profiles WHERE id='default'").get()) {
            const profile: BotProfile = { id: 'default', enabled: false, revision: 1, preset_model_ref: defaultModel, main_session_id: `bot_${randomUUID()}`, timezone: 'Asia/Tokyo', limits: { daily_tokens: 200000, context_window: 32000, run_timeout_ms: 600000 } };
            db.prepare('INSERT OR IGNORE INTO bot_profiles VALUES(?,?)').run('default', JSON.stringify(profile));
        }
        const profile = this.profile();
        this.ownSession(profile.main_session_id, profile.preset_model_ref);
    }
    profile(): BotProfile { return JSON.parse(String(this.db.prepare("SELECT profile_json FROM bot_profiles WHERE id='default'").get()!.profile_json)); }
    saveProfile(profile: BotProfile): void { this.db.prepare("UPDATE bot_profiles SET profile_json=? WHERE id='default'").run(JSON.stringify(profile)); }
    owns(sessionId: string): boolean { return !!this.db.prepare('SELECT session_id FROM bot_sessions WHERE session_id=?').get(sessionId); }
    ownSession(id: string, ref: string): void { this.db.prepare('INSERT OR IGNORE INTO bot_sessions VALUES(?,?)').run(id, ref); }
    requests(): BotRequest[] { return this.db.prepare('SELECT * FROM bot_requests ORDER BY created_at,rowid').all() as BotRequest[]; }
    request(id: string): BotRequest | undefined { return this.db.prepare('SELECT * FROM bot_requests WHERE id=?').get(id) as BotRequest | undefined; }
    tasks(): BotTask[] { return this.db.prepare('SELECT task_json FROM automation_tasks ORDER BY rowid DESC LIMIT 500').all().map(x => JSON.parse(String(x.task_json))); }
    dueTasks(now: string): BotTask[] {
        return this.db.prepare("SELECT task_json FROM automation_tasks WHERE status='active' AND next_due_at<=? ORDER BY next_due_at,rowid").all(now)
            .map(row => JSON.parse(String(row.task_json)) as BotTask);
    }
    countTasks(status: BotTask['status']): number {
        return Number(this.db.prepare('SELECT count(*) AS count FROM automation_tasks WHERE status=?').get(status)!.count);
    }
    workOccurrences(): Occurrence[] {
        return this.db.prepare("SELECT * FROM automation_occurrences WHERE status IN ('pending','dispatching','linked') ORDER BY rowid").all() as Occurrence[];
    }
    outstandingOccurrence(taskId: string): Occurrence | undefined {
        return this.db.prepare("SELECT * FROM automation_occurrences WHERE task_id=? AND status IN ('pending','dispatching','linked') LIMIT 1").get(taskId) as Occurrence | undefined;
    }
    occurrenceByKey(key: string): Occurrence | undefined {
        return this.db.prepare('SELECT * FROM automation_occurrences WHERE dispatch_key=?').get(key) as Occurrence | undefined;
    }
    task(id: string): BotTask | undefined { const row = this.db.prepare('SELECT task_json FROM automation_tasks WHERE id=?').get(id); return row ? JSON.parse(String(row.task_json)) : undefined; }
    createTask(input: BotTaskInput, ref: string): BotTask {
        const task: BotTask = { ...input, id: randomUUID(), revision: 1, schedule_revision: 1, status: 'active', next_due_at: initialDue(input.schedule, this.now()), target_ref: ref, state: {}, consecutive_failures: 0, created_at: this.now() };
        this.db.prepare('INSERT INTO automation_tasks VALUES(?,?,?,?)').run(task.id, JSON.stringify(task), task.status, task.next_due_at);
        return task;
    }
    saveTask(task: BotTask): void { this.db.prepare('UPDATE automation_tasks SET task_json=?,status=?,next_due_at=? WHERE id=?').run(JSON.stringify(task), task.status, task.next_due_at, task.id); }
    occurrences(taskId?: string): Occurrence[] { return this.db.prepare(`SELECT * FROM automation_occurrences ${taskId ? 'WHERE task_id=?' : ''} ORDER BY rowid DESC LIMIT 1000`).all(...(taskId ? [taskId] : [])) as Occurrence[]; }
    results(): unknown[] { return this.db.prepare('SELECT * FROM bot_results ORDER BY rowid DESC LIMIT 100').all(); }
}
