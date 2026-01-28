/**
 * TransitLink USSD Handler (Node.js/Express)
 *
 * Responsibilities:
 * - Handle Africa's Talking USSD callbacks via POST /ussd
 * - Manage session state in Supabase (level, company, feature, data)
 * - Provide modular menu flows and proper CON/END responses
 *
 * Requirements:
 * - ENV: SUPABASE_URL, SUPABASE_KEY (service role), PORT
 */
import 'dotenv/config';
import dotenv from 'dotenv';
import fs from 'fs';
import { parse as dotenvParse } from 'dotenv';
import https from 'https';
dotenv.config();
try {
  const envPath = process.env.ENV_PATH || `${process.cwd()}/.env`;
  if (fs.existsSync(envPath)) {
    const parsed = dotenvParse(fs.readFileSync(envPath));
    for (const [k, v] of Object.entries(parsed)) {
      if (!Object.prototype.hasOwnProperty.call(process.env, k)) {
        process.env[k] = v;
      }
    }
  }
} catch {}
import express from 'express';
import { createClient } from '@supabase/supabase-js';

// Create Express app
const app = express();
app.use(express.urlencoded({ extended: false }));

const env = (name) => (process.env[name] || '').trim();
const SUPABASE_URL =
  env('SUPABASE_URL') ||
  env('NEXT_PUBLIC_SUPABASE_URL') ||
  '';
const SUPABASE_KEY =
  env('SUPABASE_SERVICE_ROLE_KEY') ||
  env('SUPABASE_SECRET_KEY') ||
  env('SUPABASE_KEY') ||
  ''; // do NOT use anon/publishable in production server
if (!SUPABASE_URL || !SUPABASE_KEY) {
  // Do not start without required env
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Repositories
 * Encapsulate DB queries for sessions, companies, and routes
 */
const SessionsRepo = {
  async get(sessionId) {
    const { data, error } = await supabase
      .from('ussd_sessions')
      .select('*')
      .eq('session_id', sessionId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  },
  async upsert({ sessionId, phoneNumber, level, companyId, feature, data }) {
    const payload = {
      session_id: sessionId,
      phone_number: phoneNumber,
      level,
      company_id: companyId,
      feature,
      data: JSON.stringify(data || {}),
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from('ussd_sessions')
      .upsert(payload, { onConflict: 'session_id' });
    if (error) throw error;
  },
  async del(sessionId) {
    const { error } = await supabase
      .from('ussd_sessions')
      .delete()
      .eq('session_id', sessionId);
    if (error) throw error;
  },
};

const CompaniesRepo = {
  async all() {
    const { data, error } = await supabase
      .from('companies')
      .select('id,name,contact_number')
      .order('id', { ascending: true });
    if (error) throw error;
    return data || [];
  },
  async find(id) {
    const { data, error } = await supabase
      .from('companies')
      .select('id,name,contact_number')
      .eq('id', id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  },
};

const RoutesRepo = {
  async byCompany(companyId) {
    const { data, error } = await supabase
      .from('routes')
      .select('id,origin,destination,fare,departure_times,company_id')
      .eq('company_id', companyId)
      .order('id', { ascending: true });
    if (error) throw error;
    return data || [];
  },
};

const BookingsRepo = {
  async create({
    phone_number,
    company_id,
    route_id,
    origin,
    destination,
    seats,
    seat_pref,
    total,
    ref,
  }) {
    const payload = {
      phone_number,
      company_id,
      route_id,
      origin,
      destination,
      seats,
      seat_pref,
      total,
      ref,
      created_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('bookings').insert(payload);
    if (error) throw error;
  },
  async listByPhone(phone_number, limit = 5) {
    const { data, error } = await supabase
      .from('bookings')
      .select('origin,destination,ref,created_at')
      .eq('phone_number', phone_number)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  },
};
async function getSessionData(sessionId) {
  const sessionRecord = await SessionsRepo.get(sessionId);
  if (sessionRecord && sessionRecord.data) {
    try {
      return JSON.parse(sessionRecord.data);
    } catch {
      return {};
    }
  }
  return {};
}
/**
 * Helpers: USSD text normalization and menu rendering
 */
function normalizeSelections(text) {
  if (!text) return [];
  const parts = text.split('*').filter(Boolean);
  const stack = [];
  for (const p of parts) {
    if (p === '0') {
      if (stack.length) stack.pop();
      continue;
    }
    stack.push(p);
  }
  return stack;
}

function renderMainMenu(companies) {
  let out = 'Welcome to TransitLink\n';
  let i = 1;
  for (const c of companies) {
    out += `${i}. ${c.name}\n`;
    i++;
  }
  return out.trimEnd();
}

function renderCompanyMenu(company) {
  return [
    `${company.name}`,
    '1. Check Routes & Fares',
    '2. Book a Bus',
    '3. My Bookings',
    '4. Report a Case',
    '5. Lost & Found',
    '6. Give Feedback',
    '0. Back to Main Menu',
  ].join('\n');
}

function renderRoutesAndFares(routes) {
  if (!routes || routes.length === 0) {
    return 'No routes available at this time.';
  }
  return routes
    .map((r) => `${r.origin}-${r.destination} (${r.fare} KES)`)
    .join('\n');
}

const AT_USERNAME = env('AT_USERNAME') || '';
const AT_API_KEY = env('AT_API_KEY') || '';
const AT_SENDER_ID = env('AT_SENDER_ID') || '';
function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => {
          chunks += d;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(chunks || '{}');
            resolve({ status: res.statusCode, body: parsed });
          } catch {
            resolve({ status: res.statusCode, body: chunks });
          }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
function toArrayPhones(to) {
  return Array.isArray(to) ? to : [to];
}
async function sendSMS(to, message, opts = {}) {
  if (!AT_USERNAME || !AT_API_KEY) return false;
  const payload = {
    username: AT_USERNAME,
    message,
    phoneNumbers: toArrayPhones(to),
  };
  const sender = (opts.senderId ?? AT_SENDER_ID ?? '').trim();
  if (sender) payload.senderId = sender;
  if (opts.maskedNumber) payload.maskedNumber = opts.maskedNumber;
  if (opts.telco) payload.telco = opts.telco;
  try {
    const { status } = await postJson(
      'https://api.africastalking.com/version1/messaging/bulk',
      { apiKey: AT_API_KEY },
      payload
    );
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
}
/**
 * Feature flows
 */
function handleBooking(selections, routes, sessionData) {
  const step = selections.length - 1; // starting at feature selection
  if (step === 1) {
    if (!routes || routes.length === 0) {
      return ['No routes available to book.', true];
    }
    let out = 'Select a route:\n';
    let i = 1;
    for (const r of routes) {
      out += `${i}. ${r.origin}-${r.destination} (${r.fare} KES)\n`;
      i++;
    }
    out += '0. Back';
    return [out.trimEnd(), false];
  }
  if (step === 2) {
    const choice = selections[2];
    const idx = parseInt(choice, 10);
    if (!(idx >= 1 && idx <= routes.length)) {
      return ['Invalid selection. Enter a valid route number.\n0. Back', false];
    }
    const selected = routes[idx - 1];
    sessionData.booking_route = selected;
    return ['Enter number of seats:\n0. Back', false];
  }
  if (step === 3) {
    const seats = parseInt(selections[3] || '0', 10);
    if (!Number.isFinite(seats) || seats <= 0) {
      return ['Invalid seats. Enter a positive number:\n0. Back', false];
    }
    sessionData.seats = seats;
    return [
      ['Seat preference:', '1. Window seats', '2. Aisle seats', '3. Front of bus', '4. Back of bus', '5. No preference', '0. Back'].join('\n'),
      false,
    ];
  }
  if (step === 4) {
    const prefIdx = parseInt(selections[4] || '5', 10);
    const prefs = ['Window seats', 'Aisle seats', 'Front of bus', 'Back of bus', 'No preference'];
    const seatPref = prefs[(prefIdx >= 1 && prefIdx <= 5) ? prefIdx - 1 : 4];
    sessionData.seat_pref = seatPref;
    const r = sessionData.booking_route;
    const seats = sessionData.seats || 1;
    const total = seats * parseInt(String(r.fare), 10);
    const ref = 'TL-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const smsMessage =
      `TransitLink: Booking confirmed!\n` +
      `${r.origin} -> ${r.destination}\n` +
      `Seats: ${seats}\n` +
      `Seat Pref: ${seatPref}\n` +
      `Total: ${total} KES\n` +
      `Ref: ${ref}`;
    const msg =
      `Booking confirmed!\n` +
      `${r.origin} -> ${r.destination}\n` +
      `Seats: ${seats}\n` +
      `Seat Pref: ${seatPref}\n` +
      `Total: ${total} KES\n` +
      `Ref: ${ref}\n` +
      `Check your SMS for details.`;
    sessionData.booking_ref = ref;
    sessionData.booking_total = total;
    return [msg, true, { sms: smsMessage }];
  }
}


function handleReportCase(selections, sessionData) {
  const step = selections.length - 1;
  if (step === 1) {
    return ['Describe the case:\n0. Back', false];
  }
  if (step === 2) {
    sessionData.report = selections[2] || '';
    const ref = 'TL-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const smsMessage =
      `TransitLink: Report received.\n` +
      `Ref: ${ref}\n` +
      `We will investigate and respond within 24 hours.`;
    return [`Thanks! Report received.\nRef: ${ref}\nCheck your SMS for confirmation.`, true, { sms: smsMessage }];
  }
  return ['Unexpected step. Ending session.', true];
}

function handleLostFound(selections, sessionData) {
  const step = selections.length - 1;
  if (step === 1) {
    return ['Describe the item:\n0. Back', false];
  }
  if (step === 2) {
    sessionData.lost_item = selections[2] || '';
    const ref = 'TL-LOST-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const smsMessage =
      `TransitLink: Lost item reported.\n` +
      `Item: ${selections[2]}\n` +
      `Ref: ${ref}\n` +
      `We will contact you if found.`;
    return ['Thanks! We will contact you if found.\nCheck your SMS for reference.', true, { sms: smsMessage }];
  }
  return ['Unexpected step. Ending session.', true];
}

function handleFeedback(selections, sessionData) {
  const step = selections.length - 1;
  if (step === 1) {
    return ['Rate 1-5:\n0. Back', false];
  }
  if (step === 2) {
    const rating = parseInt(selections[2] || '0', 10);
    if (!(rating >= 1 && rating <= 5)) {
      return ['Invalid rating. Enter 1-5:\n0. Back', false];
    }
    sessionData.rating = rating;
    return ['Enter feedback comment:\n0. Back', false];
  }
  if (step === 3) {
    sessionData.comment = selections[3] || '';
    const smsMessage =
      `TransitLink: Thank you for your feedback!\n` +
      `Rating: ${sessionData.rating}/5\n` +
      `Your input helps us improve service.`;
    return ['Thanks for your feedback!\nSMS confirmation sent.', true, { sms: smsMessage }];
  }
  return ['Unexpected step. Ending session.', true];
}

/**
 * Controller
 */
async function handleUssd(req, res) {
  res.type('text/plain');
  const sessionId = req.body.sessionId || '';
  const phoneNumber = req.body.phoneNumber || '';
  const text = req.body.text || '';

  const selections = normalizeSelections(text);
  const companies = await CompaniesRepo.all();
  const level = selections.length;

  // Level 0: Main menu
  if (level === 0) {
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: 0,
      companyId: null,
      feature: null,
      data: {},
    });
    return res.send(`CON ${renderMainMenu(companies)}`);
  }

  // Level 1: Company selected
  const companyIdx = parseInt(selections[0], 10);
  if (!(companyIdx >= 1 && companyIdx <= companies.length)) {
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: 0,
      companyId: null,
      feature: null,
      data: {},
    });
    return res.send(`CON Invalid selection. Try again.\n${renderMainMenu(companies)}`);
  }
  const company = companies[companyIdx - 1];
  const companyId = parseInt(String(company.id), 10);

  if (level === 1) {
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: 1,
      companyId,
      feature: null,
      data: {},
    });
    return res.send(`CON ${renderCompanyMenu(company)}`);
  }

  // Level 2+: Feature selected
  const featureIdx = parseInt(selections[1] || '0', 10);
  const featureMap = {
    1: 'routes',
    2: 'booking',
    3: 'my_bookings',
    4: 'report',
    5: 'lost_found',
    6: 'feedback',
  };
  const feature = featureMap[featureIdx] || null;
  if (!feature) {
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: 1,
      companyId,
      feature: null,
      data: {},
    });
    return res.send(`CON Invalid selection. Try again.\n${renderCompanyMenu(company)}`);
  }

  if (feature === 'routes') {
    const routes = await RoutesRepo.byCompany(companyId);
    const resp = renderRoutesAndFares(routes);
    const data = {};
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: 2,
      companyId,
      feature,
      data,
    });
    await SessionsRepo.del(sessionId);
    return res.send(`END ${resp}`);
  }

  if (feature === 'my_bookings') {
    const items = await BookingsRepo.listByPhone(phoneNumber);
    let out = '';
    if (!items || items.length === 0) {
      out = 'No bookings found.';
    } else {
      let i = 1;
      for (const b of items) {
        const dt = new Date(b.created_at);
        const ts = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
        out += `${i}. ${b.origin}-${b.destination} (${ts}) - Ref: ${b.ref}\n`;
        i++;
      }
      out = out.trimEnd();
    }
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: 2,
      companyId,
      feature,
      data: {},
    });
    await SessionsRepo.del(sessionId);
    return res.send(`END ${out}`);
  }
  if (feature === 'booking') {
    const routes = await RoutesRepo.byCompany(companyId);
    const data = await getSessionData(sessionId);
    const [resp, end, extra] = handleBooking(selections, routes, data);
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: end ? 5 : level,
      companyId,
      feature,
      data,
    });
    if (end) {
      const r = data.booking_route;
      const seats = data.seats || 1;
      const seat_pref = data.seat_pref || 'No preference';
      const total = data.booking_total || (r ? seats * parseInt(String(r.fare), 10) : null);
      const ref = data.booking_ref || null;
      if (r && ref && total != null) {
        try {
          await BookingsRepo.create({
            phone_number: phoneNumber,
            company_id: companyId,
            route_id: r.id,
            origin: r.origin,
            destination: r.destination,
            seats,
            seat_pref,
            total,
            ref,
          });
        } catch {}
      }
      if (extra && extra.sms) {
        sendSMS(phoneNumber, extra.sms).catch(() => {});
      }
      await SessionsRepo.del(sessionId);
      return res.send(`END ${resp}`);
    }
    return res.send(`CON ${resp}`);
  }

  if (feature === 'report') {
    const data = await getSessionData(sessionId);
    const [resp, end, extra] = handleReportCase(selections, data);
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: end ? 3 : level,
      companyId,
      feature,
      data,
    });
    if (end) {
      if (extra && extra.sms) {
        sendSMS(phoneNumber, extra.sms).catch(() => {});
      }
      await SessionsRepo.del(sessionId);
      return res.send(`END ${resp}`);
    }
    return res.send(`CON ${resp}`);
  }

  if (feature === 'lost_found') {
    const data = await getSessionData(sessionId);
    const [resp, end, extra] = handleLostFound(selections, data);
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: end ? 3 : level,
      companyId,
      feature,
      data,
    });
    if (end) {
      if (extra && extra.sms) {
        sendSMS(phoneNumber, extra.sms).catch(() => {});
      }
      await SessionsRepo.del(sessionId);
      return res.send(`END ${resp}`);
    }
    return res.send(`CON ${resp}`);
  }

  if (feature === 'feedback') {
    const data = await getSessionData(sessionId);
    const [resp, end, extra] = handleFeedback(selections, data);
    await SessionsRepo.upsert({
      sessionId,
      phoneNumber,
      level: end ? 4 : level,
      companyId,
      feature,
      data,
    });
    if (end) {
      if (extra && extra.sms) {
        sendSMS(phoneNumber, extra.sms).catch(() => {});
      }
      await SessionsRepo.del(sessionId);
      return res.send(`END ${resp}`);
    }
    return res.send(`CON ${resp}`);
  }

  await SessionsRepo.upsert({
    sessionId,
    phoneNumber,
    level,
    companyId,
    feature,
    data: {},
  });
  return res.send('END Unexpected selection. Please try again later.');
}

/**
 * Route registration
 */
app.post('/ussd', handleUssd);

/**
 * Start server
 */
const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`TransitLink USSD server listening on port ${PORT}`);
});
