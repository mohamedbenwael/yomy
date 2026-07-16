// /api/send-notifications.js
// بيتنده من سكيدولر خارجي (زي cron-job.org) كل 5-10 دقايق.
// بيقرا حالة اليوم من نفس جدول Supabase اللي التطبيق بيستخدمه، ولو فيه إشعار مستحق
// ولسه ما اتبعتش، يبعته Push حقيقي للأجهزة المشتركة — حتى لو التطبيق مقفول تمامًا.

const webpush = require('web-push');

const SB_URL = 'https://dbhfdtzvcvhpgtpyjxsw.supabase.co';
const SB_KEY = 'sb_publishable_eGCW1yPtO5hM-yAgTlcs1A_dqXrNhgR';

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const CRON_SECRET = process.env.CRON_SECRET; // اختياري بس أنصح بيه

webpush.setVapidDetails('mailto:admin@yomy-app.local', VAPID_PUBLIC, VAPID_PRIVATE);

const NOTIF_TIMES = [
  { k: 'fajr', h: 5, m: 0, prayer: 'fajr', msg: 'صلاة الفجر 🌅 — صليت؟' },
  { k: 'dhuhr', h: 13, m: 0, prayer: 'dhuhr', msg: 'صلاة الظهر 🕌 — صليت؟' },
  { k: 'asr', h: 16, m: 0, prayer: 'asr', msg: 'صلاة العصر 🕌 — صليت؟' },
  { k: 'maghrib', h: 19, m: 0, prayer: 'maghrib', msg: 'صلاة المغرب 🌇 — صليت؟' },
  { k: 'isha', h: 20, m: 30, prayer: 'isha', msg: 'صلاة العشاء 🌙 — صليت؟' },
  { k: 'water_noon', h: 14, m: 0, check: d => (d.water || 0) < 8, msg: 'متنساش تشرب مية 💧' },
  { k: 'adhkarPM', h: 17, m: 30, habit: 'adhkarPM', msg: 'أذكار المساء 🌙' },
  { k: 'pill', h: 21, m: 0, habit: 'pill', msg: 'حبة الكولشيسين 💊' },
  { k: 'review', h: 22, m: 0, msg: 'اقفل يومك في «يومي» وسجّل اللي عملته 🌿' },
];

async function sbGet(key) {
  const r = await fetch(`${SB_URL}/rest/v1/store?k=eq.${encodeURIComponent(key)}&select=v`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows.length ? rows[0].v : null;
}

async function sbSet(key, value) {
  await fetch(`${SB_URL}/rest/v1/store`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: JSON.stringify({ k: key, v: value, updated_at: new Date().toISOString() }),
  });
}

function ymdCairo(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }); // YYYY-MM-DD
}

async function fetchAladhanTimes(lat, lng, dateStr) {
  try {
    const url = `https://api.aladhan.com/v1/timings/${dateStr}?latitude=${lat}&longitude=${lng}&method=5`;
    const r = await fetch(url);
    const j = await r.json();
    const t = j.data.timings;
    const clean = s => s.split(' ')[0];
    return {
      Fajr: clean(t.Fajr), Dhuhr: clean(t.Dhuhr), Asr: clean(t.Asr),
      Maghrib: clean(t.Maghrib), Isha: clean(t.Isha),
    };
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  if (CRON_SECRET && req.query.secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(500).json({ error: 'VAPID keys not configured' });
  }

  const nowCairoStr = new Date().toLocaleString('en-US', { timeZone: 'Africa/Cairo' });
  const nowCairo = new Date(nowCairoStr);
  const h = nowCairo.getHours(), m = nowCairo.getMinutes();

  const loc = await sbGet('life:loc');
  const dstamp = ymdCairo(nowCairo);
  let TIMES = null;
  if (loc && loc.lat && loc.lng) {
    const d = new Date(nowCairo);
    const dateForApi = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    TIMES = await fetchAladhanTimes(loc.lat, loc.lng, dateForApi);
  }

  // منطق بداية اليوم عند الفجر (زي التطبيق بالظبط)
  let logicalDate = new Date(nowCairo);
  if (TIMES && TIMES.Fajr) {
    const [fh, fm] = TIMES.Fajr.split(':').map(Number);
    if (h * 60 + m < fh * 60 + fm) logicalDate.setDate(logicalDate.getDate() - 1);
  }
  const ymd = ymdCairo(logicalDate);

  const dayData = (await sbGet('life:day:' + ymd)) || { prayers: {}, habits: {}, water: 0, tasks: [] };
  const subs = (await sbGet('push:subs')) || [];

  if (!subs.length) return res.status(200).json({ sent: 0, reason: 'no subscriptions' });

  let sentCount = 0;
  const deadEndpoints = new Set();

  for (const n of NOTIF_TIMES) {
    let nh = n.h, nm = n.m;
    if (n.prayer && TIMES) {
      const cap = n.prayer.charAt(0).toUpperCase() + n.prayer.slice(1);
      if (TIMES[cap]) { const [hh, mm] = TIMES[cap].split(':').map(Number); nh = hh; nm = mm; }
    }
    const due = (h > nh || (h === nh && m >= nm)) && (h < nh + 3);
    if (!due) continue;

    const firedKey = 'notif:fired:' + ymd + ':' + n.k;
    const alreadyFired = await sbGet(firedKey);
    if (alreadyFired) continue;
    if (n.prayer && dayData.prayers && dayData.prayers[n.prayer]) continue;
    if (n.habit && dayData.habits && dayData.habits[n.habit]) continue;
    if (n.check && !n.check(dayData)) continue;

    const payload = JSON.stringify({ title: 'يومي 🌿', body: n.msg, tag: 'yomy-' + n.k });
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        // 404/410 = الاشتراك ده بايظ (المستخدم شال التطبيق مثلاً) — نشيله من القايمة
        if (err.statusCode === 404 || err.statusCode === 410) deadEndpoints.add(sub.endpoint);
      }
    }
    sentCount++;
    await sbSet(firedKey, true);
  }

  if (deadEndpoints.size) {
    const alive = subs.filter(s => !deadEndpoints.has(s.endpoint));
    await sbSet('push:subs', alive);
  }

  res.status(200).json({ checked: NOTIF_TIMES.length, sent: sentCount, subs: subs.length, removed: deadEndpoints.size });
};
