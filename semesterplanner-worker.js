// © 2026 Annalee Bowers. All rights reserved.
// This code is proprietary and confidential. Unauthorized copying,
// distribution, or use of this file, in whole or in part, is
// strictly prohibited without prior written permission.

// Cloudflare Worker: syllabus parsing (text + photo), accounts (email + username + PIN),
// cross-device sync, and push notifications.
//
// Setup (one-time, in the Cloudflare dashboard):
// 1. Workers & Pages -> your Worker -> Edit code -> paste this -> Deploy
// 2. Settings/Bindings -> Add binding -> Workers AI -> name it "AI" (already done if parsing already works)
// 3. Bindings -> Add binding -> D1 database -> Create a new database (name it e.g. "planner-db") -> bind it as "DB"
// 4. That's it, no schema setup needed -- the code below creates its own tables on first use.
// 5. Accounts use Firebase Authentication (Email/Password must be turned on in the Firebase console).

const PARSE_PROMPT_HEADER = (today) => `You are extracting dated items from a college syllabus for a student's calendar app.

Today's date is ${today}. Find every dated item: assignments, quizzes, exams, readings with due dates, and major projects/papers.

Return ONLY a JSON array, no other text, no markdown fences. Each item:
{
  "title": "short description, under 8 words",
  "date": "YYYY-MM-DD",
  "flagged": true or false -- true if EITHER: (a) it sounds like major long-term work (final papers, capstones, theses, multi-week projects), OR (b) the syllabus states it's worth a large share of the final grade (roughly 15% or more) -- even if the name sounds ordinary. False for quizzes, short readings, and low-weight regular assignments.
  "confidence": "high" or "low" (low if the date was ambiguous, relative like 'week 7', or you had to infer the year)
}

If a date is relative (e.g. "week 7") and you can't confidently resolve it, skip that item rather than guessing.
If no year is stated, assume the current academic year based on today's date.`;

function extractText(aiResponse) {
  let raw = null;
  if (aiResponse.choices && aiResponse.choices[0] && aiResponse.choices[0].message && typeof aiResponse.choices[0].message.content === 'string') {
    raw = aiResponse.choices[0].message.content;
  } else if (typeof aiResponse.response === 'string') {
    raw = aiResponse.response;
  } else if (aiResponse.response && typeof aiResponse.response === 'object' && typeof aiResponse.response.text === 'string') {
    raw = aiResponse.response.text;
  }
  if (!raw) raw = JSON.stringify(aiResponse);
  return raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/, '').trim();
}

function cleanItems(raw) {
  const items = JSON.parse(raw);
  if (!Array.isArray(items)) throw new Error('Expected an array from the model');
  return items
    .filter(it => it && typeof it.title === 'string' && typeof it.date === 'string')
    .filter(it => /^\d{4}-\d{2}-\d{2}$/.test(it.date))
    .map(it => ({
      title: it.title.slice(0, 80),
      date: it.date,
      flagged: !!it.flagged,
      confidence: it.confidence === 'low' ? 'low' : 'high',
    }))
    .slice(0, 40);
}

async function ensureTable(db) {
  await db.exec(`CREATE TABLE IF NOT EXISTS sync_data (pin TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS push_tokens (pin TEXT NOT NULL, token TEXT NOT NULL, updated_at TEXT NOT NULL, notify_hour_utc INTEGER, PRIMARY KEY (pin, token))`);
  try { await db.exec(`ALTER TABLE push_tokens ADD COLUMN notify_hour_utc INTEGER`); } catch (e) { /* column already exists -- fine */ }
  await db.exec(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, uid TEXT UNIQUE NOT NULL, email TEXT NOT NULL, created_at TEXT NOT NULL)`);
}

// ---------- Sending real push notifications via Firebase Cloud Messaging ----------
function base64url(bytes) {
  let str = typeof bytes === 'string' ? btoa(bytes) : btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleAccessToken(env) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claimSet = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;

  const pem = env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const pemBody = pem.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8', binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${base64url(signature)}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('OAuth token exchange failed: ' + JSON.stringify(data));
  return data.access_token;
}

async function sendPush(env, accessToken, token, title, body) {
  const resp = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { token, notification: { title, body } } })
  });
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`FCM ${resp.status}: ${JSON.stringify(data)}`);
  }
  return data;
}


// ---------- Accounts (Firebase Authentication, email + PIN) ----------
// The Firebase web API key is public by design (it's also in index.html).
const FIREBASE_WEB_API_KEY = 'AIzaSyAl7HAlgDsa4DVDpgD4yD7L-gJOhRxEDko';
const APP_ORIGIN = 'https://semester-planner.bonellm77.workers.dev/';
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;

function apiKey(env) { return env.FIREBASE_API_KEY || FIREBASE_WEB_API_KEY; }

async function identityCall(env, method, payload) {
  const resp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${apiKey(env)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Referer': APP_ORIGIN },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (!resp.ok) {
    const code = (data && data.error && data.error.message) || 'UNKNOWN';
    const err = new Error(code);
    err.code = code.split(' ')[0];
    throw err;
  }
  return data;
}

// Turns Firebase error codes into plain, friendly messages
function friendlyAuthError(code) {
  switch (code) {
    case 'EMAIL_EXISTS': return 'That email already has an account. Try signing in, or use "Forgot PIN?"';
    case 'INVALID_EMAIL': return 'That email address doesn\'t look right.';
    case 'WEAK_PASSWORD': return 'Your PIN needs at least 6 numbers.';
    case 'EMAIL_NOT_FOUND':
    case 'INVALID_PASSWORD':
    case 'INVALID_LOGIN_CREDENTIALS': return 'Username or PIN is incorrect.';
    case 'USER_DISABLED': return 'This account has been turned off.';
    case 'TOO_MANY_ATTEMPTS_TRY_LATER': return 'Too many tries. Please wait a few minutes and try again.';
    case 'OPERATION_NOT_ALLOWED': return 'Sign-ups are turned off right now.';
    default: return 'Something went wrong signing in. Please try again.';
  }
}

// Checks the sign-in token the app sends and returns the user's account id
async function verifyUser(env, idToken) {
  if (!idToken) return null;
  try {
    const data = await identityCall(env, 'lookup', { idToken });
    return (data.users && data.users[0] && data.users[0].localId) || null;
  } catch (e) {
    return null;
  }
}

// Each account's data is stored under "u:<account id>" (old PIN rows used the PIN itself)
const accountKey = (uid) => 'u:' + uid;

function sessionPayload(authData, username) {
  return {
    ok: true,
    username,
    uid: authData.localId,
    idToken: authData.idToken,
    refreshToken: authData.refreshToken,
    expiresIn: Number(authData.expiresIn) || 3600
  };
}

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== 'POST') {
      return new Response('Use POST', { status: 405, headers: corsHeaders });
    }

    const json = (obj, status) => new Response(JSON.stringify(obj), {
      status: status || 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'Expected JSON body' }, 400);
    }

    const action = body.action || 'parseText'; // default keeps older frontend versions working

    // ---------- Text-based syllabus parsing (PDF path) ----------
    if (action === 'parseText') {
      const syllabusText = (body.text || '').slice(0, 20000);
      if (!syllabusText.trim()) return json({ error: 'No text provided' }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const prompt = `${PARSE_PROMPT_HEADER(today)}\n\nSyllabus text:\n"""\n${syllabusText}\n"""`;
      try {
        const aiResponse = await env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 4096,
        });
        const raw = extractText(aiResponse);
        let items;
        try { items = cleanItems(raw); }
        catch (e) { return json({ error: 'Model returned unparseable output', raw }, 502); }
        return json({ items });
      } catch (err) {
        return json({ error: 'AI call failed: ' + err.message }, 500);
      }
    }

    // ---------- Photo-based syllabus parsing (image path) ----------
    if (action === 'parseImage') {
      const imageBase64 = body.image;
      if (!imageBase64) return json({ error: 'No image provided' }, 400);
      const today = new Date().toISOString().slice(0, 10);
      const prompt = `${PARSE_PROMPT_HEADER(today)}\n\nThe syllabus is provided as a photo. Read the text in the image carefully.`;
      try {
        const aiResponse = await env.AI.run('@cf/meta/llama-4-scout-17b-16e-instruct', {
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
            ]
          }],
          max_tokens: 4096,
        });
        const raw = extractText(aiResponse);
        let items;
        try { items = cleanItems(raw); }
        catch (e) { return json({ error: 'Model returned unparseable output', raw }, 502); }
        return json({ items });
      } catch (err) {
        return json({ error: 'AI call failed: ' + err.message }, 500);
      }
    }

    // Everything below needs the database
    if (!env.DB) return json({ error: 'Database not connected yet -- add a D1 binding named DB in the Worker settings' }, 500);
    await ensureTable(env.DB);

    // ---------- Accounts ----------
    if (action === 'checkUsername') {
      const username = String(body.username || '').trim().toLowerCase();
      if (!USERNAME_RE.test(username)) return json({ available: false, reason: 'Use 3-20 letters, numbers, _ or .' });
      const row = await env.DB.prepare(`SELECT 1 FROM users WHERE username = ?`).bind(username).first();
      return json({ available: !row });
    }

    if (action === 'register') {
      const email = String(body.email || '').trim().toLowerCase();
      const username = String(body.username || '').trim().toLowerCase();
      const pin = String(body.pin || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'That email address doesn\'t look right.' }, 400);
      if (!USERNAME_RE.test(username)) return json({ error: 'Usernames need 3-20 letters, numbers, _ or .' }, 400);
      if (!/^\d{6,12}$/.test(pin)) return json({ error: 'Your PIN needs to be 6 to 12 numbers.' }, 400);
      const taken = await env.DB.prepare(`SELECT 1 FROM users WHERE username = ?`).bind(username).first();
      if (taken) return json({ error: 'That username is taken. Try another one.' }, 409);

      let authData;
      try {
        authData = await identityCall(env, 'signUp', { email, password: pin, returnSecureToken: true });
      } catch (err) {
        return json({ error: friendlyAuthError(err.code) }, 400);
      }
      try {
        await env.DB.prepare(`INSERT INTO users (username, uid, email, created_at) VALUES (?, ?, ?, ?)`)
          .bind(username, authData.localId, email, new Date().toISOString()).run();
      } catch (err) {
        // Someone grabbed the username at the same moment -- undo the new account
        try { await identityCall(env, 'delete', { idToken: authData.idToken }); } catch (e) {}
        return json({ error: 'That username was just taken. Try another one.' }, 409);
      }
      return json(sessionPayload(authData, username));
    }

    if (action === 'login') {
      const who = String(body.login || '').trim().toLowerCase();
      const pin = String(body.pin || '');
      if (!who || !pin) return json({ error: 'Enter your username and PIN.' }, 400);
      const row = who.includes('@')
        ? await env.DB.prepare(`SELECT username, email FROM users WHERE email = ?`).bind(who).first()
        : await env.DB.prepare(`SELECT username, email FROM users WHERE username = ?`).bind(who).first();
      if (!row) return json({ error: 'Username or PIN is incorrect.' }, 401);
      try {
        const authData = await identityCall(env, 'signInWithPassword', { email: row.email, password: pin, returnSecureToken: true });
        return json(sessionPayload(authData, row.username));
      } catch (err) {
        return json({ error: friendlyAuthError(err.code) }, 401);
      }
    }

    if (action === 'resetPin') {
      const who = String(body.login || '').trim().toLowerCase();
      const generic = { ok: true, message: 'If that account exists, a reset email is on its way. Check your inbox and spam folder.' };
      if (!who) return json({ error: 'Enter your username or email.' }, 400);
      const row = who.includes('@')
        ? await env.DB.prepare(`SELECT email FROM users WHERE email = ?`).bind(who).first()
        : await env.DB.prepare(`SELECT email FROM users WHERE username = ?`).bind(who).first();
      if (row) {
        try { await identityCall(env, 'sendOobCode', { requestType: 'PASSWORD_RESET', email: row.email }); }
        catch (err) { console.error('Reset email failed: ' + err.message); }
      }
      return json(generic); // same answer either way, so nobody can fish for accounts
    }

    // ---------- Everything below needs a signed-in user ----------
    const uid = await verifyUser(env, body.idToken);
    if (!uid) return json({ error: 'Please sign in again.', signedOut: true }, 401);
    const key = accountKey(uid);

    if (action === 'syncSave') {
      try {
        const dataStr = JSON.stringify(body.data || {});
        if (dataStr.length > 900000) return json({ error: 'Your planner is too big to sync.' }, 413);
        const savedAt = new Date().toISOString();
        await env.DB.prepare(
          `INSERT INTO sync_data (pin, data, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(pin) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
        ).bind(key, dataStr, savedAt).run();
        return json({ ok: true, updatedAt: savedAt });
      } catch (err) {
        return json({ error: 'Sync save failed: ' + err.message }, 500);
      }
    }

    if (action === 'syncLoad') {
      try {
        const row = await env.DB.prepare(`SELECT data, updated_at FROM sync_data WHERE pin = ?`).bind(key).first();
        if (!row) return json({ data: null });
        return json({ data: JSON.parse(row.data), updatedAt: row.updated_at });
      } catch (err) {
        return json({ error: 'Sync load failed: ' + err.message }, 500);
      }
    }

    // One-time move of a planner saved under an old PIN into this account.
    // Only allowed while the account has no cloud planner yet; the old PIN copy is then removed.
    if (action === 'claimPin') {
      const pin = String(body.pin || '').trim();
      if (!pin || pin.startsWith('u:')) return json({ ok: true, moved: false });
      try {
        const mine = await env.DB.prepare(`SELECT 1 FROM sync_data WHERE pin = ?`).bind(key).first();
        if (mine) return json({ ok: true, moved: false });
        const old = await env.DB.prepare(`SELECT data, updated_at FROM sync_data WHERE pin = ?`).bind(pin).first();
        if (!old) return json({ ok: true, moved: false });
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO sync_data (pin, data, updated_at) VALUES (?, ?, ?)`).bind(key, old.data, old.updated_at),
          env.DB.prepare(`UPDATE OR IGNORE push_tokens SET pin = ? WHERE pin = ?`).bind(key, pin),
          env.DB.prepare(`DELETE FROM push_tokens WHERE pin = ?`).bind(pin),
          env.DB.prepare(`DELETE FROM sync_data WHERE pin = ?`).bind(pin)
        ]);
        return json({ ok: true, moved: true, data: JSON.parse(old.data), updatedAt: old.updated_at });
      } catch (err) {
        return json({ error: 'Moving your old planner failed: ' + err.message }, 500);
      }
    }

    // ---------- Push notification token registration ----------
    if (action === 'saveToken') {
      const token = (body.token || '').trim();
      const notifyHourUtc = Number.isInteger(body.notifyHourUtc) ? body.notifyHourUtc : 13;
      if (!token) return json({ error: 'No token provided' }, 400);
      try {
        // A device belongs to one account at a time
        await env.DB.prepare(`DELETE FROM push_tokens WHERE token = ? AND pin != ?`).bind(token, key).run();
        await env.DB.prepare(
          `INSERT INTO push_tokens (pin, token, updated_at, notify_hour_utc) VALUES (?, ?, ?, ?)
           ON CONFLICT(pin, token) DO UPDATE SET updated_at = excluded.updated_at, notify_hour_utc = excluded.notify_hour_utc`
        ).bind(key, token, new Date().toISOString(), notifyHourUtc).run();
        return json({ ok: true });
      } catch (err) {
        return json({ error: 'Token save failed: ' + err.message }, 500);
      }
    }

    if (action === 'removeToken') {
      const token = (body.token || '').trim();
      if (token) await env.DB.prepare(`DELETE FROM push_tokens WHERE pin = ? AND token = ?`).bind(key, token).run();
      return json({ ok: true });
    }

    return json({ error: 'Unknown action: ' + action }, 400);
  },

  // Runs automatically on the schedule set in Cloudflare (Worker -> Settings -> Triggers -> Cron Triggers)
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    await ensureTable(env.DB);

    let accessToken;
    try {
      accessToken = await getGoogleAccessToken(env);
    } catch (err) {
      console.error('Could not get Google access token: ' + err.message);
      return;
    }

    const rows = await env.DB.prepare(`SELECT pin, data FROM sync_data`).all();
    const currentUtcHour = new Date().getUTCHours();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().slice(0, 10);

    for (const row of rows.results) {
      let data;
      try { data = JSON.parse(row.data); } catch (e) { continue; }
      const events = data.events || [];
      const tokenRows = await env.DB.prepare(`SELECT token, notify_hour_utc FROM push_tokens WHERE pin = ?`).bind(row.pin).all();
      if (tokenRows.results.length === 0) continue;

      // Individual timed events: due today, matching this hour exactly
      const timedNow = events.filter(ev => ev.date === todayStr && Number.isInteger(ev.timeUtcHour) && ev.timeUtcHour === currentUtcHour);
      for (const ev of timedNow) {
        for (const t of tokenRows.results) {
          try {
            await sendPush(env, accessToken, t.token, ev.title, ev.course ? ev.course : 'Happening now');
          } catch (err) {
            console.error('Timed push failed for a token: ' + err.message);
          }
        }
      }

      // Bundled daily reminder: only for events without their own time, due in 1-2 days
      const dueSoon = events.filter(ev => {
        if (ev.time) return false;
        const d = new Date(ev.date + 'T00:00:00');
        const days = Math.round((d - today) / (1000 * 60 * 60 * 24));
        return days === 1 || days === 2;
      });
      if (dueSoon.length === 0) continue;

      const tokens = tokenRows.results
        .filter(r => (Number.isInteger(r.notify_hour_utc) ? r.notify_hour_utc : 13) === currentUtcHour)
        .map(r => r.token);
      if (tokens.length === 0) continue;

      const title = dueSoon.length === 1 ? 'Due soon: ' + dueSoon[0].title : `${dueSoon.length} things due soon`;
      const body = dueSoon.map(e => e.title).join(', ');

      for (const token of tokens) {
        try {
          await sendPush(env, accessToken, token, title, body);
        } catch (err) {
          console.error('Push failed for a token: ' + err.message);
        }
      }
    }
  }
};