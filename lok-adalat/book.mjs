// Books a Delhi Digital Traffic Lok Adalat appointment for each vehicle the
// moment the portal opens its daily booking window (10:00 AM server time).
//
// A person still answers two things, because the portal requires it:
//   1. the 6-character verification code (can be done before 10:00)
//   2. the 4-digit OTP sent to the mobile registered with each vehicle's RC
// Everything else (court, session, undertaking, submit, receipt) is automatic.
//
// Two ways to run:
//   Local:    npm run book     — Chrome windows open, you type in them.
//   Telegram: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID — runs headless
//             (e.g. on Render); the bot sends you each code picture and asks
//             for the OTPs, and you reply in Telegram. OTPs can also arrive
//             by SMS forwarded from the owner's phone to POST /sms.
//
// Settings come from environment variables (or a local .env file):
//   VEHICLES=DL1AB1234,HR26XY5678   COURT="Rohini Courts"
//   AFTERNOON_FALLBACK=1            take After Noon if Fore Noon can't fit
//   PREPARE_AT=09:45:00             Telegram mode: when to send the codes
//   SMS_WEBHOOK_KEY=<secret>        enables POST /sms?key=<secret> for OTP SMS
//   PORT                            set by Render: serves a tiny status page
// Flags: --dry-run (open the portal, book nothing), --afternoon-fallback,
//        --now (Telegram mode: start straight away instead of at PREPARE_AT).

import { chromium } from 'playwright';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const args = new Set(process.argv.slice(2));
const VEHICLES = (process.env.VEHICLES || '').split(',').map((v) => v.trim().toUpperCase()).filter(Boolean);
const COURT = process.env.COURT || 'Rohini Courts';
const AFTERNOON_FALLBACK = args.has('--afternoon-fallback') || process.env.AFTERNOON_FALLBACK === '1';
const DRY_RUN = args.has('--dry-run');
const PREPARE_AT = process.env.PREPARE_AT || '09:45:00';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM = Boolean(TG_TOKEN);
const TG_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const START_NOW = args.has('--now');
const SMS_KEY = process.env.SMS_WEBHOOK_KEY || '';

const SESSIONS = { '0': 'Fore Noon', '1': 'After Noon' };
const PORTAL = 'https://traffic.delhipolice.gov.in/lokadalat/';
const API = 'https://traffic.delhipolice.gov.in/api-lokadalat-dtp/';
const DAILY_LIMIT = 50000;
const OPENS_AT = '10:00:00';
const GIVE_UP_AT = '13:00:00'; // stop retrying Search after this (server time)

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RECEIPTS = TELEGRAM ? path.join(os.tmpdir(), 'receipts') : path.join(HERE, 'receipts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' });
const log = (vehicle, msg) => console.log(`[${stamp()}] ${vehicle.padEnd(10)} ${msg}`);

// ---- Telegram ----------------------------------------------------------------

async function tg(method, body) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${TG_API}/bot${TG_TOKEN}/${method}`, {
    method: 'POST',
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
    body: isForm ? body : JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

async function tgSend(text) {
  if (!TELEGRAM || !TG_CHAT) return null;
  return tg('sendMessage', { chat_id: TG_CHAT, text }).catch((e) => console.log(e.message));
}

async function tgFile(method, field, file, caption) {
  if (!TELEGRAM || !TG_CHAT) return null;
  const form = new FormData();
  form.append('chat_id', TG_CHAT);
  if (caption) form.append('caption', caption);
  form.append(field, new Blob([fs.readFileSync(file)]), path.basename(file));
  return tg(method, form).catch((e) => console.log(e.message));
}

// Log locally and, in Telegram mode, tell the person too.
async function say(vehicle, msg) {
  log(vehicle, msg);
  await tgSend(vehicle ? `${vehicle}: ${msg}` : msg);
}

// Questions waiting for an answer, from a Telegram reply or a forwarded SMS.
const waiting = []; // { msgId, vehicle, kind: 'code' | 'otp', resolve }
const KIND_NAMES = { code: 'verification code', otp: 'OTP' };

function ask(vehicle, kind, sendQuestion) {
  return new Promise(async (resolve) => {
    const msg = await sendQuestion();
    waiting.push({ msgId: msg?.message_id, vehicle, kind, resolve });
  });
}

const compact = (text) => text.toUpperCase().replace(/[^A-Z0-9]/g, '');

// Pulls the answer out of free text: "abc123", "DL1AB1234 abc123", or a whole
// forwarded SMS such as "Your OTP for Lok Adalat is 1234".
function extract(kind, text) {
  let t = text;
  // Drop vehicle numbers first: their last four digits look like an OTP.
  for (const v of VEHICLES) t = t.replace(new RegExp(v.split('').join('[\\s-]*'), 'ig'), ' ');
  if (kind === 'code') {
    const words = t.split(/[^0-9a-z]+/i).filter((w) => /^[0-9a-z]{6}$/i.test(w));
    return words.length === 1 ? words[0] : null;
  }
  const near = t.match(/OTP\D{0,40}?(?<!\d)(\d{4})(?!\d)/i) || t.match(/(?<!\d)(\d{4})(?!\d)\D{0,40}?OTP/i);
  if (near) return near[1];
  const all = t.match(/(?<!\d)\d{4}(?!\d)/g) || [];
  return all.length === 1 ? all[0] : null;
}

// Hands an answer to the question it belongs to: the message it replies to,
// the vehicle it names, or the only question it can answer.
function deliver(text, replyTo, source) {
  let w = replyTo && waiting.find((x) => x.msgId === replyTo);
  if (!w) {
    const named = waiting.filter((x) => compact(text).includes(x.vehicle));
    const fitting = waiting.filter((x) => extract(x.kind, text));
    if (named.length === 1) w = named[0];
    else if (waiting.length === 1) w = waiting[0];
    else if (fitting.length === 1) w = fitting[0];
  }
  if (!w) {
    return {
      ok: false,
      msg: waiting.length
        ? `${source === 'sms' ? 'Got an SMS but several' : 'Several'} questions are open (${waiting.map((x) => `${x.vehicle} ${KIND_NAMES[x.kind]}`).join(', ')}). Reply to the message it belongs to, or send "VEHICLE ANSWER".`
        : 'Nothing is waiting for an answer right now. Send /status to see where things are.',
    };
  }
  const value = extract(w.kind, text);
  if (!value) return { ok: false, msg: `${w.vehicle}: that doesn't look like a ${KIND_NAMES[w.kind]}. Send it again.` };
  waiting.splice(waiting.indexOf(w), 1);
  w.resolve(value);
  return { ok: true, msg: source === 'sms' ? `${w.vehicle}: OTP received by SMS, verifying.` : '' };
}

async function handleMessage(m) {
  const chat = String(m.chat.id);
  const text = (m.text || '').trim();
  if (!TG_CHAT || chat !== TG_CHAT) {
    // Only the configured chat may drive the bot; anyone else just learns their id.
    await tg('sendMessage', { chat_id: chat, text: `This bot is private. Your chat id is ${chat}.` }).catch(() => {});
    if (!TG_CHAT) console.log(`Telegram chat id ${chat} wrote "${text}". Set TELEGRAM_CHAT_ID=${chat}.`);
    return;
  }
  if (text === '/status' || text === '/start') {
    const s = await serverStatus().catch((e) => ({ error: e.message }));
    const pend = waiting.map((w) => `${w.vehicle} ${KIND_NAMES[w.kind]}`).join(', ') || 'nothing';
    await tgSend(
      s.error
        ? `Portal unreachable: ${s.error}`
        : `Lok Adalat ${s.laDate}. Server time ${s.date} ${s.time}. Used today ${s.count}/${DAILY_LIMIT} (${windowState(s)}).\nVehicles: ${VEHICLES.join(', ')} → ${COURT}.\nWaiting for: ${pend}`,
    );
    return;
  }
  const { msg } = deliver(text, m.reply_to_message?.message_id, 'telegram');
  if (msg) await tgSend(msg);
}

async function pollTelegram() {
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) await handleMessage(u.message).catch((e) => console.log(`telegram: ${e.message}`));
      }
    } catch (e) {
      console.log(`telegram poll: ${e.message}`);
      await sleep(3000);
    }
  }
}

// ---- server clock / booking window -----------------------------------------

async function serverStatus() {
  const res = await fetch(API + 'authenticate/totalCount-user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.json();
  const [date, time] = body.apiMessage.timeStamp.split(' '); // server time, IST
  return { date, time, laDate: body.data.laDate, count: body.data.TotalData };
}

function addDays(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Mirrors the portal's own check: bookings run from (laDate - 6) to the day
// before laDate, from 10:00 AM, until 50,000 notices/challans are taken.
function windowState(s) {
  const first = addDays(s.laDate, -6);
  if (s.date >= s.laDate) return 'closed';
  if (s.date < first) return 'not-yet';
  if (s.time < OPENS_AT) return 'before-10';
  if (s.count >= DAILY_LIMIT) return 'quota-full';
  return 'open';
}

async function safeStatus() {
  for (let failures = 1; ; failures++) {
    try {
      return await serverStatus();
    } catch (e) {
      console.log(`[${stamp()}] server status failed (${e.message}), retrying`);
      // Government sites sometimes block servers outside India; say so early.
      if (failures === 3) await tgSend(`Can't reach the Lok Adalat portal from this server: ${e.message}. Still retrying.`);
      await sleep(2000);
    }
  }
}

// Telegram mode runs unattended, so it sleeps until PREPARE_AT on a booking
// day before opening the portal and asking for codes.
async function waitForPrepareTime() {
  let lastNote = 0;
  let checkedIn = '';
  for (;;) {
    const s = await safeStatus();
    const state = windowState(s);
    if (state === 'closed') return null;
    // A 9:30 check-in on booking days, so a silent bot means it went to sleep.
    if (state === 'before-10' && s.time >= '09:30:00' && checkedIn !== s.date) {
      checkedIn = s.date;
      await tgSend(`Awake and ready. Code pictures come at ${PREPARE_AT}; booking opens at ${OPENS_AT}.`);
    }
    const ready =
      (state === 'before-10' && s.time >= PREPARE_AT) ||
      state === 'open' ||
      (state === 'quota-full' && s.time < GIVE_UP_AT);
    if (ready) return s;
    if (Date.now() - lastNote > 30 * 60000) {
      console.log(`[${stamp()}] sleeping — server ${s.date} ${s.time} (${state}); will start at ${PREPARE_AT} on a booking day`);
      lastNote = Date.now();
    }
    await sleep(state === 'before-10' && s.time >= '09:30:00' ? 5000 : 60000);
  }
}

async function waitForOpening() {
  let lastNote = 0;
  for (;;) {
    const s = await safeStatus();
    const state = windowState(s);
    if (state === 'open') {
      console.log(`[${stamp()}] OPEN — server time ${s.date} ${s.time}, used ${s.count}/${DAILY_LIMIT}`);
      return s;
    }
    if (state === 'closed') throw new Error(`Lok Adalat of ${s.laDate} is over; no more bookings.`);
    if (state === 'not-yet') throw new Error(`Booking for ${s.laDate} opens on ${addDays(s.laDate, -6)}.`);
    if (state === 'quota-full' && s.time >= GIVE_UP_AT) {
      throw new Error(`Today's ${DAILY_LIMIT} limit is used up. Run again tomorrow before 10 AM.`);
    }
    if (Date.now() - lastNote > 30000) {
      const why = state === 'before-10' ? `opens at ${OPENS_AT}` : `today's quota is full (${s.count})`;
      console.log(`[${stamp()}] waiting — server time ${s.time}, ${why}, Lok Adalat on ${s.laDate}`);
      lastNote = Date.now();
    }
    // Poll gently until the last two minutes, then tightly.
    const nearlyTime = state === 'before-10' && s.time >= '09:58:00';
    await sleep(nearlyTime || state === 'quota-full' ? 400 : 15000);
  }
}

// ---- one browser context per vehicle -----------------------------------------

// Each vehicle gets its own browser context: the portal keeps the logged-in
// vehicle and token in localStorage, so two tabs in one context would clash.
async function openWindow(browser, vehicle) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const page = await context.newPage();
  const s = { vehicle, context, page, lastAlert: null, availability: null };
  page.on('dialog', async (d) => {
    s.lastAlert = d.message();
    log(vehicle, `portal says: ${d.message()}`);
    await d.accept().catch(() => {});
  });
  // Free places per court room, which the booking page loads by itself.
  page.on('response', async (r) => {
    if (r.url().includes('courtavailability-check')) s.availability = (await r.json().catch(() => null))?.data;
  });
  await page.goto(PORTAL, { waitUntil: 'networkidle' });
  await page.locator('#vehicle').fill(vehicle);
  await page.locator(CAPTCHA).focus();
  return s;
}

const CAPTCHA = 'input[name="matchvalue"]';
const SEARCH = 'input[type="submit"][value="Search"]';
const OTP = '#OTP';
const VERIFY = 'input[type="submit"][value="VERIFY"]';

async function fieldLength(page, selector) {
  return page.evaluate((sel) => document.querySelector(sel)?.value?.length ?? -1, selector);
}

async function waitForTyped(s, selector, length, prompt) {
  let told = false;
  while ((await fieldLength(s.page, selector)) !== length) {
    if (!told) { log(s.vehicle, prompt); told = true; }
    await sleep(250);
  }
}

// Gets the verification code typed into the portal: by the person in the
// window (local), or from their Telegram reply to a picture of the code.
async function enterCode(s) {
  if (!TELEGRAM) {
    await waitForTyped(s, CAPTCHA, 6, `type the 6-character verification code shown in the ${s.vehicle} window`);
    return;
  }
  if ((await fieldLength(s.page, CAPTCHA)) === 6) return;
  fs.mkdirSync(RECEIPTS, { recursive: true });
  const pic = path.join(RECEIPTS, `${s.vehicle}-code.png`);
  await s.page.locator('.captchaimg').screenshot({ path: pic });
  const code = await ask(s.vehicle, 'code', () =>
    tgFile('sendPhoto', 'photo', pic, `${s.vehicle}: reply to this with the 6-character code in the picture`),
  );
  await s.page.locator(CAPTCHA).fill(code.toLowerCase()); // the portal's codes are lower case
  log(s.vehicle, 'verification code entered');
}

async function enterOtp(s, hint) {
  if (!TELEGRAM) {
    await waitForTyped(s, OTP, 4, `type the 4-digit OTP sent to the RC-registered mobile for ${s.vehicle}`);
    return;
  }
  const otp = await ask(s.vehicle, 'otp', () =>
    tgSend(
      `OTP needed for vehicle ending ${s.vehicle.slice(-4)} (${s.vehicle}). ` +
        `It was just sent to the mobile registered on this RC. Reply with the 4 digits.${hint ? `\nPortal: ${hint}` : ''}`,
    ),
  );
  await s.page.locator(OTP).fill(otp);
}

async function pageMessages(page) {
  return page.evaluate(() => ({
    otpShown: !!document.querySelector('#OTP'),
    info: document.querySelector('p.success')?.innerText?.trim() || '',
    error: [...document.querySelectorAll('p.success1, .alert1 p')]
      .map((p) => p.innerText.trim())
      .filter(Boolean)
      .join(' | '),
  }));
}

// Clicks Search (which sends the OTP), retrying while the portal says it is
// not open yet or the quota is full. Returns the portal's message, or null if
// this vehicle can't go on.
async function requestOtp(s) {
  for (;;) {
    await enterCode(s);
    s.lastAlert = null;
    await s.page.locator(SEARCH).click();

    const until = Date.now() + 20000;
    let outcome = 'timeout';
    let m;
    while (Date.now() < until) {
      m = await pageMessages(s.page);
      if (m.otpShown) { outcome = 'otp'; break; }
      if (s.lastAlert) { outcome = 'alert'; break; }
      if (/invalid captcha/i.test(m.error)) { outcome = 'captcha'; break; }
      if (m.error) { outcome = 'error'; break; }
      if (m.info) { outcome = 'info'; break; }
      await sleep(200);
    }

    if (outcome === 'otp') { log(s.vehicle, `OTP requested. ${m.info}`); return m.info || ''; }
    if (outcome === 'captcha') { await say(s.vehicle, 'verification code was wrong; a new one is coming'); continue; }
    if (outcome === 'alert') {
      if (/limit|before 10/i.test(s.lastAlert)) {
        const st = await serverStatus().catch(() => null);
        if (st && st.time >= GIVE_UP_AT) { await say(s.vehicle, `giving up for today: ${s.lastAlert}`); return null; }
        await sleep(1500);
        continue; // the code stays filled in, so this retries straight away
      }
      await say(s.vehicle, `stopped: ${s.lastAlert}`);
      return null;
    }
    if (outcome === 'info') { await say(s.vehicle, `no OTP form appeared. Portal said: ${m.info}`); return null; }
    if (outcome === 'error') { await say(s.vehicle, `portal error: ${m.error}`); return null; }
    log(s.vehicle, 'no response in 20 s, clicking Search again');
  }
}

async function verifyOtp(s, hint) {
  for (;;) {
    await enterOtp(s, hint);
    const tried = await s.page.locator(OTP).inputValue();
    await s.page.locator(VERIFY).click();
    const until = Date.now() + 20000;
    let rejected = '';
    while (Date.now() < until) {
      if (s.page.url().includes('eadalatdetails')) return;
      const m = await pageMessages(s.page);
      if (m.error) { rejected = m.error; break; }
      await sleep(200);
    }
    await say(s.vehicle, `OTP not accepted${rejected ? `: ${rejected}` : ''}. Send it again.`);
    if (!TELEGRAM) {
      // Wait for the person to change the OTP in the window before retrying.
      while ((await s.page.locator(OTP).inputValue()) === tried) await sleep(250);
    }
  }
}

async function saveScreenshot(s, label) {
  fs.mkdirSync(RECEIPTS, { recursive: true });
  const file = path.join(RECEIPTS, `${s.vehicle}-${label}-${Date.now()}.png`);
  await s.page.screenshot({ path: file, fullPage: true });
  log(s.vehicle, `screenshot saved: ${file}`);
  await tgFile('sendDocument', 'document', file, `${s.vehicle}: ${label}`);
  return file;
}

// The Print button opens the token in a new tab. Headless Chrome can save
// that tab as a PDF; in a visible window the person prints it themselves.
async function saveTokenPdf(s) {
  if (!TELEGRAM) {
    log(s.vehicle, 'click "Print" in its window to save the official token.');
    return;
  }
  const popup = s.context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
  await s.page.getByRole('button', { name: /^\s*(Re)?[Pp]rint\s*$/ }).first().click().catch(() => {});
  const tab = await popup;
  if (!tab) {
    await say(s.vehicle, 'could not capture the token PDF. Open the portal on your phone, log in with this vehicle and press Reprint.');
    return;
  }
  await tab.waitForLoadState('load').catch(() => {});
  await sleep(2000);
  const file = path.join(RECEIPTS, `${s.vehicle}-token.pdf`);
  await tab.pdf({ path: file, format: 'A4', printBackground: true });
  await tgFile('sendDocument', 'document', file, `${s.vehicle}: Lok Adalat token — print this and carry it`);
  log(s.vehicle, `token saved: ${file}`);
}

// Free places (counted per challan/notice) in the chosen court, per session.
function freePlaces(s) {
  const rooms = (s.availability || []).filter((r) => r.complexName === COURT);
  if (!rooms.length) return null;
  const sum = (k) => rooms.reduce((n, r) => n + (Number(r[k]) || 0), 0);
  return { '0': sum('fnAvailable'), '1': sum('anAvailable') };
}

async function book(s) {
  const page = s.page;
  // Either the booking form loads, or the portal says this vehicle is
  // already booked and offers a reprint.
  const already = page.getByText('Your application has already been submitted');
  await Promise.race([
    page.locator('select#sel').waitFor({ timeout: 60000 }),
    already.waitFor({ timeout: 60000 }),
  ]).catch(() => {});
  if (await already.isVisible().catch(() => false)) {
    await say(s.vehicle, 'this vehicle was already booked earlier.');
    await saveScreenshot(s, 'already-booked');
    await saveTokenPdf(s);
    return 'already booked';
  }

  // The portal ticks every challan and notice of the vehicle; all of them go
  // in this one booking. The list loads separately from the court form.
  const ticked = page.locator('table input[type="checkbox"]:checked');
  await ticked.first().waitFor({ state: 'attached', timeout: 15000 }).catch(() => {});
  const items = await ticked.count();
  if (items === 0) {
    await say(s.vehicle, 'no eligible challans/notices for this vehicle. Nothing to book.');
    return 'nothing to book';
  }

  // Court list loads a moment after the form; a court is only listed while it
  // still has places free.
  const court = page.locator(`select#sel option[value="${COURT}"]`);
  await court.waitFor({ state: 'attached', timeout: 20000 }).catch(() => {});
  if ((await court.count()) === 0) {
    await say(s.vehicle, `${COURT} has no places left. Book another court on the portal yourself.`);
    await saveScreenshot(s, 'court-full');
    return 'court full';
  }

  // Try Fore Noon first; skip a session the portal shows can't fit every
  // challan, since all of them are submitted together.
  const free = freePlaces(s);
  let order = AFTERNOON_FALLBACK ? ['0', '1'] : ['0'];
  if (free) {
    log(s.vehicle, `${items} challan(s)/notice(s). ${COURT} free: Fore Noon ${free['0']}, After Noon ${free['1']}`);
    const fits = order.filter((k) => free[k] >= items);
    if (fits.length) order = fits;
    else await say(s.vehicle, `${COURT} shows fewer free places than this vehicle's ${items} challans; trying anyway.`);
  }

  for (const session of order) {
    await page.locator('select#sel').selectOption(COURT);
    await page.locator('select#sel1').selectOption(session);
    await page.locator('#undertaking').check();
    log(s.vehicle, `submitting ${items} item(s): ${COURT}, ${SESSIONS[session]}`);
    await page.getByRole('button', { name: 'Submit', exact: true }).click();

    const print = page.getByRole('button', { name: /Print/ });
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      if (await print.isVisible().catch(() => false)) {
        const msg = (await page.locator('p.success').first().innerText().catch(() => '')).trim();
        await say(s.vehicle, `BOOKED — ${items} challan(s) at ${COURT}, ${SESSIONS[session]}. ${msg}`);
        await saveScreenshot(s, 'booked');
        await saveTokenPdf(s);
        return `booked ${SESSIONS[session]}`;
      }
      const m = (await page.locator('p.success').first().innerText().catch(() => '')).trim();
      if (m && (await page.locator('select#sel').isEnabled())) {
        await say(s.vehicle, `portal refused ${SESSIONS[session]}: ${m}`);
        break;
      }
      await sleep(300);
    }
  }
  await saveScreenshot(s, 'not-booked');
  return 'not booked';
}

// Presses Search (which sends the OTP) and verifies the OTP for one vehicle.
async function login(s) {
  const hint = await requestOtp(s);
  if (hint === null) return 'stopped';
  await verifyOtp(s, hint);
  log(s.vehicle, 'OTP verified, filling the booking form');
  return 'logged in';
}

async function guarded(s, step) {
  try {
    return await step(s);
  } catch (e) {
    await say(s.vehicle, `error: ${e.message}`);
    await saveScreenshot(s, 'error').catch(() => {});
    return 'error';
  }
}

// OTPs are requested one vehicle at a time, so only one OTP is ever pending
// and it's clear which SMS belongs to which vehicle. Each vehicle's booking
// runs while the next one logs in.
async function runAll(sessions) {
  const bookings = [];
  for (const s of sessions) {
    const state = await guarded(s, login);
    bookings.push(state === 'logged in' ? guarded(s, book) : state);
  }
  return Promise.all(bookings);
}

// ---- web endpoint (Render free tier) -----------------------------------------

// Render's free tier only runs web services, which must answer HTTP and are
// put to sleep after 15 minutes without incoming requests. This serves a
// status page, receives forwarded OTP SMS, and pings itself to stay awake.
function startWebServer() {
  if (!process.env.PORT) return;
  http
    .createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/sms') {
        if (!SMS_KEY || url.searchParams.get('key') !== SMS_KEY) {
          res.writeHead(403).end('forbidden');
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c) => {
          body += c;
          if (body.length > 20000) req.destroy();
        });
        req.on('end', async () => {
          const otpWanted = waiting.some((x) => x.kind === 'otp');
          const { ok, msg } = deliver(body, null, 'sms');
          log('', `SMS received: ${ok ? 'OTP used' : otpWanted ? 'could not match' : 'ignored, no OTP pending'}`);
          if (ok || otpWanted) await tgSend(msg);
          else await tgSend('Forwarded SMS received, so SMS forwarding works. No OTP is being waited for right now, so it was not used.');
          res.writeHead(200).end(ok ? 'ok' : 'not used');
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Lok Adalat booking bot is running.');
    })
    .listen(Number(process.env.PORT), () => console.log(`web endpoint on port ${process.env.PORT}`));

  const self = process.env.RENDER_EXTERNAL_URL;
  if (self) setInterval(() => fetch(self).catch(() => {}), 10 * 60000);
}

// ---- main --------------------------------------------------------------------

async function launch() {
  if (TELEGRAM) {
    // The Docker image ships Playwright's Chromium; on a Mac use installed Chrome.
    // --disable-dev-shm-usage: containers have a tiny /dev/shm, and the free
    // tier only has 512 MB of memory.
    const opts = { headless: true, args: ['--disable-dev-shm-usage'] };
    return chromium.launch(opts).catch(() => chromium.launch({ ...opts, channel: 'chrome' }));
  }
  try {
    return await chromium.launch({ channel: 'chrome', headless: false });
  } catch {
    return chromium.launch({ headless: false });
  }
}

const idle = () => new Promise(() => {});

if (!VEHICLES.length) {
  console.error('Set VEHICLES, e.g. VEHICLES=DL1AB1234,HR26XY5678 (in .env or the environment).');
  process.exit(1);
}

startWebServer();

if (TELEGRAM) {
  pollTelegram();
  if (!TG_CHAT) {
    console.log('TELEGRAM_CHAT_ID is not set. Message the bot; it will reply with your chat id. Set it and restart.');
    await idle();
  }
}

const status = await safeStatus();
await say('',
  `Lok Adalat booking bot started. Lok Adalat date ${status.laDate}; server time ${status.date} ${status.time}; ` +
    `used today ${status.count}/${DAILY_LIMIT} (${windowState(status)}). ` +
    `Vehicles: ${VEHICLES.join(', ')} → ${COURT}, Fore Noon${AFTERNOON_FALLBACK ? ' (After Noon fallback)' : ''}.`,
);

const browser = await launch();

if (DRY_RUN) {
  const sessions = await Promise.all(VEHICLES.map((v) => openWindow(browser, v)));
  for (const s of sessions) await saveScreenshot(s, 'dry-run');
  await say('', 'Dry run: the portal opened and both vehicle numbers were accepted. Nothing was submitted.');
  await browser.close();
  process.exit(0);
}

// Telegram mode keeps going day by day until a booking attempt is made;
// local mode makes one attempt.
for (let first = true; ; first = false) {
  if (TELEGRAM && !(first && START_NOW) && !(await waitForPrepareTime())) {
    await say('', 'This Lok Adalat is over; nothing left to book. You can stop the worker.');
    await idle();
  }

  const sessions = await Promise.all(VEHICLES.map((v) => openWindow(browser, v)));
  for (const s of sessions) log(s.vehicle, 'portal open, vehicle number filled');

  if (TELEGRAM) {
    await say('', `Booking opens at ${OPENS_AT}. Reply to each code picture now. At ${OPENS_AT} sharp I start, then ask for each vehicle's OTP one at a time.`);
    await Promise.all(sessions.map(enterCode)); // codes don't expire, so collect them early
  } else {
    console.log('\nType the verification code in EACH window now. At 10:00:00 the script clicks Search,');
    console.log("then type the OTP that arrives on each owner's phone into that window.\n");
  }

  let results;
  try {
    await waitForOpening();
    results = await runAll(sessions);
  } catch (e) {
    await say('', e.message);
    results = sessions.map(() => 'not attempted');
  }

  await say('', 'Summary:\n' + sessions.map((s, i) => `${s.vehicle}: ${results[i]}`).join('\n'));
  if (!TELEGRAM) {
    console.log('\nWindows stay open so you can print the tokens. Press Ctrl+C to close.');
    break;
  }
  await Promise.all(sessions.map((s) => s.context.close()));
  if (results.some((r) => r !== 'not attempted')) {
    await say('', 'Done. Stop or delete the Render worker now so it does not run again.');
    break;
  }
  await say('', `Nothing could be attempted today. I'll try again at ${PREPARE_AT} on the next booking day.`);
}
await idle();
