import { Type, type Static } from '@sinclair/typebox';
const boundedText = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const revision = Type.Integer({ minimum: 1 });
export const BotScheduleSchema = Type.Union([
    Type.Object({ type: Type.Literal('once'), at: boundedText(64), expiresAt: Type.Optional(boundedText(64)) }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal('interval'), everySeconds: Type.Integer({ minimum: 60, maximum: 31536000 }), anchorAt: boundedText(64) }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal('calendar'), localTime: Type.String({ pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' }), timezone: boundedText(100), weekdays: Type.Optional(Type.Array(Type.Integer({ minimum: 1, maximum: 7 }), { minItems: 1, maxItems: 7, uniqueItems: true })) }, { additionalProperties: false }),
]);
export type BotSchedule = Static<typeof BotScheduleSchema>;
export const BotSettingsSchema = Type.Object({
    expected_revision: revision, enabled: Type.Optional(Type.Boolean()), preset_model_ref: Type.Optional(boundedText(200)), timezone: Type.Optional(boundedText(100)),
    limits: Type.Optional(Type.Object({ daily_tokens: Type.Optional(Type.Integer({ minimum: 1000, maximum: 10000000 })), context_window: Type.Optional(Type.Integer({ minimum: 4096, maximum: 1000000 })), run_timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: 3600000 })) }, { additionalProperties: false })),
}, { additionalProperties: false });
export type BotSettings = Static<typeof BotSettingsSchema>;
export const BotMessageSchema = Type.Object({ request_id: boundedText(200), message: boundedText(100000) }, { additionalProperties: false });
export const BotTaskSchema = Type.Object({ title: boundedText(200), prompt: boundedText(20000), schedule: BotScheduleSchema, session_policy: Type.Optional(Type.Union([Type.Literal('fresh'), Type.Literal('persistent')])) }, { additionalProperties: false });
export type BotTaskInput = Static<typeof BotTaskSchema>;
export const BotTaskPatchSchema = Type.Object({ expected_revision: revision, title: Type.Optional(boundedText(200)), prompt: Type.Optional(boundedText(20000)), schedule: Type.Optional(BotScheduleSchema), status: Type.Optional(Type.Union(['active', 'paused', 'cancelled'].map(x => Type.Literal(x)))) }, { additionalProperties: false });
export const BotMemorySchema = Type.Object({ content: boundedText(8000), scope: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('agent'), Type.Literal('project')])), category: Type.Optional(boundedText(100)) }, { additionalProperties: false });
export type BotMemoryInput = Static<typeof BotMemorySchema>;
export const BotMemoryPatchSchema = Type.Object({ expected_revision: revision, content: Type.Optional(boundedText(8000)), status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('inactive')])) }, { additionalProperties: false });
export const BotRequestIdSchema = Type.Object({ request_id: boundedText(200) }, { additionalProperties: false });
export type BotProfile = {
    id: 'default';
    enabled: boolean;
    revision: number;
    preset_model_ref: string;
    main_session_id: string;
    timezone: string;
    limits: {
        daily_tokens: number;
        context_window: number;
        run_timeout_ms: number;
    };
};
export type BotTask = BotTaskInput & {
    id: string;
    revision: number;
    schedule_revision: number;
    status: 'active' | 'paused' | 'waiting_user' | 'completed' | 'cancelled';
    next_due_at: string | null;
    target_ref: string;
    state: Record<string, unknown>;
    consecutive_failures: number;
    created_at: string;
};
export type BotMemory = {
    id: string;
    content: string;
    scope: 'user' | 'agent' | 'project';
    scope_id: string;
    category: string;
    status: 'active' | 'inactive';
    revision: number;
    source: Record<string, unknown>;
    created_at: string;
    updated_at: string;
};
export const BotLocalTimeSchema = Type.Object({ local_time: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?$' }), timezone: boundedText(100) }, { additionalProperties: false });
export const BotTaskResumeSchema = Type.Object({ request_id: boundedText(200), run_id: boundedText(200) }, { additionalProperties: false });
