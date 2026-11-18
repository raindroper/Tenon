import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { AtSign, CalendarClock, Check, ChevronDown, Copy, MessageCircle } from 'lucide-react';
import type { MeetingReminder as MeetingReminderData } from '../../shared/reminders';
import { zonedInstant, type ZonedInstant } from '../../shared/time';
import { Markdown } from './Markdown';

const minute = 60_000;
const urgentWindow = 30 * minute;
const maximumTimeout = 2_147_483_647;

function meetingStatus(start: number, end: number | undefined, now: number): {
  text: string; tone: 'upcoming' | 'urgent' | 'ended'; next?: number;
} {
  if (end !== undefined && now >= end) return { text: '已结束', tone: 'ended' };
  const until = start - now;
  if (until <= 0) return end === undefined ? { text: '已到开始时间', tone: 'ended' }
    : { text: '进行中', tone: 'upcoming', next: end };
  if (until > urgentWindow) return { text: '待开始', tone: 'upcoming', next: start - urgentWindow };
  const minutes = Math.ceil(until / minute);
  return { text: `${minutes} 分钟后开始`, tone: 'urgent', next: start - (minutes - 1) * minute };
}

function useMeetingStatus(start: number, end?: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      const current = Date.now();
      const { next } = meetingStatus(start, end, current);
      setNow(current);
      if (next === undefined) document.removeEventListener('visibilitychange', onVisibilityChange);
      else timer = setTimeout(update, Math.min(next - current, maximumTimeout));
    };
    const onVisibilityChange = () => { if (!document.hidden) update(); };
    if (meetingStatus(start, end, Date.now()).next !== undefined) {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    update();
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [start, end]);
  return meetingStatus(start, end, now);
}

function meetingDate({ localDate }: ZonedInstant): string {
  const [year, month, day] = localDate.split('-').map(Number);
  return `${year} 年 ${month} 月 ${day} 日`;
}

function timezoneLabel(time: ZonedInstant): string {
  if (time.timezone === 'Asia/Shanghai' && time.offsetSeconds === 8 * 3600) return '北京时间';
  if (!time.offsetSeconds) return 'UTC';
  const minutes = Math.floor(Math.abs(time.offsetSeconds) / 60);
  return `UTC${time.offsetSeconds < 0 ? '−' : '+'}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function MeetingReminder({ reminder, timezone, original }: {
  reminder: MeetingReminderData; timezone: string; original: string;
}) {
  const titleId = useId();
  const number = useRef<HTMLSpanElement>(null);
  const [copyState, setCopyState] = useState<'copied' | 'selected' | 'failed'>();
  const [originalOpen, setOriginalOpen] = useState(false);
  const status = useMeetingStatus(Date.parse(reminder.startsAt), reminder.endsAt ? Date.parse(reminder.endsAt) : undefined);
  const { start, end, sent } = useMemo(() => {
    const format = (zone: string) => ({
      start: zonedInstant(reminder.startsAt, zone),
      end: reminder.endsAt ? zonedInstant(reminder.endsAt, zone) : undefined,
      sent: reminder.source.sentAt ? zonedInstant(reminder.source.sentAt, zone) : undefined,
    });
    try { return format(timezone); } catch { return format('UTC'); }
  }, [reminder.startsAt, reminder.endsAt, reminder.source.sentAt, timezone]);
  const spansDates = Boolean(end && start.localDate !== end.localDate);
  const spansOffsets = Boolean(end && start.offsetSeconds !== end.offsetSeconds);
  const source = [reminder.source.conversationTitle, reminder.source.senderName,
    sent && `${sent.localDate === start.localDate ? '' : `${meetingDate(sent)} `}${sent.localTime.slice(0, 5)}`].filter(Boolean).join(' · ');

  async function copyNumber() {
    if (!reminder.meetingNumber) return;
    try {
      await navigator.clipboard.writeText(reminder.meetingNumber);
      setCopyState('copied');
    } catch {
      const selection = window.getSelection();
      if (number.current && selection) {
        const range = document.createRange();
        range.selectNodeContents(number.current);
        selection.removeAllRanges();
        selection.addRange(range);
        setCopyState('selected');
      } else setCopyState('failed');
    }
  }

  return <section className="meeting-reminder" aria-labelledby={titleId}>
    <header className="meeting-reminder-top">
      <span className="meeting-reminder-kind"><span className="meeting-reminder-icon"><CalendarClock size={18} aria-hidden="true" /></span>会议提醒</span>
      <span className="meeting-reminder-status" data-tone={status.tone}>{status.text}</span>
    </header>
    <h2 id={titleId}>{reminder.title}</h2>
    <div className="meeting-reminder-when">
      <div className="meeting-reminder-hours">
        <span>{spansDates && <small>{meetingDate(start)}</small>}<time dateTime={start.utc}>{start.localTime.slice(0, 5)}</time>
          {spansOffsets && <small>{timezoneLabel(start)}</small>}</span>
        {end && <><span className="meeting-reminder-dash">–</span><span>{spansDates && <small>{meetingDate(end)}</small>}
          <time dateTime={end.utc}>{end.localTime.slice(0, 5)}</time>{spansOffsets && <small>{timezoneLabel(end)}</small>}</span></>}
      </div>
      {(!spansDates || !spansOffsets) && <span className="meeting-reminder-date">
        {[!spansDates && meetingDate(start), !spansOffsets && timezoneLabel(start)].filter(Boolean).join(' · ')}
      </span>}
    </div>
    {reminder.ownerMentioned && <p className="meeting-reminder-mention"><AtSign size={15} aria-hidden="true" />会议邀请里提到了你</p>}
    {(reminder.meetingNumber || reminder.password) && <div className="meeting-reminder-room">
      <div className="meeting-reminder-room-info">
        {reminder.meetingNumber && <><span>会议号</span><span className="meeting-reminder-number" ref={number}>{reminder.meetingNumber}</span></>}
        {reminder.password && <span>{reminder.password.kind === 'none' ? '无密码' : <>密码 <span className="meeting-reminder-number">{reminder.password.value}</span></>}</span>}
      </div>
      {reminder.meetingNumber && <button type="button" className="meeting-reminder-copy" onClick={() => void copyNumber()}>
        {copyState === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        {copyState === 'copied' ? '已复制' : '复制会议号'}
      </button>}
      <span role="status" className={copyState === 'selected' || copyState === 'failed' ? 'meeting-reminder-copy-hint' : 'sr-only'}>
        {copyState === 'copied' ? '会议号已复制。' : copyState === 'selected' ? '已选中会议号，可手动复制。' : copyState === 'failed' ? '未能复制，请手动选择会议号。' : ''}
      </span>
    </div>}
    <details className="meeting-reminder-details">
      <summary>查看提醒依据<ChevronDown size={15} aria-hidden="true" /></summary>
      <dl>
        <dt>{reminder.ownerMentioned ? '已确认' : '提醒原因'}</dt><dd>{reminder.reason}</dd>
        {reminder.context && <><dt>推测</dt><dd>{reminder.context}</dd></>}
        {!!reminder.unknowns?.length && <><dt>待确认</dt><dd>{reminder.unknowns.length === 1 ? reminder.unknowns[0] :
          <ul>{reminder.unknowns.map((item, index) => <li key={index}>{item}</li>)}</ul>}</dd></>}
      </dl>
      {original.trim() && <details className="meeting-reminder-original" onToggle={event => setOriginalOpen(event.currentTarget.open)}>
        <summary>查看完整提醒<ChevronDown size={14} aria-hidden="true" /></summary>
        {originalOpen && <Markdown>{original}</Markdown>}
      </details>}
    </details>
    {source && <footer className="meeting-reminder-source"><MessageCircle size={15} aria-hidden="true" /><span>{source}</span></footer>}
  </section>;
}
