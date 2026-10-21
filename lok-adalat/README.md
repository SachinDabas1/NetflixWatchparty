# Lok Adalat auto-booking

Books a Delhi Digital Traffic Lok Adalat appointment (traffic.delhipolice.gov.in/lokadalat)
at **Rohini Courts, Fore Noon** as soon as the daily window opens, for every vehicle in `VEHICLES`.

How the portal works (read from its code, 21 Oct 2026):
- Lok Adalat sitting: **25 Oct 2026**. Bookings run 19–24 Oct, opening **10:00 AM** server time each day,
  until 50,000 notices/challans are taken for the day.
- One login per vehicle (code + OTP to the RC's registered mobile). After login the portal ticks **all**
  of that vehicle's challans/notices and books them together in one submission.
- You choose a court complex and Fore Noon / After Noon; the court room is assigned by the portal.
  Free places are counted per challan, so the script checks Rohini can fit all of a vehicle's challans
  before choosing a session.

Settings are environment variables (locally in `.env`, which is git-ignored because this repo is public):

| Variable | Example | |
|---|---|---|
| `VEHICLES` | `DL1AB1234,HR26XY5678` | required |
| `COURT` | `Rohini Courts` | default |
| `AFTERNOON_FALLBACK` | `1` | take After Noon if Fore Noon can't fit |
| `TELEGRAM_BOT_TOKEN` | from @BotFather | turns on Telegram mode |
| `TELEGRAM_CHAT_ID` | your chat id | only this chat can answer the bot |
| `PREPARE_AT` | `09:45:00` | Telegram mode: when to send the code pictures |

## Option A — on your Mac (around 9:50 AM)

```bash
npm install
npm run book
```
Type the code in each Chrome window, wait for 10:00, type each OTP in its window, then click **Print**.

## Option B — on Render (free tier), answering through Telegram

1. In Telegram, message **@BotFather** → `/newbot` → copy the token.
2. Render → **New → Web Service** → this repo and branch, root directory `lok-adalat`, runtime **Docker**,
   region **Singapore**, instance type **Free**, health check path `/`.
   Or use **New → Blueprint** with `lok-adalat/render.yaml`.
3. Env vars: `TELEGRAM_BOT_TOKEN`, `VEHICLES`, and `SMS_WEBHOOK_KEY` (any long random text).
   Deploy, then send any message to your bot. It replies with your chat id. Set `TELEGRAM_CHAT_ID`
   to it and redeploy.
4. The bot messages you "booking bot started" with the portal status. If it says it **can't reach the
   portal**, the site is blocking servers outside India. Use Option A instead.
5. At 9:45 AM on a booking day the bot sends one code picture per vehicle. Reply to each picture with
   its 6 characters (or send `DL1AB1234 abc123`).
6. At 10:00:00 it presses Search; an OTP reaches each owner's phone. Reply to the bot's OTP message
   with the 4 digits (or send `HR26XY5678 1234`), or let the SMS forwarder below do it.
7. It books, then sends you the screenshot and the token PDF. **Delete the service afterwards.**

Free-tier notes: free services sleep after 15 minutes without incoming requests, so the bot requests
its own URL every 10 minutes. As a backup, add a free uptime monitor (e.g. UptimeRobot) that requests
`https://<your-service>.onrender.com/` every 5 minutes. Free instances have 512 MB of memory;
the bot uses about 330 MB with both vehicles open.

### Forwarding the OTP SMS automatically

Install an SMS-to-webhook forwarding app on each owner's phone. On Android, apps such as "SMS to URL Forwarder"
work. On iPhone, use a Shortcuts automation: Message contains "OTP" → Get contents of URL (POST).
Point it at:

```
https://<your-service>.onrender.com/sms?key=<SMS_WEBHOOK_KEY>
```

Filter it to the traffic police sender so other SMS aren't sent. Any body format works: the bot finds the
4-digit OTP in the text. If the SMS names the vehicle, it goes to that vehicle. If both OTPs are pending,
the SMS doesn't name a vehicle and both arrive on one phone, the bot asks you in Telegram instead of guessing.
If the vehicles are on different phones, make each phone's forwarder start the message with its vehicle
number (e.g. a body template of `DL1AB1234 %text%`).

Send `/status` to the bot at any time.
`npm run dry-run` opens the portal and checks both vehicle numbers without booking anything.
