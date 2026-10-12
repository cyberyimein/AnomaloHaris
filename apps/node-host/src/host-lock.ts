import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
/** A dedicated SQLite exclusive transaction acts as an OS-released process lock.
 * It stores no application data and is never the scheduler's database.
 */
export class HostLock {
    private readonly db: DatabaseSync;
    constructor(path: string) {
        mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        try {
            this.db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
        }
        catch (error) {
            this.db.close();
            throw new Error('Another Host already owns this data directory.', { cause: error });
        }
    }
    close(): void { if (this.db.isOpen) {
        this.db.exec('ROLLBACK');
        this.db.close();
    } }
}
