import { z } from 'zod';

const text = (limit: number) => z.string().trim().min(1).max(limit);
const instant = z.iso.datetime({ offset: true });

export const meetingReminderDetailsSchema = z.object({
  kind: z.literal('meeting'),
  title: text(200),
  startsAt: instant,
  endsAt: instant.optional(),
  meetingNumber: z.string().trim().max(40).regex(/^\d(?:[\d -]*\d)?$/).optional(),
  password: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('none') }).strict(),
    z.object({ kind: z.literal('provided'), value: text(100) }).strict(),
  ]).optional(),
  context: text(1500).optional(),
  unknowns: z.array(text(300)).max(6).optional(),
}).strict();

export const meetingReminderSchema = meetingReminderDetailsSchema.extend({
  ownerMentioned: z.boolean(),
  reason: text(1500),
  source: z.object({
    conversationTitle: text(200).optional(),
    senderName: text(200).optional(),
    sentAt: instant.optional(),
  }).strict(),
}).refine(value => !value.endsAt || Date.parse(value.endsAt) > Date.parse(value.startsAt));

export type MeetingReminder = z.infer<typeof meetingReminderSchema>;
